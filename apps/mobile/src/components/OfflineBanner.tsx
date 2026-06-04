/**
 * Thin yellow strip shown below the device status bar / notch when the socket
 * has been disconnected for more than 3 seconds (OpenChat-5ay, OpenChat-7wy).
 *
 * Subscribes to ChatContext.isConnected. Renders nothing while connected or
 * within the grace window (avoids flashing on brief blips).
 *
 * Layout (OpenChat-7wy):
 *   - Mounted globally above the navigator in App.tsx, so the colored strip
 *     pushes the nav header down rather than overlapping it (matches iOS
 *     Messages / WhatsApp "Connecting…" behavior).
 *   - Uses `useSafeAreaInsets()` to pad the top by `insets.top`, so the
 *     coloured background fills the area behind the notch / Dynamic Island
 *     / status bar and the text sits cleanly in the standard slot just
 *     beneath it. No more bar-behind-the-notch.
 *   - Slides + fades in/out rather than popping, so brief network blips
 *     don't feel jarring.
 *   - On web there are no notches; insets are 0 and the bar simply sits at
 *     the top of the viewport above the navigator — same visual slot.
 */

import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, Text } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useChat } from '../contexts/ChatContext';

const DELAY_MS = 3000;
const ANIM_MS = 220;

export function OfflineBanner() {
  const { isConnected, isAuthed } = useChat();
  const insets = useSafeAreaInsets();
  const [showBanner, setShowBanner] = useState(false);
  const [mounted, setMounted] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(-12)).current;

  useEffect(() => {
    // Don't show on the Login screen — there's no socket connection pre-auth,
    // so "offline" is meaningless there. The banner is for confirming the
    // chat connection is healthy *after* sign-in.
    if (!isAuthed) {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      setShowBanner(false);
      return;
    }
    if (isConnected) {
      // Clear any pending show timer and hide immediately.
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      setShowBanner(false);
    } else {
      // Only show the banner after the grace period has elapsed.
      timerRef.current = setTimeout(() => {
        setShowBanner(true);
        timerRef.current = null;
      }, DELAY_MS);
    }
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [isConnected, isAuthed]);

  // Drive fade + slide animation. Mount the view eagerly when we want to
  // show, unmount AFTER the exit animation finishes (avoids the layout pop).
  useEffect(() => {
    if (showBanner) {
      setMounted(true);
      Animated.parallel([
        Animated.timing(opacity, {
          toValue: 1,
          duration: ANIM_MS,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(translateY, {
          toValue: 0,
          duration: ANIM_MS,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
      ]).start();
    } else if (mounted) {
      Animated.parallel([
        Animated.timing(opacity, {
          toValue: 0,
          duration: ANIM_MS,
          easing: Easing.in(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(translateY, {
          toValue: -12,
          duration: ANIM_MS,
          easing: Easing.in(Easing.cubic),
          useNativeDriver: true,
        }),
      ]).start(({ finished }) => {
        if (finished) setMounted(false);
      });
    }
  }, [showBanner, mounted, opacity, translateY]);

  if (!mounted) return null;

  return (
    <Animated.View
      style={[
        styles.banner,
        {
          // Pad above the strip so the colored background fills the area
          // behind the notch / Dynamic Island / status bar. Text sits in
          // the standard slot just beneath. Matches iOS Messages pattern.
          paddingTop: insets.top + 6,
          opacity,
          transform: [{ translateY }],
        },
      ]}
    >
      <Text style={styles.text} accessibilityRole="text" accessibilityLiveRegion="polite">
        Offline. Sending and downloads are paused while OpenChat reconnects.
      </Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  banner: {
    backgroundColor: '#ca8a04', // yellow-600 — visible in both light + dark
    paddingBottom: 6,
    paddingHorizontal: 16,
    alignItems: 'center',
  },
  text: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '500',
  },
});
