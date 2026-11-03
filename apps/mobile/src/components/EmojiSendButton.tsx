/**
 * EmojiSendButton (OpenChat-3aiu) — the chat's emoji where Send would be when
 * the composer is empty. Tap sends it; press and hold and it swells, like the
 * Messenger like-button of old. Release sends it at the size reached.
 *
 * Levels follow HOLD_LEVEL_MS in utils/emojiMessage.ts; each crossing gives a
 * light haptic tick so the growth can be felt without looking.
 *
 * The hold must belong to this button until the finger lifts (OpenChat-o6t5).
 * On touch web, react-native-web ends a Pressable's press when the browser's
 * own long-press starts (context menu, text selection, a pan that cancels the
 * touch), ~450 ms in. That fired onPressOut early, so the emoji was sent at
 * size 1-2 while the user was still holding and every later growth step was
 * lost. So: the press cannot be cancelled by an ancestor or the browser
 * (`cancelable={false}`), a long press is claimed (`onLongPress`, which also
 * makes react-native-web suppress the touch context menu), the glyph is not
 * selectable, and on web the browser may not pan, select or show a callout.
 */

import { useEffect, useRef } from 'react';
import { Animated, Easing, Platform, Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { hapticGrowTick } from '../services/haptics';
import { type } from '../theme/tokens';
import { HOLD_LEVEL_MS, MAX_EMOJI_SIZE, holdLevelForDuration, holdScaleForDuration } from '../utils/emojiMessage';

interface Props {
  emoji: string;
  disabled?: boolean;
  /** Called on release with the size level reached (1 = tap, up to MAX_EMOJI_SIZE). */
  onSend: (size: number) => void;
}

// The long press is the hold itself; claiming it keeps the browser's away.
const claimLongPress = () => {};

const BASE = 44;
const HOLD_TOTAL_MS = HOLD_LEVEL_MS[HOLD_LEVEL_MS.length - 1];
const MAX_SCALE = holdScaleForDuration(HOLD_TOTAL_MS);

export function EmojiSendButton({ emoji, disabled, onSend }: Props) {
  const scale = useRef(new Animated.Value(1)).current;
  const heldSince = useRef<number | null>(null);
  const level = useRef(1);
  const ticker = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopTicker = () => {
    if (ticker.current) clearInterval(ticker.current);
    ticker.current = null;
  };
  useEffect(() => stopTicker, []);

  const begin = () => {
    if (disabled || heldSince.current !== null) return;
    heldSince.current = Date.now();
    level.current = 1;
    scale.stopAnimation();
    Animated.timing(scale, {
      toValue: MAX_SCALE,
      duration: HOLD_TOTAL_MS,
      easing: Easing.out(Easing.quad),
      useNativeDriver: Platform.OS !== 'web',
    }).start();
    ticker.current = setInterval(() => {
      if (heldSince.current === null) return;
      const next = holdLevelForDuration(Date.now() - heldSince.current);
      if (next !== level.current) {
        level.current = next;
        hapticGrowTick();
      }
      if (next >= MAX_EMOJI_SIZE) stopTicker();
    }, 40);
  };

  const finish = (send: boolean) => {
    stopTicker();
    if (heldSince.current === null) return;
    const heldMs = Date.now() - heldSince.current;
    heldSince.current = null;
    scale.stopAnimation();
    Animated.spring(scale, { toValue: 1, friction: 5, tension: 120, useNativeDriver: Platform.OS !== 'web' }).start();
    if (send) onSend(holdLevelForDuration(heldMs));
  };

  // Grow upward from the button's footprint: a plain scale would spill under
  // the composer row, so lift the emoji as it swells.
  const translateY = scale.interpolate({ inputRange: [1, MAX_SCALE], outputRange: [0, -((MAX_SCALE - 1) * BASE) / 2] });

  return (
    <View style={styles.slot}>
      <Pressable
        onPressIn={begin}
        onPressOut={() => finish(true)}
        onLongPress={claimLongPress}
        cancelable={false}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={`Send ${emoji}`}
        accessibilityHint="Hold to send it bigger"
        hitSlop={6}
        style={[styles.button, Platform.OS === 'web' && webHold, disabled && styles.disabled]}
        testID="emoji-send-button"
      >
        <Animated.View pointerEvents="none" style={{ transform: [{ translateY }, { scale }] }}>
          <Text style={styles.emoji} allowFontScaling={false} selectable={false}>{emoji}</Text>
        </Animated.View>
      </Pressable>
    </View>
  );
}

// Web only: no panning, text selection or iOS callout may take the touch over.
// react-native-web passes these straight through as CSS.
const webHold = {
  touchAction: 'none',
  userSelect: 'none',
  WebkitUserSelect: 'none',
  WebkitTouchCallout: 'none',
} as unknown as ViewStyle;

const styles = StyleSheet.create({
  // overflow stays visible so the swelling emoji can rise above the composer.
  slot: { width: BASE, height: BASE, zIndex: 20, elevation: 20 },
  button: { width: BASE, height: BASE, alignItems: 'center', justifyContent: 'center' },
  disabled: { opacity: 0.4 },
  emoji: { ...type.display, fontWeight: '400', letterSpacing: 0, textAlign: 'center' },
});
