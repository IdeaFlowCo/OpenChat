import type { ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { useTheme } from '../../contexts/ThemeContext';
import { getColors } from '../../theme/colors';
import { radius, roles, space } from '../../theme/tokens';

export interface CardProps {
  children?: ReactNode;
  /** `none` lets list rows run edge to edge inside the card. */
  padding?: 'none' | 'md' | 'lg';
  /** Marks the viewer-only layer (private notes): a faint accent tint. */
  tone?: 'default' | 'private';
  style?: StyleProp<ViewStyle>;
  testID?: string;
  accessibilityLabel?: string;
}

/** The one card: one radius, one hairline, one padding, no shadow. */
export function Card({ children, padding = 'md', tone = 'default', style, testID, accessibilityLabel }: CardProps) {
  const { scheme } = useTheme();
  const r = roles(getColors(scheme));
  return (
    <View
      testID={testID}
      accessibilityLabel={accessibilityLabel}
      style={[
        styles.card,
        { backgroundColor: r.card, borderColor: r.line },
        padding === 'md' && styles.md,
        padding === 'lg' && styles.lg,
        tone === 'private' && { borderColor: r.accentSoft },
        style,
      ]}
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  md: { padding: space[3] },
  lg: { padding: space[4] },
});
