import type { ReactNode } from 'react';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { useTheme } from '../../contexts/ThemeContext';
import { getColors } from '../../theme/colors';
import { roles, space, type } from '../../theme/tokens';
import { AppIcon, type AppIconName } from '../AppIcon';

export interface SectionLabelProps {
  children: string;
  /** Small glyph before the label, e.g. `lock` on the private layer. */
  icon?: AppIconName;
  /** Right-aligned action, usually a small ghost Button. */
  trailing?: ReactNode;
  /** Drop the top margin for the first section on a screen. */
  first?: boolean;
  style?: StyleProp<ViewStyle>;
}

/** Uppercase eyebrow above a group: 24 above, 8 below. */
export function SectionLabel({ children, icon, trailing, first, style }: SectionLabelProps) {
  const { scheme } = useTheme();
  const r = roles(getColors(scheme));
  return (
    <View style={[styles.row, first && styles.first, style]}>
      <View style={styles.label}>
        {icon && <AppIcon name={icon} color={r.textMeta} size={12} strokeWidth={2.4} />}
        <Text accessibilityRole="header" style={[type.eyebrow, { color: r.textMeta }]}>{children}</Text>
      </View>
      {trailing}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: space[6], marginBottom: space[2], minHeight: 20 },
  first: { marginTop: 0 },
  label: { flexDirection: 'row', alignItems: 'center', gap: space[1] + 2 },
});
