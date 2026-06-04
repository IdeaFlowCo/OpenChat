/**
 * PushSoftAsk — soft permission request card (OpenChat-9mo).
 *
 * Shown once, 5 seconds after the user signs in, if they haven't been asked
 * before (AsyncStorage key `openchat_push_softasked`). "Turn on" calls
 * registerForPushNotificationsAsync(); "Not now" just closes the card.
 * Either button sets the flag so the card never appears again.
 *
 * Settings → Notifications is the recovery path if the user changes their mind.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';
import { registerForPushNotificationsAsync } from '../services/notifications';

const SOFT_ASK_KEY = 'openchat_push_softasked';
const SHOW_DELAY_MS = 5000;

interface Props {
  /** Whether the user is currently authenticated. */
  isAuthed: boolean;
}

export function PushSoftAsk({ isAuthed }: Props) {
  const { scheme } = useTheme();
  const c = getColors(scheme);
  const [visible, setVisible] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const opacity = useRef(new Animated.Value(0)).current;

  const dismiss = useCallback(async () => {
    Animated.timing(opacity, {
      toValue: 0,
      duration: 200,
      useNativeDriver: true,
    }).start(() => setVisible(false));
    try {
      await AsyncStorage.setItem(SOFT_ASK_KEY, '1');
    } catch {
      /* ignore */
    }
  }, [opacity]);

  const handleTurnOn = useCallback(async () => {
    await dismiss();
    try {
      await registerForPushNotificationsAsync();
    } catch {
      /* ignore */
    }
  }, [dismiss]);

  useEffect(() => {
    if (!isAuthed) {
      // Clear any pending timer when user logs out.
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      return;
    }

    // Don't show on web.
    if (Platform.OS === 'web') return;

    // Check whether we've already asked.
    AsyncStorage.getItem(SOFT_ASK_KEY).then((val) => {
      if (val) return; // already asked
      timerRef.current = setTimeout(async () => {
        timerRef.current = null;
        // Re-check in case something else set the flag during the delay.
        const v = await AsyncStorage.getItem(SOFT_ASK_KEY).catch(() => null);
        if (v) return;
        setVisible(true);
        Animated.timing(opacity, {
          toValue: 1,
          duration: 300,
          useNativeDriver: true,
        }).start();
      }, SHOW_DELAY_MS);
    }).catch(() => {
      /* ignore storage errors */
    });

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [isAuthed, opacity]);

  if (!visible) return null;

  return (
    <Animated.View style={[styles.wrap, { opacity }]}>
      <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }]}>
        <Text style={[styles.title, { color: c.textPrimary }]}>
          Stay in the loop
        </Text>
        <Text style={[styles.body, { color: c.textSecondary }]}>
          Turn on notifications to see new messages even when the app is closed.
        </Text>
        <View style={styles.buttons}>
          <TouchableOpacity
            style={[styles.btn, styles.btnSecondary, { borderColor: c.border }]}
            onPress={dismiss}
            accessibilityLabel="Not now"
          >
            <Text style={{ color: c.textSecondary, fontWeight: '500' }}>Not now</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.btn, styles.btnPrimary, { backgroundColor: c.primary }]}
            onPress={handleTurnOn}
            accessibilityLabel="Turn on notifications"
          >
            <Text style={{ color: '#fff', fontWeight: '600' }}>Turn on</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    bottom: 100,
    left: 16,
    right: 16,
    zIndex: 999,
  },
  card: {
    borderRadius: 14,
    borderWidth: 1,
    padding: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.12,
    shadowRadius: 12,
    elevation: 6,
  },
  title: {
    fontSize: 17,
    fontWeight: '700',
    marginBottom: 6,
  },
  body: {
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 16,
  },
  buttons: {
    flexDirection: 'row',
    gap: 10,
    justifyContent: 'flex-end',
  },
  btn: {
    paddingHorizontal: 16,
    paddingVertical: 9,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnSecondary: {
    borderWidth: 1,
  },
  btnPrimary: {
    minWidth: 90,
  },
});
