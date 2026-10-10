import { StyleSheet, Text, TouchableOpacity, View, type StyleProp, type ViewStyle } from 'react-native';
import { useTheme } from '../../contexts/ThemeContext';
import { getColors } from '../../theme/colors';
import { radius, roles, space, touchTarget, type } from '../../theme/tokens';
import { AppIcon, type AppIconName } from '../AppIcon';

export interface ChipProps {
  label: string;
  selected?: boolean;
  onPress?: () => void;
  icon?: AppIconName;
  disabled?: boolean;
  accessibilityLabel?: string;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}

const HEIGHT = 32;
const SLOP = (touchTarget - HEIGHT) / 2;

/** Filter, tag and choice chip. Pill-shaped; selected chips take the soft
 * accent tint. Without `onPress` it renders as a static tag. */
export function Chip({ label, selected, onPress, icon, disabled, accessibilityLabel, testID, style }: ChipProps) {
  const { scheme } = useTheme();
  const r = roles(getColors(scheme));
  const fg = selected ? r.onAccentSoft : r.textSecondary;
  const body = (
    <>
      {icon && <AppIcon name={icon} color={fg} size={14} />}
      <Text style={[styles.label, { color: fg }, selected && styles.selectedLabel]} numberOfLines={1}>{label}</Text>
    </>
  );
  const chrome = [styles.chip, { backgroundColor: selected ? r.accentSoft : r.card, borderColor: selected ? 'transparent' : r.line }, style];
  if (!onPress) return <View style={chrome} testID={testID}>{body}</View>;
  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ selected: !!selected, disabled: !!disabled }}
      onPress={onPress}
      disabled={disabled}
      hitSlop={{ top: SLOP, bottom: SLOP, left: 2, right: 2 }}
      testID={testID}
      style={[chrome, disabled && styles.disabled]}
    >
      {body}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  chip: {
    minHeight: HEIGHT, paddingHorizontal: space[3], borderRadius: radius.pill, borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row', alignItems: 'center', gap: space[1], alignSelf: 'flex-start',
  },
  label: { ...type.label },
  selectedLabel: { fontWeight: '600' },
  disabled: { opacity: 0.5 },
});
