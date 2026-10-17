import { Ionicons } from '@expo/vector-icons';
import { useEffect, useState } from 'react';
import {
  Animated,
  Pressable,
  StyleSheet,
  Text,
  type StyleProp,
  type TextStyle,
  View,
} from 'react-native';

import { colors } from './theme';
import type { Locale } from './i18n';

type CopyTextProps = {
  children: React.ReactNode;
  locale: Locale;
  style?: StyleProp<TextStyle>;
  writingDirection?: 'auto' | 'ltr' | 'rtl';
  accessibilityRole?: 'header' | 'text';
  numberOfLines?: number;
};

export function CopyText({
  children,
  locale,
  style,
  writingDirection,
  accessibilityRole,
  numberOfLines,
}: CopyTextProps) {
  return (
    <Text
      accessibilityRole={accessibilityRole}
      numberOfLines={numberOfLines}
      allowFontScaling
      style={[
        { color: colors.ink, writingDirection: writingDirection ?? (locale === 'ar' ? 'rtl' : 'ltr') },
        style,
      ]}
    >
      {children}
    </Text>
  );
}

type ButtonProps = {
  label: string;
  locale: Locale;
  onPress: () => void;
  tone?: 'primary' | 'secondary' | 'quiet' | 'outline';
  compact?: boolean;
  icon?: keyof typeof Ionicons.glyphMap;
  accessibilityHint?: string;
  spokenLanguage?: 'en' | 'ar';
};

export function ActionButton({
  label,
  locale,
  onPress,
  tone = 'primary',
  compact = false,
  icon,
  accessibilityHint,
  spokenLanguage,
}: ButtonProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityLanguage={spokenLanguage ?? (locale === 'ar' ? 'ar' : 'en')}
      onPress={onPress}
      style={({ pressed }) => [
        styles.action,
        compact && styles.compact,
        styles[tone],
        pressed && styles.pressed,
      ]}
    >
      {icon ? (
        <Ionicons
          name={locale === 'ar' && icon === 'arrow-forward' ? 'arrow-back' : icon}
          size={20}
          color={tone === 'primary' ? colors.surface : colors.ink}
        />
      ) : null}
      <CopyText
        locale={locale}
        style={[
          styles.actionLabel,
          tone === 'primary' ? styles.primaryLabel : styles.secondaryLabel,
        ]}
      >
        {label}
      </CopyText>
    </Pressable>
  );
}

export function WaveBars({
  values,
  color = colors.leaf,
}: {
  values: number[];
  color?: string;
}) {
  const bars = values.length > 32
    ? values.filter((_, index) => index % Math.ceil(values.length / 32) === 0).slice(0, 32)
    : values;

  return (
    <View
      accessible={false}
      style={styles.waveBars}
    >
      {bars.map((value, index) => {
        const level = Math.max(0, Math.min(1, value));
        return (
          <View
            key={index}
            style={[
              styles.waveBar,
              {
                height: Math.max(3, 5 + level * 47),
                backgroundColor: color,
                opacity: 0.55 + level * 0.45,
              },
            ]}
          />
        );
      })}
    </View>
  );
}

export function SoundSpot({
  values,
  recording,
  reducedMotion,
}: {
  values: number[];
  recording: boolean;
  reducedMotion: boolean;
}) {
  const [pulse] = useState(() => new Animated.Value(0));

  useEffect(() => {
    if (!recording || reducedMotion) {
      pulse.stopAnimation();
      pulse.setValue(0);
      return undefined;
    }

    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 700,
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0,
          duration: 700,
          useNativeDriver: true,
        }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [pulse, recording, reducedMotion]);

  const scale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.1] });
  const opacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.35, 0.08] });

  return (
    <View style={styles.soundSpot}>
      {recording ? (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.soundHalo,
            {
              opacity: reducedMotion ? 0 : opacity,
              transform: [{ scale: reducedMotion ? 1 : scale }],
            },
          ]}
        />
      ) : null}
      <View style={styles.soundRing}>
        <View style={styles.soundCore}>
          <WaveBars values={values} color={recording ? colors.coral : colors.leaf} />
        </View>
      </View>
    </View>
  );
}

export function RecorderButton({
  locale,
  recording,
  disabled,
  onPress,
  elapsedMs,
  labels,
}: {
  locale: Locale;
  recording: boolean;
  disabled: boolean;
  onPress: () => void;
  elapsedMs: number;
  labels: { record: string; stop: string; maxLength: string };
}) {
  const seconds = String(Math.min(5, Math.floor(elapsedMs / 1000))).padStart(2, '0');

  return (
    <View style={styles.recorder}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={recording ? labels.stop : labels.record}
        accessibilityHint={recording
          ? (locale === 'ar' ? 'أوقف التسجيل الآن' : 'Stops the recording now')
          : (locale === 'ar' ? 'يبدأ التسجيل لمدة تصل إلى خمس ثوانٍ' : 'Starts a recording for up to five seconds')}
        accessibilityLanguage={locale === 'ar' ? 'ar' : 'en'}
        accessibilityState={{ disabled, selected: recording }}
        disabled={disabled}
        onPress={onPress}
        style={({ pressed }) => [
          styles.recordOrb,
          recording && styles.recordOrbActive,
          pressed && !disabled && styles.recordOrbPressed,
          disabled && styles.disabled,
        ]}
      >
        <Ionicons
          name={recording ? 'stop' : 'mic'}
          size={40}
          color={colors.surface}
        />
      </Pressable>
      <CopyText locale={locale} style={styles.recorderLabel}>
        {recording ? labels.stop : labels.record}
      </CopyText>
      <CopyText
        locale={locale}
        writingDirection="ltr"
        style={styles.duration}
      >
        {recording ? '0:' + seconds + ' / 0:05' : labels.maxLength}
      </CopyText>
    </View>
  );
}

export function StageProgress({
  active,
  locale,
  labels,
  accessibilityLabel,
}: {
  active: number;
  locale: Locale;
  labels: string[];
  accessibilityLabel: string;
}) {
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel={accessibilityLabel}
      accessibilityValue={{ min: 1, max: labels.length, now: active }}
      style={[styles.steps, { direction: locale === 'ar' ? 'rtl' : 'ltr' }]}
    >
      {labels.map((label, index) => {
        const current = index + 1;
        return (
          <View key={label} style={styles.step}>
            <View
              style={[
                styles.stepLine,
                current < active && styles.stepDone,
                current === active && styles.stepCurrent,
              ]}
            />
            <CopyText
              locale={locale}
              style={[
                styles.stepLabel,
                current === active && styles.stepLabelCurrent,
              ]}
            >
              {label}
            </CopyText>
          </View>
        );
      })}
    </View>
  );
}

export function ScreenHeading({
  eyebrow,
  title,
  subtitle,
  locale,
}: {
  eyebrow: string;
  title: string;
  subtitle: string;
  locale: Locale;
}) {
  return (
    <View style={styles.heading}>
      <CopyText locale={locale} style={styles.eyebrow}>{eyebrow}</CopyText>
      <CopyText
        locale={locale}
        accessibilityRole="header"
        style={styles.title}
      >
        {title}
      </CopyText>
      <CopyText locale={locale} style={styles.subtitle}>{subtitle}</CopyText>
    </View>
  );
}

const styles = StyleSheet.create({
  action: {
    minHeight: 56,
    width: '100%',
    borderRadius: 18,
    paddingHorizontal: 20,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  compact: { width: 'auto', minHeight: 44, paddingHorizontal: 10, gap: 6 },
  primary: { backgroundColor: colors.coral },
  secondary: { backgroundColor: colors.leafSoft, borderWidth: 1, borderColor: colors.line },
  quiet: { backgroundColor: 'transparent' },
  outline: { backgroundColor: colors.surface, borderWidth: 1.2, borderColor: colors.line },
  pressed: { opacity: 0.88, transform: [{ scale: 0.985 }] },
  disabled: { opacity: 0.55 },
  actionLabel: { fontSize: 16, fontWeight: '800', textAlign: 'center', flexShrink: 1 },
  primaryLabel: { color: colors.surface },
  secondaryLabel: { color: colors.ink },
  waveBars: {
    minHeight: 64,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    paddingHorizontal: 11,
  },
  waveBar: { width: 3, minHeight: 4, borderRadius: 3 },
  soundSpot: {
    width: 240,
    height: 240,
    alignSelf: 'center',
    alignItems: 'center',
    justifyContent: 'center',
    marginVertical: 2,
  },
  soundHalo: {
    position: 'absolute',
    width: 218,
    height: 218,
    borderRadius: 110,
    borderWidth: 1.5,
    borderColor: colors.coral,
    backgroundColor: colors.coralSoft,
  },
  soundRing: {
    width: 202,
    height: 202,
    borderRadius: 105,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  soundCore: {
    width: 166,
    height: 166,
    borderRadius: 86,
    backgroundColor: colors.leafSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  recorder: { width: '100%', alignItems: 'center', gap: 7 },
  recordOrb: {
    width: 104,
    height: 104,
    minWidth: 64,
    minHeight: 64,
    borderRadius: 56,
    backgroundColor: colors.coral,
    borderColor: colors.surface,
    borderWidth: 6,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#50392C',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.16,
    shadowRadius: 14,
    elevation: 4,
  },
  recordOrbActive: { backgroundColor: colors.ink },
  recordOrbPressed: { transform: [{ scale: 0.96 }] },
  recorderLabel: { color: colors.ink, fontSize: 15, fontWeight: '800', textAlign: 'center' },
  duration: { color: colors.muted, fontSize: 13, fontWeight: '700', letterSpacing: 0.5 },
  steps: { flexDirection: 'row', gap: 8 },
  step: { flex: 1, alignItems: 'center', gap: 7 },
  stepLine: { width: '100%', height: 4, borderRadius: 3, backgroundColor: colors.cream },
  stepDone: { backgroundColor: colors.leaf },
  stepCurrent: { backgroundColor: colors.coral },
  stepLabel: { color: colors.muted, fontSize: 11, fontWeight: '600', textAlign: 'center' },
  stepLabelCurrent: { color: colors.ink, fontWeight: '800' },
  heading: { alignItems: 'center', gap: 10, width: '100%', minHeight: 112 },
  eyebrow: { color: colors.coral, fontSize: 12, fontWeight: '800', letterSpacing: 1.1, textAlign: 'center' },
  title: { color: colors.ink, fontSize: 30, fontWeight: '800', lineHeight: 37, textAlign: 'center', maxWidth: 365 },
  subtitle: { color: colors.secondaryInk, fontSize: 17, lineHeight: 24, textAlign: 'center', maxWidth: 350 },
});
