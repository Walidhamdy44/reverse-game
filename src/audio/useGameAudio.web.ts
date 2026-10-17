import { useCallback, useEffect, useRef, useState } from 'react';

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

type WebRecordingSession = {
  slot: ClipSlot;
  recorder: MediaRecorder;
  stream: MediaStream;
  chunks: Blob[];
  startedAt: number;
  stopPromise: Promise<void>;
  resolveStop: () => void;
  meter: AnalyserNode | null;
  audioContext: AudioContext | null;
  finishPromise: Promise<void> | null;
  cancelled: boolean;
  failed: boolean;
  finishRequested: boolean;
  maxTimer: ReturnType<typeof setTimeout> | null;
  meterTimer: ReturnType<typeof setInterval> | null;
};

const MAX_RECORDING_MS = 5000;
const MAX_LIVE_BARS = 48;
const WAVEFORM_BARS = 48;

/** Browser implementation selected automatically by Metro for Safari and web. */
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
  const clipsRef = useRef<Partial<Record<ClipSlot, GameClip>>>({});
  const [activeSlot, setActiveSlot] = useState<ClipSlot | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [liveWaveform, setLiveWaveform] = useState<number[]>([]);
  const [playback, setPlayback] = useState<PlaybackSelection | null>(null);
  const [issue, setIssue] = useState<AudioIssue>(null);
  const [canAskAgain] = useState(true);
  const recordingRef = useRef<WebRecordingSession | null>(null);
  const currentAudioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlsRef = useRef<Set<string>>(new Set());
  const mountedRef = useRef(false);
  const busyRef = useRef(false);

  const updateClips = useCallback((next: Partial<Record<ClipSlot, GameClip>>) => {
    clipsRef.current = next;
    if (mountedRef.current) setClips(next);
  }, []);

  const releaseSession = useCallback((session: WebRecordingSession) => {
    if (session.maxTimer) clearTimeout(session.maxTimer);
    if (session.meterTimer) clearInterval(session.meterTimer);
    session.maxTimer = null;
    session.meterTimer = null;
    session.stream.getTracks().forEach((track) => track.stop());
    if (session.audioContext && session.audioContext.state !== 'closed') {
      void session.audioContext.close().catch(() => undefined);
    }
  }, []);

  const finishRecording = useCallback(
    (session: WebRecordingSession): Promise<void> => {
      if (session.finishPromise) return session.finishPromise;
      session.finishRequested = true;
      if (session.maxTimer) clearTimeout(session.maxTimer);
      if (session.meterTimer) clearInterval(session.meterTimer);
      session.maxTimer = null;
      session.meterTimer = null;

      const isCurrent = recordingRef.current === session;
      if (isCurrent && mountedRef.current) {
        setIsRecording(false);
        if (!session.cancelled) setIsProcessing(true);
      }

      session.finishPromise = (async () => {
        try {
          if (session.recorder.state !== 'inactive') {
            session.recorder.stop();
          } else {
            session.resolveStop();
          }
          await session.stopPromise;
          releaseSession(session);

          if (session.cancelled || recordingRef.current !== session || !mountedRef.current) return;
          if (session.failed) throw new Error('The browser could not complete the recording.');
          if (session.chunks.length === 0) throw new Error('The browser did not return an audio recording.');

          const source = new Blob(session.chunks, { type: session.recorder.mimeType || session.chunks[0].type });
          const audioContext = new AudioContext();
          let decoded: AudioBuffer;
          try {
            decoded = await audioContext.decodeAudioData(await source.arrayBuffer());
          } finally {
            if (audioContext.state !== 'closed') await audioContext.close().catch(() => undefined);
          }

          const originalWav = encodePcmWav(decoded, false);
          const backwardsWav = encodePcmWav(decoded, true);
          const originalUri = URL.createObjectURL(new Blob([ownedArrayBuffer(originalWav)], { type: 'audio/wav' }));
          const backwardsUri = URL.createObjectURL(new Blob([ownedArrayBuffer(backwardsWav)], { type: 'audio/wav' }));
          objectUrlsRef.current.add(originalUri);
          objectUrlsRef.current.add(backwardsUri);
          const previousClip = clipsRef.current[session.slot];
          updateClips({
            ...clipsRef.current,
            [session.slot]: {
              uri: originalUri,
              backwardsUri,
              durationMs: Math.min(MAX_RECORDING_MS, Math.max(1, Math.round(decoded.duration * 1000))),
              waveform: waveformFromBuffer(decoded, false),
              backwardsWaveform: waveformFromBuffer(decoded, true),
            },
          });
          if (previousClip) revokeClip(previousClip, objectUrlsRef.current);
        } catch {
          if (!session.cancelled && recordingRef.current === session && mountedRef.current) setIssue('record');
        } finally {
          releaseSession(session);
          if (recordingRef.current === session) recordingRef.current = null;
          if (mountedRef.current) {
            setActiveSlot(null);
            setIsRecording(false);
            setIsProcessing(false);
            busyRef.current = false;
          }
        }
      })();

      return session.finishPromise;
    },
    [releaseSession, updateClips]
  );

  const stopPlayback = useCallback(() => {
    const audio = currentAudioRef.current;
    currentAudioRef.current = null;
    if (audio) {
      audio.onended = null;
      audio.onerror = null;
      audio.pause();
      audio.currentTime = 0;
    }
    if (mountedRef.current) setPlayback(null);
  }, []);

  const startRecording = useCallback(
    async (slot: ClipSlot): Promise<void> => {
      if (busyRef.current || recordingRef.current) return;
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
        setIssue('unsupported');
        return;
      }

      busyRef.current = true;
      setIssue(null);
      setElapsedMs(0);
      setLiveWaveform([]);
      stopPlayback();

      let stream: MediaStream | null = null;
      try {
        // Safari requires HTTPS and a direct user gesture for this permission prompt.
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        const mimeType = chooseRecordingMimeType();
        const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
        let resolveStop: () => void = () => {};
        const stopPromise = new Promise<void>((resolve) => { resolveStop = resolve; });
        let audioContext: AudioContext | null = null;
        let meter: AnalyserNode | null = null;
        try {
          audioContext = new AudioContext();
          meter = audioContext.createAnalyser();
          meter.fftSize = 256;
          audioContext.createMediaStreamSource(stream).connect(meter);
        } catch {
          if (audioContext && audioContext.state !== 'closed') void audioContext.close().catch(() => undefined);
          audioContext = null;
          meter = null;
        }

        const session: WebRecordingSession = {
          slot,
          recorder,
          stream,
          chunks: [],
          startedAt: Date.now(),
          stopPromise,
          resolveStop,
          meter,
          audioContext,
          finishPromise: null,
          cancelled: false,
          failed: false,
          finishRequested: false,
          maxTimer: null,
          meterTimer: null,
        };
        recordingRef.current = session;
        recorder.ondataavailable = (event) => {
          if (event.data.size > 0) session.chunks.push(event.data);
        };
        recorder.onerror = () => {
          session.failed = true;
          void finishRecording(session);
        };
        recorder.onstop = () => { session.resolveStop(); };
        recorder.start(100);
        setActiveSlot(slot);
        setIsRecording(true);
        setIsProcessing(false);

        session.meterTimer = setInterval(() => {
          if (recordingRef.current !== session || session.finishRequested) return;
          const elapsed = Math.min(MAX_RECORDING_MS, Date.now() - session.startedAt);
          setElapsedMs(elapsed);
          const level = session.meter ? readMeterLevel(session.meter) : 0.08;
          setLiveWaveform((current) => [...current.slice(-(MAX_LIVE_BARS - 1)), level]);
        }, 100);
        session.maxTimer = setTimeout(() => { void finishRecording(session); }, MAX_RECORDING_MS);
        if (audioContext?.state === 'suspended') void audioContext.resume().catch(() => undefined);
      } catch (error) {
        const session = recordingRef.current;
        if (session?.slot === slot) {
          session.cancelled = true;
          if (session.recorder.state !== 'inactive') {
            try { session.recorder.stop(); } catch { session.resolveStop(); }
          }
          releaseSession(session);
          recordingRef.current = null;
        }
        stream?.getTracks().forEach((track) => track.stop());
        const name = error instanceof DOMException ? error.name : '';
        setIssue(name === 'NotAllowedError' || name === 'SecurityError' ? 'permission' : 'record');
        if (mountedRef.current) {
          setActiveSlot(null);
          setIsRecording(false);
          setIsProcessing(false);
        }
        busyRef.current = false;
      }
    },
    [finishRecording, releaseSession, stopPlayback]
  );

  const stopRecording = useCallback(async (): Promise<void> => {
    const session = recordingRef.current;
    if (session) await finishRecording(session);
  }, [finishRecording]);

  const playClip = useCallback(
    async (slot: ClipSlot, backwards: boolean): Promise<void> => {
      if (recordingRef.current || busyRef.current) return;
      const clip = clipsRef.current[slot];
      if (!clip) return;

      stopPlayback();
      setIssue(null);
      const selection = { slot, backwards };
      const audio = new Audio(backwards ? clip.backwardsUri : clip.uri);
      currentAudioRef.current = audio;
      audio.onended = () => {
        if (currentAudioRef.current === audio) {
          currentAudioRef.current = null;
          setPlayback(null);
        }
      };
      audio.onerror = () => {
        if (currentAudioRef.current === audio) {
          currentAudioRef.current = null;
          setPlayback(null);
          setIssue('playback');
        }
      };
      setPlayback(selection);
      try {
        await audio.play();
      } catch {
        if (currentAudioRef.current === audio) {
          currentAudioRef.current = null;
          setPlayback(null);
          setIssue('playback');
        }
      }
    },
    [stopPlayback]
  );

  const clearClip = useCallback(
    async (slot: ClipSlot): Promise<void> => {
      const session = recordingRef.current;
      if (session?.slot === slot) {
        session.cancelled = true;
        await finishRecording(session);
      }
      const clip = clipsRef.current[slot];
      if (currentAudioRef.current && clip && (currentAudioRef.current.src === clip.uri || currentAudioRef.current.src === clip.backwardsUri)) {
        stopPlayback();
      }
      const next = { ...clipsRef.current };
      delete next[slot];
      updateClips(next);
      if (clip) revokeClip(clip, objectUrlsRef.current);
      if (mountedRef.current) setIssue(null);
    },
    [finishRecording, stopPlayback, updateClips]
  );

  const resetRound = useCallback(async (): Promise<void> => {
    const session = recordingRef.current;
    if (session) {
      session.cancelled = true;
      await finishRecording(session);
    }
    stopPlayback();
    for (const clip of Object.values(clipsRef.current)) {
      if (clip) revokeClip(clip, objectUrlsRef.current);
    }
    updateClips({});
    if (mountedRef.current) {
      setActiveSlot(null);
      setIsRecording(false);
      setIsProcessing(false);
      setElapsedMs(0);
      setLiveWaveform([]);
      setPlayback(null);
      setIssue(null);
      busyRef.current = false;
    }
  }, [finishRecording, stopPlayback, updateClips]);

  useEffect(() => {
    mountedRef.current = true;
    const objectUrls = objectUrlsRef.current;
    const stopWhenHidden = () => {
      if (document.visibilityState !== 'hidden') return;
      const session = recordingRef.current;
      if (session) {
        session.cancelled = true;
        void finishRecording(session);
      }
      const audio = currentAudioRef.current;
      if (audio) audio.pause();
      currentAudioRef.current = null;
      setPlayback(null);
    };
    document.addEventListener('visibilitychange', stopWhenHidden);
    return () => {
      mountedRef.current = false;
      document.removeEventListener('visibilitychange', stopWhenHidden);
      const session = recordingRef.current;
      if (session) {
        session.cancelled = true;
        if (session.recorder.state !== 'inactive') {
          try { session.recorder.stop(); } catch { session.resolveStop(); }
        }
        releaseSession(session);
      }
      const audio = currentAudioRef.current;
      if (audio) audio.pause();
      objectUrls.forEach((uri) => URL.revokeObjectURL(uri));
      objectUrls.clear();
    };
  }, [finishRecording, releaseSession]);

  return {
    clips,
    activeSlot,
    isRecording,
    isProcessing,
    elapsedMs,
    liveWaveform,
    playback,
    progress: Math.max(0, Math.min(1, elapsedMs / MAX_RECORDING_MS)),
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

function chooseRecordingMimeType(): string | undefined {
  if (typeof MediaRecorder.isTypeSupported !== 'function') return undefined;
  return ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'].find((type) =>
    MediaRecorder.isTypeSupported(type)
  );
}

function encodePcmWav(buffer: AudioBuffer, backwards: boolean): Uint8Array {
  const channels = buffer.numberOfChannels;
  const frames = buffer.length;
  const frameSize = channels * 2;
  const dataBytes = frames * frameSize;
  const output = new Uint8Array(44 + dataBytes);
  const view = new DataView(output.buffer);
  writeFourCc(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeFourCc(view, 8, 'WAVE');
  writeFourCc(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * frameSize, true);
  view.setUint16(32, frameSize, true);
  view.setUint16(34, 16, true);
  writeFourCc(view, 36, 'data');
  view.setUint32(40, dataBytes, true);

  const channelData = Array.from({ length: channels }, (_, channel) => buffer.getChannelData(channel));
  let offset = 44;
  for (let frame = 0; frame < frames; frame += 1) {
    const sourceFrame = backwards ? frames - 1 - frame : frame;
    for (let channel = 0; channel < channels; channel += 1) {
      const sample = Math.max(-1, Math.min(1, channelData[channel][sourceFrame]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }
  return output;
}

function waveformFromBuffer(buffer: AudioBuffer, backwards: boolean): number[] {
  const bars = Math.min(WAVEFORM_BARS, buffer.length);
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel));
  const waveform: number[] = [];
  for (let bar = 0; bar < bars; bar += 1) {
    const start = Math.floor((bar * buffer.length) / bars);
    const end = Math.max(start + 1, Math.floor(((bar + 1) * buffer.length) / bars));
    let peak = 0;
    for (let frame = start; frame < end; frame += 1) {
      const sourceFrame = backwards ? buffer.length - 1 - frame : frame;
      for (const channel of channels) peak = Math.max(peak, Math.abs(channel[sourceFrame]));
    }
    waveform.push(Math.max(0.025, peak));
  }
  return waveform;
}

function readMeterLevel(analyser: AnalyserNode): number {
  const samples = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(samples);
  let sum = 0;
  for (const sample of samples) {
    const normalized = (sample - 128) / 128;
    sum += normalized * normalized;
  }
  return Math.max(0.04, Math.min(1, Math.sqrt(sum / samples.length) * 3));
}

function writeFourCc(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

function ownedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function revokeClip(clip: GameClip, trackedUrls: Set<string>): void {
  for (const uri of [clip.uri, clip.backwardsUri]) {
    if (trackedUrls.delete(uri)) URL.revokeObjectURL(uri);
  }
}
