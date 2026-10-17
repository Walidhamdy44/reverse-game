import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';

import * as Haptics from 'expo-haptics';
import {
  AccessibilityInfo,
  Linking,
  Platform,
  ScrollView,
  StatusBar,
  StyleSheet,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { useEffect, useState } from 'react';

import { ActionButton, CopyText, RecorderButton, ScreenHeading, SoundSpot, StageProgress, WaveBars } from './src/components';
import { getCopy, getDeviceLocale, type Locale } from './src/i18n';
import type { ClipSlot } from './src/audio/useGameAudio';
import { useGameAudio } from './src/audio/useGameAudio';
import { colors } from './src/theme';
import { styles } from './src/appStyles';

type Stage = 'welcome' | 'recordOriginal' | 'handoff' | 'listenOriginal' | 'recordImitation' | 'listenResult' | 'reveal';

const LANGUAGE_KEY = 'reverse-words.language';
const DEMO_WAVEFORM = [0.16, 0.36, 0.66, 0.82, 0.53, 0.29, 0.72, 0.45, 0.22, 0.58, 0.94, 0.48, 0.32, 0.77, 0.43, 0.2];

export default function App() {
  return (
    <SafeAreaProvider>
      <ReverseWordsGame />
    </SafeAreaProvider>
  );
}

function ReverseWordsGame() {
  const [locale, setLocale] = useState<Locale>(getDeviceLocale);
  const [ready, setReady] = useState(false);
  const [stage, setStage] = useState<Stage>('welcome');
  const [creator, setCreator] = useState<1 | 2>(1);
  const [round, setRound] = useState(1);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [lastPlaybackRequest, setLastPlaybackRequest] = useState<{ slot: ClipSlot; backwards: boolean } | null>(null);
  const audio = useGameAudio();
  const t = getCopy(locale);
  const playerName = creator === 1 ? t.playerOne : t.playerTwo;
  const receiverName = creator === 1 ? t.playerTwo : t.playerOne;
  const topPlayer = stage === 'handoff' || stage === 'listenOriginal' || stage === 'recordImitation' || stage === 'listenResult' || stage === 'reveal' ? receiverName : playerName;
  const recordingSlot: ClipSlot = stage === 'recordImitation' ? 'imitation' : 'original';
  const isCurrentRecording = audio.isRecording && audio.activeSlot === recordingSlot;

  useEffect(() => {
    let mounted = true;
    AsyncStorage.getItem(LANGUAGE_KEY)
      .then((saved) => {
        if (mounted && (saved === 'en' || saved === 'ar')) setLocale(saved);
      })
      .catch(() => undefined)
      .finally(() => {
        if (mounted) setReady(true);
      });
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    let mounted = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((value) => { if (mounted) setReducedMotion(value); })
      .catch(() => undefined);
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReducedMotion);
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    if (stage !== 'reveal') return;
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setLastPlaybackRequest({ slot: 'original', backwards: false });
    // Safari blocks audio started outside the tap that opened the reveal screen.
    if (Platform.OS !== 'web') void audio.playClip('original', false);
  }, [stage]);

  useEffect(() => {
    if (audio.issue === 'playback') {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    }
  }, [audio.issue]);

  const switchLanguage = () => {
    const next: Locale = locale === 'en' ? 'ar' : 'en';
    setLocale(next);
    void AsyncStorage.setItem(LANGUAGE_KEY, next).catch(() => undefined);
    void Haptics.selectionAsync();
  };

  const startRound = () => {
    setStage('recordOriginal');
    void Haptics.selectionAsync();
  };

  const beginRecording = async (slot: ClipSlot) => {
    if (audio.isRecording && audio.activeSlot === slot) {
      await audio.stopRecording();
      return;
    }
    if (audio.isRecording) await audio.stopRecording();
    await audio.startRecording(slot);
    if (audio.issue === null) void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  const togglePlayback = (slot: ClipSlot, backwards: boolean) => {
    const active = audio.playback;
    if (active?.slot === slot && active.backwards === backwards) {
      audio.stopPlayback();
    } else {
      setLastPlaybackRequest({ slot, backwards });
      void audio.playClip(slot, backwards);
    }
  };

  const retryPlayback = () => {
    if (lastPlaybackRequest) void audio.playClip(lastPlaybackRequest.slot, lastPlaybackRequest.backwards);
  };

  const nextRound = async () => {
    await audio.resetRound();
    setCreator((current) => current === 1 ? 2 : 1);
    setRound((current) => current + 1);
    setStage('welcome');
  };

  const retryImitation = async () => {
    await audio.clearClip('imitation');
    setStage('recordImitation');
  };

  if (!ready) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <StatusBar barStyle="dark-content" />
        <View style={styles.loading}>
          <Ionicons name="ear-outline" size={32} color={colors.leaf} />
          <CopyText locale={locale} style={styles.loadingText}>{t.loadingTitle}</CopyText>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'bottom']}>
      <StatusBar barStyle="dark-content" backgroundColor={colors.paper} />
      <View style={[styles.root, { direction: locale === 'ar' ? 'rtl' : 'ltr' }]}>
        <View style={styles.topBar}>
          <View style={styles.brandLockup}>
            <View style={styles.brandMark}>
              <Ionicons name="musical-notes" size={17} color={colors.surface} />
            </View>
            <CopyText locale={locale} style={styles.brand}>{t.brand}</CopyText>
          </View>
          <ActionButton
            locale={locale}
            tone="quiet"
            compact
            icon="globe-outline"
            label={locale === 'en' ? 'العربية' : 'English'}
            onPress={switchLanguage}
            accessibilityHint={t.accessibilityLanguage}
            spokenLanguage={locale === 'en' ? 'ar' : 'en'}
          />
        </View>

        {stage !== 'welcome' ? (
          <View style={styles.progressWrap}>
            <View style={styles.roundTag}>
              <CopyText locale={locale} style={styles.roundLabel}>{t.round} {round}</CopyText>
              <View style={styles.roundDot} />
              <CopyText locale={locale} style={styles.roundLabel}>{topPlayer}</CopyText>
            </View>
            <StageProgress
              active={stage === 'recordOriginal' ? 1 : (stage === 'handoff' || stage === 'listenOriginal' ? 2 : (stage === 'recordImitation' || stage === 'listenResult' ? 3 : 4))}
              locale={locale}
              labels={[t.stepSecret, t.stepListen, t.stepImitate, t.stepReveal]}
              accessibilityLabel={t.accessibilityProgress}
            />
          </View>
        ) : null}

        <ScrollView
          key={stage}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {stage === 'welcome' ? (
            <WelcomeStage locale={locale} t={t} reducedMotion={reducedMotion} onStart={startRound} round={round} player={playerName} />
          ) : null}

          {stage === 'recordOriginal' ? (
            <RecordStage
              locale={locale}
              title={t.creatorTurn}
              hint={t.creatorHint}
              saved={Boolean(audio.clips.original) && !audio.isProcessing}
              player={playerName}
              isRecording={isCurrentRecording}
              disabled={audio.isProcessing || (audio.isRecording && !isCurrentRecording)}
              elapsedMs={audio.elapsedMs}
              values={isCurrentRecording ? audio.liveWaveform : (audio.clips.original?.waveform ?? DEMO_WAVEFORM)}
              reducedMotion={reducedMotion}
              onRecord={() => void beginRecording('original')}
              onPreview={() => togglePlayback('original', false)}
              onNext={() => { audio.stopPlayback(); setStage('handoff'); }}
              nextLabel={t.handoffName + ' ' + receiverName}
              isPlaying={audio.playback?.slot === 'original' && audio.playback.backwards === false}
              t={t}
            />
          ) : null}

          {stage === 'handoff' ? (
            <HandoffStage
              locale={locale}
              receiver={receiverName}
              onReady={() => setStage('listenOriginal')}
              t={t}
            />
          ) : null}

          {stage === 'listenOriginal' ? (
            <ListenStage
              locale={locale}
              title={t.listenBackwardsTitle}
              hint={t.listenBackwardsHint}
              waveform={audio.clips.original?.backwardsWaveform ?? DEMO_WAVEFORM}
              playLabel={audio.playback?.slot === 'original' && audio.playback.backwards ? t.replayBackwards : t.playBackwards}
              isPlaying={audio.playback?.slot === 'original' && audio.playback.backwards}
              onPlay={() => togglePlayback('original', true)}
              onNext={() => { audio.stopPlayback(); setStage('recordImitation'); }}
              nextLabel={t.heardIt}
              t={t}
              reducedMotion={reducedMotion}
            />
          ) : null}

          {stage === 'recordImitation' ? (
            <RecordStage
              locale={locale}
              title={t.imitationTitle}
              hint={t.imitationHint}
              saved={Boolean(audio.clips.imitation) && !audio.isProcessing}
              player={receiverName}
              isRecording={isCurrentRecording}
              disabled={audio.isProcessing || (audio.isRecording && !isCurrentRecording)}
              elapsedMs={audio.elapsedMs}
              values={isCurrentRecording ? audio.liveWaveform : (audio.clips.imitation?.waveform ?? DEMO_WAVEFORM)}
              reducedMotion={reducedMotion}
              onRecord={() => void beginRecording('imitation')}
              onPreview={() => togglePlayback('imitation', false)}
              onNext={() => { audio.stopPlayback(); setStage('listenResult'); }}
              nextLabel={t.next}
              isPlaying={audio.playback?.slot === 'imitation' && audio.playback.backwards === false}
              t={t}
            />
          ) : null}

          {stage === 'listenResult' ? (
            <ListenStage
              locale={locale}
              title={t.resultTitle}
              hint={t.resultHint}
              waveform={audio.clips.imitation?.backwardsWaveform ?? DEMO_WAVEFORM}
              playLabel={t.playResult}
              isPlaying={audio.playback?.slot === 'imitation' && audio.playback.backwards}
              onPlay={() => togglePlayback('imitation', true)}
              onNext={() => { audio.stopPlayback(); setStage('reveal'); }}
              nextLabel={t.revealOriginal}
              onSecondary={retryImitation}
              secondaryLabel={t.tryAgain}
              t={t}
              reducedMotion={reducedMotion}
            />
          ) : null}

          {stage === 'reveal' ? (
            <RevealStage
              locale={locale}
              original={audio.clips.original?.waveform ?? DEMO_WAVEFORM}
              imitation={audio.clips.imitation?.backwardsWaveform ?? DEMO_WAVEFORM}
              playback={audio.playback}
              onPlay={togglePlayback}
              onNewRound={() => void nextRound()}
              onHome={() => { void (async () => { await audio.resetRound(); setStage('welcome'); })(); }}
              t={t}
            />
          ) : null}

          {audio.issue ? (
            <ErrorNotice
              locale={locale}
              issue={audio.issue}
              canAskAgain={audio.canAskAgain}
              onRetry={() => void beginRecording(recordingSlot)}
              onSettings={() => void Linking.openSettings()}
              onPlaybackRetry={retryPlayback}
              t={t}
            />
          ) : null}
        </ScrollView>
      </View>
    </SafeAreaView>
  );
}

type Copy = ReturnType<typeof getCopy>;

function WelcomeStage({
  locale,
  t,
  reducedMotion,
  onStart,
  round,
  player,
}: {
  locale: Locale;
  t: Copy;
  reducedMotion: boolean;
  onStart: () => void;
  round: number;
  player: string;
}) {
  return (
    <View style={styles.stage}>
      <CopyText locale={locale} style={styles.welcomeEyebrow}>{t.welcomeEyebrow}</CopyText>
      <CopyText locale={locale} accessibilityRole="header" style={styles.welcomeTitle}>{t.welcomeTitle}</CopyText>
      <CopyText locale={locale} style={styles.welcomeBody}>{t.welcomeBody}</CopyText>
      <SoundSpot values={DEMO_WAVEFORM} recording={false} reducedMotion={reducedMotion} />
      <View style={styles.welcomeMeta}>
        <CopyText locale={locale} style={styles.welcomeNote}>{t.welcomeNote}</CopyText>
        <CopyText locale={locale} style={styles.welcomeRound}>{t.round} {round} · {player}</CopyText>
      </View>
      <View style={styles.buttonGroup}>
        <ActionButton locale={locale} label={t.startRound} icon="arrow-forward" onPress={onStart} />
        <CopyText locale={locale} style={styles.loginNote}>{t.noLogin}</CopyText>
      </View>
    </View>
  );
}

function RecordStage({
  locale,
  title,
  hint,
  saved,
  player,
  isRecording,
  disabled,
  elapsedMs,
  values,
  reducedMotion,
  onRecord,
  onPreview,
  onNext,
  nextLabel,
  isPlaying,
  t,
}: {
  locale: Locale;
  title: string;
  hint: string;
  saved: boolean;
  player: string;
  isRecording: boolean;
  disabled: boolean;
  elapsedMs: number;
  values: number[];
  reducedMotion: boolean;
  onRecord: () => void;
  onPreview: () => void;
  onNext: () => void;
  nextLabel: string;
  isPlaying: boolean;
  t: Copy;
}) {
  const imitation = title === t.imitationTitle;
  const recordLabel = saved ? t.recordAgain : (imitation ? t.recordImitation : t.record);
  return (
    <View style={styles.stage}>
      <ScreenHeading
        locale={locale}
        eyebrow={player}
        title={title}
        subtitle={hint}
      />
      <SoundSpot values={values} recording={isRecording} reducedMotion={reducedMotion} />
      <RecorderButton
        locale={locale}
        recording={isRecording}
        disabled={disabled}
        onPress={onRecord}
        elapsedMs={elapsedMs}
        labels={{ record: recordLabel, stop: t.stopRecording, maxLength: t.maxLength }}
      />
      {isRecording ? (
        <View style={styles.statusLine}>
          <View style={styles.liveDot} />
          <CopyText locale={locale} style={styles.statusText}>{t.recording}</CopyText>
        </View>
      ) : null}
      {disabled && !isRecording ? (
        <CopyText locale={locale} style={styles.processingText}>{t.processing}</CopyText>
      ) : null}
      {saved && !isRecording ? (
        <View style={styles.savedMessage}>
          <Ionicons name="checkmark-circle" size={19} color={colors.leaf} />
          <CopyText locale={locale} style={styles.savedText}>{t.soundSaved}</CopyText>
        </View>
      ) : (
        <CopyText locale={locale} style={styles.recordHint}>{t.shortTake}</CopyText>
      )}
      {saved && !isRecording ? (
        <View style={styles.buttonGroup}>
          <ActionButton
            locale={locale}
            tone="secondary"
            icon={isPlaying ? 'stop' : 'play'}
            label={imitation ? t.playImitation : t.previewOriginal}
            onPress={onPreview}
          />
          <ActionButton
            locale={locale}
            icon="arrow-forward"
            label={nextLabel}
            onPress={onNext}
          />
        </View>
      ) : null}
    </View>
  );
}

function HandoffStage({
  locale,
  receiver,
  onReady,
  t,
}: {
  locale: Locale;
  receiver: string;
  onReady: () => void;
  t: Copy;
}) {
  return (
    <View style={styles.stage}>
      <ScreenHeading
        locale={locale}
        eyebrow={t.handoffName}
        title={t.handoffTitle}
        subtitle={t.handoffHint}
      />
      <View style={styles.handoffSeal}>
        <View style={styles.lockCircle}>
          <Ionicons name="lock-closed" size={35} color={colors.leaf} />
        </View>
        <View style={styles.sealWave}><WaveBars values={DEMO_WAVEFORM.slice(0, 10)} /></View>
      </View>
      <View style={styles.handoffNameplate}>
        <CopyText locale={locale} style={styles.handoffLabel}>{t.handoffName}</CopyText>
        <CopyText locale={locale} accessibilityRole="header" style={styles.handoffPlayer}>{receiver}</CopyText>
      </View>
      <ActionButton locale={locale} icon="ear" label={t.handoffReady} onPress={onReady} />
    </View>
  );
}

function ListenStage({
  locale,
  title,
  hint,
  waveform,
  playLabel,
  isPlaying,
  onPlay,
  onNext,
  nextLabel,
  onSecondary,
  secondaryLabel,
  t,
  reducedMotion,
}: {
  locale: Locale;
  title: string;
  hint: string;
  waveform: number[];
  playLabel: string;
  isPlaying: boolean;
  onPlay: () => void;
  onNext: () => void;
  nextLabel: string;
  onSecondary?: () => void;
  secondaryLabel?: string;
  t: Copy;
  reducedMotion: boolean;
}) {
  return (
    <View style={styles.stage}>
      <ScreenHeading
        locale={locale}
        eyebrow={title === t.resultTitle ? t.stepImitate : t.stepListen}
        title={title}
        subtitle={hint}
      />
      <SoundSpot values={waveform} recording={false} reducedMotion={reducedMotion} />
      <View style={styles.buttonGroup}>
        <ActionButton
          locale={locale}
          tone="secondary"
          icon={isPlaying ? 'stop' : 'play'}
          label={playLabel}
          onPress={onPlay}
        />
        <ActionButton locale={locale} icon="arrow-forward" label={nextLabel} onPress={onNext} />
        {onSecondary && secondaryLabel ? (
          <ActionButton locale={locale} tone="quiet" icon="refresh" label={secondaryLabel} onPress={onSecondary} />
        ) : null}
      </View>
    </View>
  );
}

function RevealStage({
  locale,
  original,
  imitation,
  playback,
  onPlay,
  onNewRound,
  onHome,
  t,
}: {
  locale: Locale;
  original: number[];
  imitation: number[];
  playback: { slot: ClipSlot; backwards: boolean } | null;
  onPlay: (slot: ClipSlot, backwards: boolean) => void;
  onNewRound: () => void;
  onHome: () => void;
  t: Copy;
}) {
  return (
    <View style={styles.stage}>
      <ScreenHeading locale={locale} eyebrow={t.stepReveal} title={t.revealTitle} subtitle={t.revealHint} />
      <View style={styles.revealMark}>
        <Ionicons name="sparkles" size={37} color={colors.coral} />
      </View>
      <View style={styles.audioList}>
        <AudioLine
          locale={locale}
          label={t.playOriginal}
          waveform={original}
          color={colors.leaf}
          active={playback?.slot === 'original' && !playback.backwards}
          onPress={() => onPlay('original', false)}
          icon="person"
        />
        <View style={styles.rowDivider} />
        <AudioLine
          locale={locale}
          label={t.playImitation}
          waveform={imitation}
          color={colors.coral}
          active={playback?.slot === 'imitation' && playback.backwards}
          onPress={() => onPlay('imitation', true)}
          icon="swap-horizontal"
        />
      </View>
      <View style={styles.buttonGroup}>
        <ActionButton locale={locale} label={t.newRound} icon="refresh" onPress={onNewRound} />
        <ActionButton locale={locale} tone="quiet" label={t.backHome} icon="home-outline" onPress={onHome} />
      </View>
    </View>
  );
}

function AudioLine({
  locale,
  label,
  waveform,
  color,
  active,
  onPress,
  icon,
}: {
  locale: Locale;
  label: string;
  waveform: number[];
  color: string;
  active: boolean;
  onPress: () => void;
  icon: 'person' | 'swap-horizontal';
}) {
  return (
    <View style={styles.audioLine}>
      <View style={[styles.audioIcon, { backgroundColor: color === colors.coral ? colors.coralSoft : colors.leafSoft }]}>
        <Ionicons name={icon} size={19} color={color} />
      </View>
      <View style={styles.audioContent}>
        <ActionButton
          locale={locale}
          tone="quiet"
          icon={active ? 'stop' : 'play'}
          label={label}
          onPress={onPress}
        />
        <WaveBars values={waveform} color={color} />
      </View>
    </View>
  );
}

function ErrorNotice({
  locale,
  issue,
  canAskAgain,

  onRetry,
  onSettings,
  onPlaybackRetry,
  t,
}: {
  locale: Locale;
  issue: 'permission' | 'record' | 'playback' | 'unsupported' | null;
  canAskAgain: boolean;

  onRetry: () => void;
  onSettings: () => void;
  onPlaybackRetry: () => void;
  t: Copy;
}) {
  const playback = issue === 'playback';
  const canUseSettings = issue === 'permission' && !canAskAgain;
  return (
    <View style={styles.errorBox} accessibilityLiveRegion="polite">
      <View style={styles.errorHeading}>
        <Ionicons name="alert-circle-outline" size={21} color={colors.error} />
        <CopyText locale={locale} accessibilityRole="header" style={styles.errorTitle}>
          {playback ? t.playbackError : (issue === 'permission' ? t.permissionTitle : t.errorTitle)}
        </CopyText>
      </View>
      {!playback ? <CopyText locale={locale} style={styles.errorBody}>{issue === 'permission' ? t.permissionHint : t.errorHint}</CopyText> : null}
      {canUseSettings ? (
        <ActionButton locale={locale} tone="outline" icon="settings-outline" label={t.permissionSettings} onPress={onSettings} />
      ) : playback ? (
        <ActionButton locale={locale} tone="outline" icon="play" label={t.playAgain} onPress={onPlaybackRetry} />
      ) : (
        <ActionButton locale={locale} tone="outline" icon="mic" label={issue === 'permission' ? t.permissionTryAgain : t.errorTryAgain} onPress={onRetry} />
      )}
    </View>
  );
}
