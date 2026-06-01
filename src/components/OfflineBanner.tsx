/**
 * Thin yellow strip shown below the nav header when the socket has been
 * disconnected for more than 5 seconds (OpenChat-5ay).
 *
 * Subscribes to ChatContext.isConnected. Renders nothing while connected or
 * within the 5-second grace window (avoids flashing on brief blips).
 */

import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useChat } from '../contexts/ChatContext';

const DELAY_MS = 5000;

export function OfflineBanner() {
  const { isConnected, isAuthed } = useChat();
  const [showBanner, setShowBanner] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  if (!showBanner) return null;

  return (
    <View style={styles.banner}>
      <Text style={styles.text}>You're offline — reconnecting…</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    backgroundColor: '#ca8a04', // yellow-600 — visible in both light + dark
    paddingVertical: 6,
    paddingHorizontal: 16,
    alignItems: 'center',
  },
  text: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '500',
  },
});
