/**
 * PermissionsScreen — one-stop view of every OS permission OpenChat may
 * ask for, with a re-request / open-system-settings affordance per row.
 *
 * Today the app asks for four kinds:
 *   - Notifications (push) — used everywhere
 *   - Microphone           — voice messages (OpenChat-xxc)
 *   - Camera               — QR scan (OpenChat-240) + future photo capture
 *   - Photo library        — image attachments (OpenChat-6bg)
 *
 * Per row we show:
 *   - The granted / denied / undetermined status
 *   - A primary CTA appropriate to the state:
 *       undetermined → "Allow" → fires the request prompt
 *       denied       → "Open Settings" → Linking.openSettings()
 *                      (iOS won't re-prompt after a denial; user must flip
 *                       the toggle in Settings → OpenChat manually)
 *       granted      → ✓ checkmark, no CTA
 *
 * Each row re-polls when the screen gains focus so flipping a toggle in
 * iOS Settings and returning to the app updates immediately.
 *
 * Reached via Settings → ABOUT → Permissions row (OpenChat-perms-panel).
 */

import { useCallback, useState } from 'react';
import {
  Linking,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import * as Notifications from 'expo-notifications';
import { Audio } from 'expo-av';
import * as ImagePicker from 'expo-image-picker';
import { Camera } from 'expo-camera';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';
import { registerForPushNotificationsAsync } from '../services/notifications';

type PermissionStatus = 'granted' | 'denied' | 'undetermined' | 'unknown';

interface PermissionRow {
  key: string;
  title: string;
  /** Subtitle describing why we need it. */
  reason: string;
  /** Returns the current status. */
  read: () => Promise<PermissionStatus>;
  /** Trigger the request prompt (only meaningful when status='undetermined'). */
  request: () => Promise<PermissionStatus>;
}

// Bundle of expo-* permissions exposed as a uniform read/request interface.
function buildRows(): PermissionRow[] {
  return [
    {
      key: 'notifications',
      title: 'Notifications',
      reason: 'New-message pings, mentions, group invites',
      read: async () => {
        if (Platform.OS === 'web') return 'unknown';
        const s = await Notifications.getPermissionsAsync();
        return s.status as PermissionStatus;
      },
      request: async () => {
        // registerForPushNotificationsAsync also POSTs the Expo token to
        // the server, which is what we want anyway.
        await registerForPushNotificationsAsync();
        const s = await Notifications.getPermissionsAsync();
        return s.status as PermissionStatus;
      },
    },
    {
      key: 'microphone',
      title: 'Microphone',
      reason: 'Voice messages',
      read: async () => {
        if (Platform.OS === 'web') return 'unknown';
        const s = await Audio.getPermissionsAsync();
        return s.status as PermissionStatus;
      },
      request: async () => {
        const s = await Audio.requestPermissionsAsync();
        return s.status as PermissionStatus;
      },
    },
    {
      key: 'camera',
      title: 'Camera',
      reason: 'Scan QR codes to add contacts + join groups',
      read: async () => {
        if (Platform.OS === 'web') return 'unknown';
        const s = await Camera.getCameraPermissionsAsync();
        return s.status as PermissionStatus;
      },
      request: async () => {
        const s = await Camera.requestCameraPermissionsAsync();
        return s.status as PermissionStatus;
      },
    },
    {
      key: 'photos',
      title: 'Photo library',
      reason: 'Send images in chats',
      read: async () => {
        if (Platform.OS === 'web') return 'unknown';
        const s = await ImagePicker.getMediaLibraryPermissionsAsync();
        return s.status as PermissionStatus;
      },
      request: async () => {
        const s = await ImagePicker.requestMediaLibraryPermissionsAsync();
        return s.status as PermissionStatus;
      },
    },
  ];
}

export function PermissionsScreen() {
  const { scheme } = useTheme();
  const c = getColors(scheme);

  const [statuses, setStatuses] = useState<Record<string, PermissionStatus>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const rows = buildRows();

  const refreshAll = useCallback(async () => {
    const next: Record<string, PermissionStatus> = {};
    for (const r of rows) {
      try {
        next[r.key] = await r.read();
      } catch {
        next[r.key] = 'unknown';
      }
    }
    setStatuses(next);
  }, []); // rows is stable

  useFocusEffect(useCallback(() => { void refreshAll(); }, [refreshAll]));

  const handleRow = async (row: PermissionRow) => {
    const status = statuses[row.key];
    if (busy) return;
    if (status === 'granted') return;

    setBusy(row.key);
    try {
      if (status === 'denied') {
        // iOS won't re-prompt after a denial — only path is the system Settings app.
        void Linking.openSettings();
      } else {
        const next = await row.request();
        setStatuses((prev) => ({ ...prev, [row.key]: next }));
      }
    } finally {
      setBusy(null);
    }
  };

  if (Platform.OS === 'web') {
    return (
      <View style={[styles.root, { backgroundColor: c.background, alignItems: 'center', justifyContent: 'center', padding: 32 }]}>
        <Text style={{ color: c.textPrimary, fontSize: 17, fontWeight: '600', marginBottom: 8 }}>Not applicable on web</Text>
        <Text style={{ color: c.textSecondary, fontSize: 14, textAlign: 'center' }}>
          The browser manages permissions per-tab. Use your browser's site settings to control camera, microphone, and notifications.
        </Text>
      </View>
    );
  }

  return (
    <ScrollView style={[styles.root, { backgroundColor: c.background }]} contentContainerStyle={styles.content}>
      <Text style={[styles.intro, { color: c.textSecondary }]}>
        Each permission is requested when first needed. Tap a row to grant, or open system Settings if previously denied.
      </Text>

      {rows.map((row, i) => {
        const status = statuses[row.key];
        const cta =
          status === 'granted'   ? null
        : status === 'denied'    ? 'Open Settings'
        : status === 'undetermined' ? 'Allow'
        :                          'Allow';
        return (
          <TouchableOpacity
            key={row.key}
            style={[
              styles.row,
              {
                backgroundColor: c.surface,
                borderColor: c.border,
                borderBottomWidth: i === rows.length - 1 ? StyleSheet.hairlineWidth : 0,
                borderTopWidth: i === 0 ? StyleSheet.hairlineWidth : 0,
              },
            ]}
            onPress={() => void handleRow(row)}
            disabled={!!busy || status === 'granted'}
            activeOpacity={0.7}
          >
            <View style={{ flex: 1 }}>
              <Text style={[styles.title, { color: c.textPrimary }]}>{row.title}</Text>
              <Text style={[styles.reason, { color: c.textSecondary }]}>{row.reason}</Text>
              <Text style={[styles.status, { color: status === 'granted' ? c.primary : c.textMuted }]}>
                Status: {status ?? 'checking…'}
              </Text>
            </View>
            {cta && (
              <Text style={[styles.cta, { color: status === 'denied' ? c.textPrimary : c.primary }]}>
                {busy === row.key ? '…' : cta}
              </Text>
            )}
            {!cta && (
              <Text style={[styles.cta, { color: c.primary, fontSize: 18 }]}>✓</Text>
            )}
          </TouchableOpacity>
        );
      })}

      <Text style={[styles.footer, { color: c.textMuted }]}>
        iOS will only show the system permission prompt once per install. If you tapped "Don't Allow" earlier, use Open Settings to re-enable.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { padding: 16, paddingBottom: 32 },
  intro: { fontSize: 13, lineHeight: 18, marginBottom: 14 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 14,
    gap: 10,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderRightWidth: StyleSheet.hairlineWidth,
  },
  title: { fontSize: 16, fontWeight: '600' },
  reason: { fontSize: 12, marginTop: 2 },
  status: { fontSize: 11, marginTop: 4, fontFamily: 'Courier' },
  cta: { fontSize: 14, fontWeight: '600' },
  footer: { fontSize: 11, marginTop: 18, lineHeight: 16 },
});
