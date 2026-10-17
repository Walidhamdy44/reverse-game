import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';
import {
  AudioModule,
  AudioQuality,
  IOSOutputFormat,
  setAudioModeAsync,
  useAudioPlayer,
  useAudioRecorder,
  type AudioStatus,
  type RecordingOptions,
  type RecordingStatus,
} from 'expo-audio';
import { Directory, File, Paths } from 'expo-file-system';
import { getPcmWaveform, reversePcmWav } from './wav';

export type GameClip = {
  uri: string;
  backwardsUri: string;
  durationMs: number;
  waveform: number[];
  backwardsWaveform: number[];
};

export type ClipSlot = 'original' | 'imitation';

type PlaybackSelection = { slot: ClipSlot; backwards: boolean };
type AudioIssue = 'permission' | 'record' | 'playback' | 'unsupported' | null;

type RecordingSession = {
  id: number;
  slot: ClipSlot;
  slotVersion: number;
  startedAt: number;
  started: boolean;
  cancelled: boolean;
  finishing: boolean;
  committed: boolean;
  errorMessage: string | null;
  outputUris: string[];
  finalization: Promise<void> | null;
  meterTimer: ReturnType<typeof setInterval> | null;
  fallbackStopTimer: ReturnType<typeof setTimeout> | null;
};

type PlaybackRequest = PlaybackSelection & { token: number };
type FinalizeRecording = (
  session: RecordingSession,
  uriOverride?: string | null,
  shouldStop?: boolean
) => Promise<void>;

const MAX_RECORDING_MS = 5000;
const MAX_RECORDING_SECONDS = MAX_RECORDING_MS / 1000;
const MAX_LIVE_BARS = 48;
const ROUND_CACHE_FOLDER = 'reverse-words-round';

const WAV_RECORDING_OPTIONS: RecordingOptions = {
  directory: 'cache',
  extension: '.wav',
  sampleRate: 44100,
  numberOfChannels: 1,
  bitRate: 44100 * 16,
  isMeteringEnabled: true,
  android: {
    extension: '.m4a',
    outputFormat: 'mpeg4',
    audioEncoder: 'aac',
  },
  ios: {
    extension: '.wav',
    sampleRate: 44100,
    outputFormat: IOSOutputFormat.LINEARPCM,
    audioQuality: AudioQuality.MAX,
    linearPCMBitDepth: 16,
    linearPCMIsBigEndian: false,
    linearPCMIsFloat: false,
  },
  web: {
    mimeType: 'audio/webm',
    bitsPerSecond: 128000,
  },
};

const PLAYBACK_AUDIO_MODE = {
  allowsRecording: false,
  allowsBackgroundRecording: false,
  playsInSilentMode: true,
  shouldPlayInBackground: false,
  shouldRouteThroughEarpiece: false,
  interruptionMode: 'doNotMix' as const,
};

const RECORDING_AUDIO_MODE = {
  allowsRecording: true,
  allowsBackgroundRecording: false,
  playsInSilentMode: true,
  shouldPlayInBackground: false,
  shouldRouteThroughEarpiece: false,
  interruptionMode: 'doNotMix' as const,
};

export function useGameAudio(): {
  clips: Partial<Record<ClipSlot, GameClip>>;
  activeSlot: ClipSlot | null;
  isRecording: boolean;
  isProcessing: boolean;
  elapsedMs: number;
  liveWaveform: number[];
  playback: PlaybackSelection | null;
  progress: number;
  issue: AudioIssue;
  canAskAgain: boolean;
  startRecording(slot: ClipSlot): Promise<void>;
  stopRecording(): Promise<void>;
  playClip(slot: ClipSlot, backwards: boolean): Promise<void>;
  stopPlayback(): void;
  resetRound(): Promise<void>;
  clearClip(slot: ClipSlot): Promise<void>;
} {
  const [clips, setClips] = useState<Partial<Record<ClipSlot, GameClip>>>({});
  const [activeSlot, setActiveSlot] = useState<ClipSlot | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [liveWaveform, setLiveWaveform] = useState<number[]>([]);
  const [playback, setPlayback] = useState<PlaybackSelection | null>(null);
  const [issue, setIssue] = useState<AudioIssue>(null);
  const [canAskAgain, setCanAskAgain] = useState(true);

  const mountedRef = useRef(false);
  const clipsRef = useRef<Partial<Record<ClipSlot, GameClip>>>({});
  const recordingSessionRef = useRef<RecordingSession | null>(null);
  const finalizeRecordingRef = useRef<FinalizeRecording>(async () => {});
  const stopRecordingRef = useRef<() => Promise<void>>(async () => {});
  const stopPlaybackRef = useRef<() => void>(() => {});
  const startLockRef = useRef(false);
  const processingRef = useRef(false);
  const slotVersionsRef = useRef<Record<ClipSlot, number>>({ original: 0, imitation: 0 });
  const nextSessionIdRef = useRef(0);
  const playbackTokenRef = useRef(0);
  const playbackRequestRef = useRef<PlaybackRequest | null>(null);
  const roundDirectoryRef = useRef<Directory | null>(null);
  const startupCleanupRef = useRef<Promise<Directory> | null>(null);

  const recorderStatusListener = useCallback((status: RecordingStatus) => {
    const session = recordingSessionRef.current;
    if (!session) return;

    if (status.hasError) {
      session.errorMessage = status.error ?? 'The recording could not be completed.';
      void finalizeRecordingRef.current(session, status.url, true);
      return;
    }

    // `record({ forDuration })` ends natively; finalize from its finished event.
    if (status.isFinished) {
      void finalizeRecordingRef.current(session, status.url, false);
    }
  }, []);

  const recorder = useAudioRecorder(WAV_RECORDING_OPTIONS, recorderStatusListener);
  const player = useAudioPlayer(null, { updateInterval: 100 });

  const updateClips = useCallback((next: Partial<Record<ClipSlot, GameClip>>) => {
    clipsRef.current = next;
    if (mountedRef.current) setClips(next);
  }, []);

  const updatePlayback = useCallback((next: PlaybackSelection | null) => {
    if (mountedRef.current) setPlayback(next);
  }, []);

  const getRoundDirectory = useCallback(async (): Promise<Directory> => {
    let directory = roundDirectoryRef.current;
    if (!directory) {
      directory = new Directory(Paths.cache, ROUND_CACHE_FOLDER);
      roundDirectoryRef.current = directory;
    }

    if (!startupCleanupRef.current) {
      const initialCleanup = Promise.resolve().then(() => {
        // A dedicated cache folder lets a new app session discard stale clips.
        if (directory?.exists) directory.delete();
        directory?.create({ intermediates: true, idempotent: true });
        return directory as Directory;
      });
      startupCleanupRef.current = initialCleanup;
      void initialCleanup.catch(() => {
        if (startupCleanupRef.current === initialCleanup) startupCleanupRef.current = null;
      });
    }

    await startupCleanupRef.current;
    if (!directory.exists) directory.create({ intermediates: true, idempotent: true });
    return directory;
  }, []);

  const isCurrentSession = useCallback((session: RecordingSession): boolean => {
    return (
      mountedRef.current &&
      recordingSessionRef.current === session &&
      !session.cancelled &&
      slotVersionsRef.current[session.slot] === session.slotVersion
    );
  }, []);

  const finalizeRecording = useCallback<FinalizeRecording>(
    (session, uriOverride, shouldStop = true) => {
      // Set the lock before any await: a manual stop and the native finished
      // event can arrive together for the same recorder session.
      if (session.finalization) return session.finalization;
      session.finishing = true;

      if (session.meterTimer) clearInterval(session.meterTimer);
      if (session.fallbackStopTimer) clearTimeout(session.fallbackStopTimer);
      session.meterTimer = null;
      session.fallbackStopTimer = null;

      if (recordingSessionRef.current === session && mountedRef.current) {
        setIsRecording(false);
        setIsProcessing(true);
        processingRef.current = true;
      }

      let resolveFinalization: () => void = () => {};
      const finalization = new Promise<void>((resolve) => {
        resolveFinalization = resolve;
      });
      session.finalization = finalization;

      void (async () => {
        try {
          if (shouldStop && recorder.isRecording) {
            await recorder.stop();
          }

          // Return the audio session to speaker playback as soon as capture ends.
          try {
            await setAudioModeAsync(PLAYBACK_AUDIO_MODE);
          } catch {
            // Saving the just-recorded clip can still succeed if mode reset fails.
          }

          if (!session.started || !isCurrentSession(session)) return;
          if (session.errorMessage) throw new Error(session.errorMessage);

          const sourceUri = uriOverride ?? recorder.uri;
          if (!sourceUri) throw new Error('The recording file was not created.');

          const sourceFile = new File(sourceUri);
          const originalBytes = await sourceFile.bytes();
          if (!isCurrentSession(session)) return;

          const directory = await getRoundDirectory();
          if (!isCurrentSession(session)) return;

          const originalFile = new File(directory, `${session.slot}-${session.id}.wav`);
          writeBytes(originalFile, originalBytes);
          session.outputUris.push(originalFile.uri);

          const originalWaveform = getPcmWaveform(originalBytes);
          const backwardsBytes = reversePcmWav(originalBytes);
          if (!isCurrentSession(session)) return;

          const backwardsFile = new File(directory, `${session.slot}-${session.id}-backwards.wav`);
          writeBytes(backwardsFile, backwardsBytes);
          session.outputUris.push(backwardsFile.uri);

          const backwardsWaveform = getPcmWaveform(backwardsBytes);
          const status = recorder.getStatus();
          const reportedDuration =
            status.durationMillis || Math.round(Math.max(0, recorder.currentTime) * 1000);
          const wallDuration = Date.now() - session.startedAt;
          const durationMs = clamp(Math.round(reportedDuration || wallDuration), 0, MAX_RECORDING_MS);

          if (!isCurrentSession(session)) return;

          const clip: GameClip = {
            uri: originalFile.uri,
            backwardsUri: backwardsFile.uri,
            durationMs,
            waveform: originalWaveform,
            backwardsWaveform,
          };
          const previousClip = clipsRef.current[session.slot];
          updateClips({ ...clipsRef.current, [session.slot]: clip });
          if (previousClip) deleteUrisQuietly([previousClip.uri, previousClip.backwardsUri]);
          session.committed = true;
        } catch {
          if (isCurrentSession(session)) setIssue('record');
        } finally {
          if (!session.committed) deleteUrisQuietly(session.outputUris);

          if (recordingSessionRef.current === session) {
            recordingSessionRef.current = null;
            if (mountedRef.current) {
              setActiveSlot(null);
              setIsRecording(false);
              setIsProcessing(false);
              processingRef.current = false;
            }
          }

          resolveFinalization();
        }
      })();

      return finalization;
    },
    [getRoundDirectory, isCurrentSession, recorder, updateClips]
  );
  useEffect(() => {
    finalizeRecordingRef.current = finalizeRecording;
  }, [finalizeRecording]);

  const stopPlayback = useCallback(() => {
    playbackTokenRef.current += 1;
    playbackRequestRef.current = null;
    player.pause();
    updatePlayback(null);
    void setAudioModeAsync(PLAYBACK_AUDIO_MODE).catch(() => {});
  }, [player, updatePlayback]);
  useEffect(() => {
    stopPlaybackRef.current = stopPlayback;
  }, [stopPlayback]);

  useEffect(() => {
    const subscription = player.addListener('playbackStatusUpdate', (status: AudioStatus) => {
      if (!playbackRequestRef.current) return;

      if (status.error) {
        playbackRequestRef.current = null;
        player.pause();
        updatePlayback(null);
        setIssue('playback');
        void setAudioModeAsync(PLAYBACK_AUDIO_MODE).catch(() => {});
      } else if (status.didJustFinish) {
        playbackRequestRef.current = null;
        updatePlayback(null);
        void setAudioModeAsync(PLAYBACK_AUDIO_MODE).catch(() => {});
      }
    });

    return () => subscription.remove();
  }, [player, updatePlayback]);

  const stopRecording = useCallback(async (): Promise<void> => {
    const session = recordingSessionRef.current;
    if (!session) return;
    await finalizeRecordingRef.current(session, null, true);
  }, []);
  useEffect(() => {
    stopRecordingRef.current = stopRecording;
  }, [stopRecording]);

  const startRecording = useCallback(
    async (slot: ClipSlot): Promise<void> => {
      if (Platform.OS !== 'ios') {
        setIssue('unsupported');
        return;
      }
      if (startLockRef.current || recordingSessionRef.current || processingRef.current) return;

      startLockRef.current = true;
      const slotVersion = ++slotVersionsRef.current[slot];
      setIssue(null);
      setCanAskAgain(true);
      setElapsedMs(0);
      setLiveWaveform([]);
      stopPlaybackRef.current();

      try {
        await getRoundDirectory();
        if (slotVersionsRef.current[slot] !== slotVersion) return;

        // Ask only in direct response to the user's Record action.
        const permission = await AudioModule.requestRecordingPermissionsAsync();
        if (mountedRef.current) setCanAskAgain(permission.canAskAgain);
        if (!permission.granted) {
          if (mountedRef.current && slotVersionsRef.current[slot] === slotVersion) {
            setIssue('permission');
          }
          return;
        }
        if (slotVersionsRef.current[slot] !== slotVersion) return;

        await setAudioModeAsync(RECORDING_AUDIO_MODE);
        if (slotVersionsRef.current[slot] !== slotVersion) {
          await setAudioModeAsync(PLAYBACK_AUDIO_MODE).catch(() => {});
          return;
        }

        await recorder.prepareToRecordAsync();
        if (slotVersionsRef.current[slot] !== slotVersion) {
          await setAudioModeAsync(PLAYBACK_AUDIO_MODE).catch(() => {});
          return;
        }

        const session: RecordingSession = {
          id: ++nextSessionIdRef.current,
          slot,
          slotVersion,
          startedAt: Date.now(),
          started: true,
          cancelled: false,
          finishing: false,
          committed: false,
          errorMessage: null,
          outputUris: [],
          finalization: null,
          meterTimer: null,
          fallbackStopTimer: null,
        };
        recordingSessionRef.current = session;
        setActiveSlot(slot);
        setIsRecording(true);
        setIsProcessing(false);
        processingRef.current = false;
        recorder.record({ forDuration: MAX_RECORDING_SECONDS });

        session.meterTimer = setInterval(() => {
          if (recordingSessionRef.current !== session || session.finishing) return;

          const recorderState = recorder.getStatus();
          const elapsed = recorderState.durationMillis || Date.now() - session.startedAt;
          const nextElapsed = clamp(Math.round(elapsed), 0, MAX_RECORDING_MS);
          if (mountedRef.current) {
            setElapsedMs(nextElapsed);
            const level = meteringToLevel(recorderState.metering);
            setLiveWaveform((current) => [...current.slice(-(MAX_LIVE_BARS - 1)), level]);
          }

          // Some native interruptions may not emit the duration-finished event.
          if (!recorderState.isRecording && nextElapsed > 0) {
            void finalizeRecordingRef.current(session, recorder.uri, false);
          }
        }, 100);

        session.fallbackStopTimer = setTimeout(() => {
          void finalizeRecordingRef.current(session, recorder.uri, true);
        }, MAX_RECORDING_MS + 400);
      } catch {
        const session = recordingSessionRef.current;
        if (session?.slot === slot && session.slotVersion === slotVersion) {
          session.cancelled = true;
          if (recorder.isRecording) await recorder.stop().catch(() => {});
          recordingSessionRef.current = null;
          if (mountedRef.current) {
            setActiveSlot(null);
            setIsRecording(false);
            setIsProcessing(false);
            processingRef.current = false;
          }
        }
        if (mountedRef.current && slotVersionsRef.current[slot] === slotVersion) setIssue('record');
        await setAudioModeAsync(PLAYBACK_AUDIO_MODE).catch(() => {});
      } finally {
        startLockRef.current = false;
      }
    },
    [getRoundDirectory, recorder]
  );

  const playClip = useCallback(
    async (slot: ClipSlot, backwards: boolean): Promise<void> => {
      if (Platform.OS !== 'ios') {
        setIssue('unsupported');
        return;
      }
      if (recordingSessionRef.current || processingRef.current) return;

      const clip = clipsRef.current[slot];
      if (!clip) return;

      const token = ++playbackTokenRef.current;
      playbackRequestRef.current = null;
      player.pause();
      updatePlayback(null);
      setIssue(null);

      try {
        // iOS routes play-and-record audio to the receiver; disable capture first.
        await setAudioModeAsync(PLAYBACK_AUDIO_MODE);
        if (token !== playbackTokenRef.current || !mountedRef.current) return;

        player.replace(backwards ? clip.backwardsUri : clip.uri);
        playbackRequestRef.current = { slot, backwards, token };
        updatePlayback({ slot, backwards });
        player.play();
      } catch {
        playbackRequestRef.current = null;
        updatePlayback(null);
        if (mountedRef.current) setIssue('playback');
        await setAudioModeAsync(PLAYBACK_AUDIO_MODE).catch(() => {});
      }
    },
    [player, updatePlayback]
  );

  const clearClip = useCallback(
    async (slot: ClipSlot): Promise<void> => {
      slotVersionsRef.current[slot] += 1;
      const session = recordingSessionRef.current;
      if (session?.slot === slot) {
        session.cancelled = true;
        await finalizeRecordingRef.current(session, null, true);
      }

      if (playbackRequestRef.current?.slot === slot) stopPlaybackRef.current();

      const clip = clipsRef.current[slot];
      const next = { ...clipsRef.current };
      delete next[slot];
      updateClips(next);
      if (clip) deleteUrisQuietly([clip.uri, clip.backwardsUri]);

      if (mountedRef.current) {
        setIssue(null);
        if (!recordingSessionRef.current) {
          setActiveSlot(null);
          setIsRecording(false);
          setIsProcessing(false);
          processingRef.current = false;
        }
      }
    },
    [updateClips]
  );

  const resetRound = useCallback(async (): Promise<void> => {
    slotVersionsRef.current.original += 1;
    slotVersionsRef.current.imitation += 1;

    const session = recordingSessionRef.current;
    if (session) {
      session.cancelled = true;
      await finalizeRecordingRef.current(session, null, true);
    }

    stopPlaybackRef.current();
    const directory = await getRoundDirectory().catch(() => null);
    if (directory) {
      try {
        if (directory.exists) directory.delete();
        directory.create({ intermediates: true, idempotent: true });
      } catch {
        if (mountedRef.current) setIssue('record');
      }
    }

    clipsRef.current = {};
    if (mountedRef.current) {
      setClips({});
      setActiveSlot(null);
      setIsRecording(false);
      setIsProcessing(false);
      setElapsedMs(0);
      setLiveWaveform([]);
      setPlayback(null);
      setIssue(null);
      setCanAskAgain(true);
      processingRef.current = false;
    }
  }, [getRoundDirectory]);

  useEffect(() => {
    mountedRef.current = true;
    const slotVersions = slotVersionsRef.current;
    void getRoundDirectory().catch(() => {
      if (mountedRef.current) setIssue('record');
    });

    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') return;
      const session = recordingSessionRef.current;
      if (session) {
        session.cancelled = true;
        void finalizeRecordingRef.current(session, null, true);
        if (mountedRef.current) setIssue('record');
      }
      stopPlaybackRef.current();
    });

    return () => {
      mountedRef.current = false;
      slotVersions.original += 1;
      slotVersions.imitation += 1;
      const session = recordingSessionRef.current;
      if (session) {
        session.cancelled = true;
        if (session.meterTimer) clearInterval(session.meterTimer);
        if (session.fallbackStopTimer) clearTimeout(session.fallbackStopTimer);
        if (recorder.isRecording) void recorder.stop().catch(() => {});
      }
      player.pause();
      subscription.remove();
    };
  }, [getRoundDirectory, player, recorder]);

  const progress = clamp(elapsedMs / MAX_RECORDING_MS, 0, 1);

  return {
    clips,
    activeSlot,
    isRecording,
    isProcessing,
    elapsedMs,
    liveWaveform,
    playback,
    progress,
    issue,
    canAskAgain,
    startRecording,
    stopRecording,
    playClip,
    stopPlayback,
    resetRound,
    clearClip,
  };
}

function writeBytes(file: File, bytes: Uint8Array): void {
  if (file.exists) file.delete();
  file.create({ intermediates: true, overwrite: true });
  file.write(bytes);
}

function deleteUrisQuietly(uris: string[]): void {
  for (const uri of uris) {
    try {
      const file = new File(uri);
      if (file.exists) file.delete();
    } catch {
      // Stale cache cleanup is best-effort; the next startup removes the folder.
    }
  }
}

function meteringToLevel(metering: number | undefined): number {
  if (metering === undefined || !Number.isFinite(metering)) return 0.04;
  return clamp((metering + 60) / 60, 0.04, 1);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
