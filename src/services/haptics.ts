/**
 * Haptics helpers for OpenChat (OpenChat-o8m).
 *
 * Wraps expo-haptics with Platform guards so callers don't need to branch.
 * Android's own gesture layer handles haptics for swipe gestures — these
 * helpers are currently active only on iOS.
 *
 * Usage:
 *   hapticSend()    — light impact on successful message send
 *   hapticReceive() — success notification on incoming message (active conv)
 *   hapticSelect()  — selection feedback for reactions (reaction feature TBD)
 */

import { Platform } from 'react-native';
import * as Haptics from 'expo-haptics';

/** Called after a message is successfully sent by the current user. */
export function hapticSend(): void {
  if (Platform.OS !== 'ios') return;
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {
    /* haptics not available on all devices/simulators */
  });
}

/**
 * Called when a new message arrives in the conversation the user is actively
 * viewing. Subtle success notification.
 */
export function hapticReceive(): void {
  if (Platform.OS !== 'ios') return;
  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {
    /* haptics not available on all devices/simulators */
  });
}

/**
 * Selection feedback — used for reactions (not yet shipped).
 * Exported so the reaction component can import it without touching this file.
 */
export function hapticSelect(): void {
  if (Platform.OS !== 'ios') return;
  Haptics.selectionAsync().catch(() => {
    /* haptics not available on all devices/simulators */
  });
}
