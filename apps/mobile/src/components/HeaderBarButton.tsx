import type { ReactNode } from 'react';
import { StyleSheet, TouchableOpacity, type StyleProp, type ViewStyle } from 'react-native';

/**
 * Height of anything rendered in a native-stack `headerLeft` / `headerRight`.
 *
 * iOS 26 gives a bar button's custom view a 36pt slot inside its 44pt Liquid
 * Glass capsule and pins taller views to the top of that slot. With
 * react-native-screens < 4.19 (no centering wrapper, upstream PR #3449) a 44pt
 * button therefore renders 4pt below the capsule's center — the recurring
 * "icons sit low in their pill" bug. Keep header content at exactly this
 * height and extend the tap target with `hitSlop` instead of `minHeight: 44`.
 */
export const HEADER_BAR_ITEM_HEIGHT = 36;

const HEADER_HIT_SLOP = { top: 4, bottom: 4, left: 4, right: 4 };

interface HeaderBarButtonProps {
  onPress: () => void;
  accessibilityLabel: string;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}

/** Tappable native-header item sized to stay centered in the iOS 26 glass capsule. */
export function HeaderBarButton({ onPress, accessibilityLabel, children, style }: HeaderBarButtonProps) {
  return (
    <TouchableOpacity
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      hitSlop={HEADER_HIT_SLOP}
      style={[styles.button, style]}
    >
      {children}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  button: {
    height: HEADER_BAR_ITEM_HEIGHT,
    minWidth: 44,
    paddingHorizontal: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
