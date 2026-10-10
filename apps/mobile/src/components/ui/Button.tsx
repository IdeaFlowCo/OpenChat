import type { ReactNode } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View, type StyleProp, type ViewStyle } from 'react-native';
import { useTheme } from '../../contexts/ThemeContext';
import { getColors } from '../../theme/colors';
import { radius, roles, space, touchTarget, type } from '../../theme/tokens';
import { AppIcon, type AppIconName } from '../AppIcon';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'destructive';
export type ButtonSize = 'md' | 'sm';

export interface ButtonProps {
  label: string;
  onPress?: () => void;
  /** One `primary` per screen; `secondary` for the rest; `ghost` for tertiary. */
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: AppIconName;
  /** Replaces the icon with a custom leading node (e.g. a badge). */
  leading?: ReactNode;
  disabled?: boolean;
  loading?: boolean;
  /** Stretch to the container width. */
  block?: boolean;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}

/** The one button. Replaces accent text links, ad-hoc filled pills and
 * outlined hairline boxes. `sm` keeps a 44pt target through `hitSlop`. */
export function Button({
  label, onPress, variant = 'secondary', size = 'md', icon, leading, disabled, loading, block,
  accessibilityLabel, accessibilityHint, testID, style,
}: ButtonProps) {
  const { scheme } = useTheme();
  const r = roles(getColors(scheme));
  const tone = {
    primary: { bg: r.accent, fg: r.onAccent, border: r.accent },
    secondary: { bg: r.card, fg: r.text, border: r.line },
    ghost: { bg: 'transparent', fg: r.text, border: 'transparent' },
    destructive: { bg: r.dangerSoft, fg: r.danger, border: 'transparent' },
  }[variant];
  const sm = size === 'sm';
  const height = sm ? 32 : touchTarget;
  const slop = Math.max(0, (touchTarget - height) / 2);
  const inactive = disabled || loading;
  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: !!inactive, busy: !!loading }}
      disabled={inactive}
      onPress={onPress}
      hitSlop={slop ? { top: slop, bottom: slop, left: 4, right: 4 } : undefined}
      testID={testID}
      activeOpacity={0.7}
      style={[
        styles.base,
        { minHeight: height, paddingHorizontal: sm ? space[3] : space[4], backgroundColor: tone.bg, borderColor: tone.border },
        variant === 'ghost' && { paddingHorizontal: sm ? space[2] : space[3] },
        block && styles.block,
        inactive && styles.inactive,
        style,
      ]}
    >
      <View style={styles.content}>
        {loading
          ? <ActivityIndicator size="small" color={tone.fg} />
          : leading ?? (icon ? <AppIcon name={icon} color={tone.fg} size={sm ? 16 : 18} /> : null)}
        <Text style={[sm ? styles.labelSm : styles.labelMd, { color: tone.fg }]} numberOfLines={1}>{label}</Text>
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  base: { borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center', alignSelf: 'flex-start' },
  block: { alignSelf: 'stretch' },
  inactive: { opacity: 0.5 },
  content: { flexDirection: 'row', alignItems: 'center', gap: space[2] },
  labelMd: { ...type.bodyStrong },
  labelSm: { ...type.label, fontWeight: '600' },
});
