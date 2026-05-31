/**
 * Settings screen — for now just the theme toggle (OpenChat-bji), expo-
 * secure-store status (OpenChat-ghr), notifications permission UI
 * (OpenChat-jzc), and a sign-out button. Reached via a gear icon in the
 * Conversations header.
 *
 * Designed so the surface is easy to extend: add a new row, the screen
 * just grows downward.
 */

import { useCallback, useState } from 'react';
import { Linking, Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import * as Notifications from 'expo-notifications';
import { useFocusEffect } from '@react-navigation/native';
import { useNavigation } from '@react-navigation/native';
import { useTheme, ThemePref } from '../contexts/ThemeContext';
import { useChat } from '../contexts/ChatContext';
import { getColors } from '../theme/colors';
import type { NavProp } from '../navigation/types';
import { registerForPushNotificationsAsync } from '../services/notifications';

const OPTIONS: { value: ThemePref; label: string; hint: string }[] = [
  { value: 'system', label: 'System', hint: 'Follow your phone' },
  { value: 'light', label: 'Light', hint: '' },
  { value: 'dark', label: 'Dark', hint: '' },
];

type NotifStatus = 'granted' | 'denied' | 'undetermined' | 'unknown';

export function SettingsScreen() {
  const navigation = useNavigation<NavProp<'Settings'>>();
  const { preference, setPreference, scheme } = useTheme();
  const { currentUser, signOut } = useChat();
  const c = getColors(scheme);

  // Notification permission status — re-polled whenever this screen gains
  // focus, so if the user toggles iOS Settings → OpenChat → Notifications
  // and returns to the app, we reflect the new state without a restart.
  const [notifStatus, setNotifStatus] = useState<NotifStatus>('unknown');
  const refreshNotif = useCallback(async () => {
    if (Platform.OS === 'web') return;
    try {
      const s = await Notifications.getPermissionsAsync();
      // expo-notifications PermissionStatus is one of granted/denied/undetermined.
      setNotifStatus(s.status as NotifStatus);
    } catch {
      setNotifStatus('unknown');
    }
  }, []);
  useFocusEffect(useCallback(() => { void refreshNotif(); }, [refreshNotif]));

  const handleEnableNotifications = useCallback(async () => {
    // First-time path (undetermined): triggers the iOS prompt via
    // registerForPushNotificationsAsync, which also POSTs the resulting
    // Expo token to the server. Refresh the displayed status after.
    await registerForPushNotificationsAsync();
    await refreshNotif();
  }, [refreshNotif]);

  const handleOpenSystemSettings = useCallback(() => {
    // iOS won't re-prompt after denial — user has to flip the toggle in
    // iOS Settings → OpenChat → Notifications. Deep-link them there.
    void Linking.openSettings();
  }, []);

  return (
    <View style={[styles.root, { backgroundColor: c.background }]}>
      {currentUser && (
        <View style={styles.section}>
          <Text style={[styles.sectionLabel, { color: c.textSecondary }]}>SIGNED IN AS</Text>
          <View style={[styles.row, { backgroundColor: c.surface, borderColor: c.border }]}>
            <Text style={[styles.rowText, { color: c.textPrimary }]}>{currentUser.email}</Text>
          </View>
        </View>
      )}

      <View style={styles.section}>
        <Text style={[styles.sectionLabel, { color: c.textSecondary }]}>APPEARANCE</Text>
        <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }]}>
          {OPTIONS.map((opt, i) => {
            const selected = preference === opt.value;
            return (
              <TouchableOpacity
                key={opt.value}
                style={[
                  styles.optionRow,
                  i < OPTIONS.length - 1 && { borderBottomColor: c.divider, borderBottomWidth: StyleSheet.hairlineWidth },
                ]}
                onPress={() => setPreference(opt.value)}
                activeOpacity={0.7}
              >
                <View style={{ flex: 1 }}>
                  <Text style={[styles.optionLabel, { color: c.textPrimary }]}>{opt.label}</Text>
                  {opt.hint ? (
                    <Text style={[styles.optionHint, { color: c.textSecondary }]}>{opt.hint}</Text>
                  ) : null}
                </View>
                <View style={[styles.radio, { borderColor: selected ? c.primary : c.border }]}>
                  {selected && <View style={[styles.radioDot, { backgroundColor: c.primary }]} />}
                </View>
              </TouchableOpacity>
            );
          })}
        </View>
      </View>

      {Platform.OS !== 'web' && (
        <View style={styles.section}>
          <Text style={[styles.sectionLabel, { color: c.textSecondary }]}>NOTIFICATIONS</Text>
          <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }]}>
            {notifStatus === 'granted' && (
              <View style={[styles.optionRow, styles.notifRow]}>
                <Text style={[styles.optionLabel, { color: c.textPrimary, flex: 1 }]}>Notifications are on</Text>
                <Text style={{ color: c.primary, fontSize: 18 }}>✓</Text>
              </View>
            )}
            {notifStatus === 'undetermined' && (
              <TouchableOpacity
                style={[styles.optionRow, styles.notifRow]}
                onPress={handleEnableNotifications}
                activeOpacity={0.7}
              >
                <View style={{ flex: 1 }}>
                  <Text style={[styles.optionLabel, { color: c.primary }]}>Enable notifications</Text>
                  <Text style={[styles.optionHint, { color: c.textSecondary }]}>Get pinged when you receive a message</Text>
                </View>
              </TouchableOpacity>
            )}
            {notifStatus === 'denied' && (
              <TouchableOpacity
                style={[styles.optionRow, styles.notifRow]}
                onPress={handleOpenSystemSettings}
                activeOpacity={0.7}
              >
                <View style={{ flex: 1 }}>
                  <Text style={[styles.optionLabel, { color: c.textPrimary }]}>Notifications are off</Text>
                  <Text style={[styles.optionHint, { color: c.textSecondary }]}>
                    Tap to open {Platform.OS === 'ios' ? 'iOS' : 'system'} Settings and enable
                  </Text>
                </View>
                <Text style={{ color: c.textMuted, fontSize: 18 }}>›</Text>
              </TouchableOpacity>
            )}
            {(notifStatus === 'unknown' || notifStatus === undefined) && (
              <View style={[styles.optionRow, styles.notifRow]}>
                <Text style={[styles.optionLabel, { color: c.textMuted, flex: 1 }]}>Checking…</Text>
              </View>
            )}
          </View>
        </View>
      )}

      <View style={styles.section}>
        <Text style={[styles.sectionLabel, { color: c.textSecondary }]}>CONTACTS</Text>
        <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }]}>
          <TouchableOpacity
            style={[
              styles.optionRow,
              { borderBottomColor: c.divider, borderBottomWidth: StyleSheet.hairlineWidth },
            ]}
            onPress={() => navigation.navigate('MyQrCode')}
            activeOpacity={0.7}
          >
            <View style={{ flex: 1 }}>
              <Text style={[styles.optionLabel, { color: c.textPrimary }]}>My QR code</Text>
              <Text style={[styles.optionHint, { color: c.textSecondary }]}>
                Let others add you by scanning
              </Text>
            </View>
            <Text style={{ color: c.textMuted, fontSize: 18 }}>›</Text>
          </TouchableOpacity>
          {Platform.OS !== 'web' && (
            <TouchableOpacity
              style={styles.optionRow}
              onPress={() => navigation.navigate('ScanQr')}
              activeOpacity={0.7}
            >
              <View style={{ flex: 1 }}>
                <Text style={[styles.optionLabel, { color: c.textPrimary }]}>Scan QR</Text>
                <Text style={[styles.optionHint, { color: c.textSecondary }]}>
                  Add someone by scanning their code
                </Text>
              </View>
              <Text style={{ color: c.textMuted, fontSize: 18 }}>›</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>

      <View style={styles.section}>
        <TouchableOpacity
          style={[styles.dangerBtn, { borderColor: c.danger }]}
          onPress={signOut}
        >
          <Text style={{ color: c.danger, fontWeight: '600', fontSize: 16 }}>Sign out</Text>
        </TouchableOpacity>
      </View>

      <Text style={[styles.versionFooter, { color: c.textMuted }]}>OpenChat mobile · v0.1.0</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, paddingHorizontal: 16, paddingTop: 16 },
  section: { marginBottom: 24 },
  sectionLabel: { fontSize: 11, fontWeight: '700', letterSpacing: 1, marginBottom: 8 },
  row: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
  },
  rowText: { fontSize: 15 },
  card: {
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  optionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  notifRow: { minHeight: 56 },
  optionLabel: { fontSize: 16, fontWeight: '500' },
  optionHint: { fontSize: 12, marginTop: 2 },
  radio: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioDot: { width: 10, height: 10, borderRadius: 5 },
  dangerBtn: {
    paddingVertical: 14,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: 'center',
  },
  versionFooter: { fontSize: 11, textAlign: 'center', marginTop: 8 },
});
