/**
 * EmojiSendButton (OpenChat-3aiu) — the chat's emoji where Send would be when
 * the composer is empty. Tap sends it; press and hold and it swells, like the
 * Messenger like-button of old. Release sends it at the size reached.
 *
 * Levels follow HOLD_LEVEL_MS in utils/emojiMessage.ts; each crossing gives a
 * light haptic tick so the growth can be felt without looking.
 *
 */

import { useCallback, useEffect, useRef } from 'react';
import { Animated, Easing, Platform, Pressable, StyleSheet, Text, View, type ViewStyle, type GestureResponderEvent } from 'react-native';
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
  const removePointerListeners = useRef<(() => void) | null>(null);
  const activeInput = useRef<'pointer' | 'keyboard' | 'native' | null>(null);
  const beginRef = useRef<() => void>(() => {});
  const finishRef = useRef<(send: boolean) => void>(() => {});
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;

  const buttonRef = useCallback((node: View | null) => {
    if (Platform.OS !== 'web' || !node) return;
    const host = node as unknown as HTMLElement;
    const pointerDown = (event: PointerEvent) => {
      if (disabledRef.current || heldSince.current !== null || (event.pointerType === 'mouse' && event.button !== 0)) return;
      const pointerId = event.pointerId;
      activeInput.current = 'pointer';
      beginRef.current();
      const release = (e: PointerEvent) => { if (e.pointerId === pointerId) finishRef.current(true); };
      const blur = () => finishRef.current(true);
      const visibility = () => { if (document.visibilityState === 'hidden') finishRef.current(true); };
      window.addEventListener('pointerup', release);
      window.addEventListener('pointercancel', release);
      host.addEventListener('lostpointercapture', release);
      window.addEventListener('blur', blur);
      document.addEventListener('visibilitychange', visibility);
      removePointerListeners.current = () => {
        removePointerListeners.current = null;
        window.removeEventListener('pointerup', release);
        window.removeEventListener('pointercancel', release);
        host.removeEventListener('lostpointercapture', release);
        window.removeEventListener('blur', blur);
        document.removeEventListener('visibilitychange', visibility);
        try { host.releasePointerCapture(pointerId); } catch {}
      };
      try { host.setPointerCapture(pointerId); } catch {}
    };
    host.addEventListener('pointerdown', pointerDown);
    return () => {
      host.removeEventListener('pointerdown', pointerDown);
      removePointerListeners.current?.();
    };
  }, []);

  const stopTicker = () => {
    if (ticker.current) clearInterval(ticker.current);
    ticker.current = null;
  };
  useEffect(() => () => {
    stopTicker();
    removePointerListeners.current?.();
  }, []);

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
    removePointerListeners.current?.();
    stopTicker();
    if (heldSince.current === null) return;
    const heldMs = Date.now() - heldSince.current;
    heldSince.current = null;
    activeInput.current = null;
    scale.stopAnimation();
    Animated.spring(scale, { toValue: 1, friction: 5, tension: 120, useNativeDriver: Platform.OS !== 'web' }).start();
    if (send) onSend(holdLevelForDuration(heldMs));
  };

  beginRef.current = begin;
  finishRef.current = finish;

  const keyboardEvent = (event: GestureResponderEvent) => {
    const wrapped = event as unknown as { nativeEvent?: { type?: string; key?: string }; type?: string; key?: string };
    const native = wrapped.nativeEvent ?? wrapped;
    return native.type === 'keydown' || native.type === 'keyup' || native.key != null;
  };

  // Grow upward from the button's footprint: a plain scale would spill under
  // the composer row, so lift the emoji as it swells.
  const translateY = scale.interpolate({ inputRange: [1, MAX_SCALE], outputRange: [0, -((MAX_SCALE - 1) * BASE) / 2] });

  return (
    <View style={styles.slot}>
      <Pressable
        ref={buttonRef}
        onPressIn={(event) => {
          if (Platform.OS === 'web' && !keyboardEvent(event)) return;
          if (heldSince.current !== null || disabled) return;
          activeInput.current = Platform.OS === 'web' ? 'keyboard' : 'native';
          begin();
        }}
        onPressOut={(event) => {
          if (Platform.OS === 'web' && (!keyboardEvent(event) || activeInput.current !== 'keyboard')) return;
          finish(true);
        }}
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
