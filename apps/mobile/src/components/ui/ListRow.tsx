import type { ReactNode } from 'react';
import { StyleSheet, Text, TouchableOpacity, View, type StyleProp, type ViewStyle } from 'react-native';
import { useTheme } from '../../contexts/ThemeContext';
import { getColors } from '../../theme/colors';
import { roles, space, touchTarget, type } from '../../theme/tokens';
import { AppIcon, type AppIconName } from '../AppIcon';

export interface ListRowProps {
  title: string;
  subtitle?: string;
  /** Leading glyph; use `leading` for an avatar or custom node. */
  icon?: AppIconName;
  leading?: ReactNode;
  /** Right side: a value, a Switch, a Chip. Tappable rows add a chevron. */
  trailing?: ReactNode;
  onPress?: () => void;
  chevron?: boolean;
  destructive?: boolean;
  /** Hairline above the row (rows after the first inside a Card). */
  divider?: boolean;
  disabled?: boolean;
  accessibilityLabel?: string;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}

/** Settings-style row: leading · title/subtitle · trailing · chevron. */
export function ListRow({
  title, subtitle, icon, leading, trailing, onPress, chevron = !!onPress, destructive, divider, disabled,
  accessibilityLabel, testID, style,
}: ListRowProps) {
  const { scheme } = useTheme();
  const r = roles(getColors(scheme));
  const fg = destructive ? r.danger : r.text;
  const content = (
    <>
      {leading ?? (icon ? <AppIcon name={icon} color={destructive ? r.danger : r.textSecondary} size={20} /> : null)}
      <View style={styles.text}>
        <Text style={[type.body, { color: fg }]} numberOfLines={1}>{title}</Text>
        {subtitle ? <Text style={[type.meta, { color: r.textMeta }]} numberOfLines={2}>{subtitle}</Text> : null}
      </View>
      {trailing}
      {chevron && <AppIcon name="chevron-right" color={r.decoration} size={16} />}
    </>
  );
  const rowStyle = [styles.row, divider && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: r.line }, style];
  if (!onPress) return <View style={rowStyle} testID={testID} accessibilityLabel={accessibilityLabel}>{content}</View>;
  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityState={{ disabled: !!disabled }}
      onPress={onPress}
      disabled={disabled}
      testID={testID}
      style={[rowStyle, disabled && styles.disabled]}
    >
      {content}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  row: { minHeight: touchTarget, paddingVertical: space[3], paddingHorizontal: space[4], flexDirection: 'row', alignItems: 'center', gap: space[3] },
  text: { flex: 1, minWidth: 0, gap: 2 },
  disabled: { opacity: 0.5 },
});
