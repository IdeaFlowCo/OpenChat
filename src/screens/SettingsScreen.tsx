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
import { Alert, Linking, Modal, Platform, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { useFocusEffect } from '@react-navigation/native';
import { useNavigation } from '@react-navigation/native';
import { useTheme, ThemePref } from '../contexts/ThemeContext';
import { useChat } from '../contexts/ChatContext';
import { api } from '../api/client';
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

  // Account deletion (OpenChat-nhy)
  const [deleteModalVisible, setDeleteModalVisible] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [deleting, setDeleting] = useState(false);

  const handleDeleteAccount = useCallback(() => {
    // First confirmation alert
    Alert.alert(
      'Delete your account?',
      'This deletes your profile and replaces your sent messages with \'Message deleted\'. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            // Second confirmation: iOS uses Alert.prompt; Android uses modal
            if (Platform.OS === 'ios') {
              Alert.prompt(
                'Type DELETE to confirm',
                'Enter DELETE to permanently delete your account.',
                async (input) => {
                  if (input !== 'DELETE') return;
                  setDeleting(true);
                  try {
                    await api.deleteAccount();
                    await signOut();
                  } catch (err) {
                    Alert.alert('Error', err instanceof Error ? err.message : 'Failed to delete account.');
                  } finally {
                    setDeleting(false);
                  }
                },
                'plain-text'
              );
            } else {
              // Android fallback: modal with TextInput
              setDeleteConfirmText('');
              setDeleteModalVisible(true);
            }
          },
        },
      ]
    );
  }, [signOut]);

  const handleDeleteConfirmAndroid = useCallback(async () => {
    if (deleteConfirmText !== 'DELETE') {
      Alert.alert('Incorrect', 'You must type DELETE exactly.');
      return;
    }
    setDeleteModalVisible(false);
    setDeleting(true);
    try {
      await api.deleteAccount();
      await signOut();
    } catch (err) {
      Alert.alert('Error', err instanceof Error ? err.message : 'Failed to delete account.');
    } finally {
      setDeleting(false);
    }
  }, [deleteConfirmText, signOut]);

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
          <Text style={[styles.sectionLabel, { color: c.textSecondary }]}>ACCOUNT</Text>
          <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }]}>
            {/* Edit profile (OpenChat-tml) */}
            <TouchableOpacity
              style={[styles.optionRow, { borderBottomColor: c.divider, borderBottomWidth: StyleSheet.hairlineWidth }]}
              onPress={() => navigation.navigate('ProfileEdit')}
              activeOpacity={0.7}
            >
              <View style={{ flex: 1 }}>
                <Text style={[styles.optionLabel, { color: c.textPrimary }]}>Edit profile</Text>
                <Text style={[styles.optionHint, { color: c.textSecondary }]}>
                  {currentUser.name ? currentUser.name : 'Set your display name'}
                </Text>
              </View>
              <Text style={{ color: c.textMuted, fontSize: 18 }}>›</Text>
            </TouchableOpacity>
            <View style={[styles.optionRow]}>
              <Text style={[styles.optionLabel, { color: c.textPrimary, flex: 1 }]}>{currentUser.email}</Text>
            </View>
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
              style={[
                styles.optionRow,
                { borderTopColor: c.divider, borderTopWidth: StyleSheet.hairlineWidth },
              ]}
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
          {/* Blocked users — OpenChat-46p */}
          <TouchableOpacity
            style={[
              styles.optionRow,
              { borderTopColor: c.divider, borderTopWidth: StyleSheet.hairlineWidth },
            ]}
            onPress={() => navigation.navigate('BlockedUsers')}
            activeOpacity={0.7}
          >
            <View style={{ flex: 1 }}>
              <Text style={[styles.optionLabel, { color: c.textPrimary }]}>Blocked users</Text>
              <Text style={[styles.optionHint, { color: c.textSecondary }]}>
                Manage who you've blocked
              </Text>
            </View>
            <Text style={{ color: c.textMuted, fontSize: 18 }}>›</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* About / web version */}
      <View style={styles.section}>
        <Text style={[styles.sectionLabel, { color: c.textSecondary }]}>ABOUT</Text>
        <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }]}>
          <TouchableOpacity
            style={styles.optionRow}
            onPress={() => Linking.openURL('https://chat.globalbr.ai/m/')}
            activeOpacity={0.7}
          >
            <View style={{ flex: 1 }}>
              <Text style={[styles.optionLabel, { color: c.textPrimary }]}>Visit web version</Text>
              <Text style={[styles.optionHint, { color: c.textSecondary }]}>
                chat.globalbr.ai · open OpenChat in any browser
              </Text>
            </View>
            <Text style={{ color: c.textMuted, fontSize: 18 }}>›</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Legal & Account section (OpenChat-nhy + OpenChat-wfz) */}
      <View style={styles.section}>
        <Text style={[styles.sectionLabel, { color: c.textSecondary }]}>LEGAL & ACCOUNT</Text>
        <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }]}>
          {/* Privacy Policy (OpenChat-wfz) */}
          <TouchableOpacity
            style={[styles.optionRow, { borderBottomColor: c.divider, borderBottomWidth: StyleSheet.hairlineWidth }]}
            onPress={() => Linking.openURL('https://chat.globalbr.ai/legal/privacy')}
            activeOpacity={0.7}
          >
            <Text style={[styles.optionLabel, { color: c.textPrimary, flex: 1 }]}>Privacy Policy</Text>
            <Text style={{ color: c.textMuted, fontSize: 18 }}>›</Text>
          </TouchableOpacity>

          {/* Terms of Service (OpenChat-wfz) */}
          <TouchableOpacity
            style={[styles.optionRow, { borderBottomColor: c.divider, borderBottomWidth: StyleSheet.hairlineWidth }]}
            onPress={() => Linking.openURL('https://chat.globalbr.ai/legal/terms')}
            activeOpacity={0.7}
          >
            <Text style={[styles.optionLabel, { color: c.textPrimary, flex: 1 }]}>Terms of Service</Text>
            <Text style={{ color: c.textMuted, fontSize: 18 }}>›</Text>
          </TouchableOpacity>

          {/* Delete account (OpenChat-nhy) */}
          <TouchableOpacity
            style={styles.optionRow}
            onPress={handleDeleteAccount}
            disabled={deleting}
            activeOpacity={0.7}
          >
            <Text style={[styles.optionLabel, { color: c.danger, flex: 1 }]}>
              {deleting ? 'Deleting…' : 'Delete my account'}
            </Text>
          </TouchableOpacity>
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

      <Text style={[styles.versionFooter, { color: c.textMuted }]}>
        OpenChat mobile · v{Constants.expoConfig?.version ?? '?'}
        {Platform.OS !== 'web' && ` (${Constants.expoConfig?.ios?.buildNumber ?? Constants.expoConfig?.android?.versionCode ?? '?'})`}
      </Text>

      {/* Android delete-account confirmation modal (fallback for platforms without Alert.prompt) */}
      <Modal
        visible={deleteModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setDeleteModalVisible(false)}
      >
        <View style={styles.modalBackdrop}>
          <View style={[styles.modalCard, { backgroundColor: c.surface, borderColor: c.border }]}>
            <Text style={[styles.modalTitle, { color: c.textPrimary }]}>Confirm account deletion</Text>
            <Text style={[styles.modalBody, { color: c.textSecondary }]}>
              Type DELETE (all caps) to permanently delete your account.
            </Text>
            <TextInput
              style={[styles.modalInput, { backgroundColor: c.surfaceElevated, borderColor: c.border, color: c.textPrimary }]}
              value={deleteConfirmText}
              onChangeText={setDeleteConfirmText}
              placeholder="DELETE"
              placeholderTextColor={c.textMuted}
              autoCapitalize="characters"
              autoCorrect={false}
            />
            <View style={styles.modalButtons}>
              <TouchableOpacity
                style={[styles.modalBtn, { borderColor: c.border, borderWidth: 1 }]}
                onPress={() => setDeleteModalVisible(false)}
              >
                <Text style={{ color: c.textPrimary, fontWeight: '600' }}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalBtn, { backgroundColor: c.danger }]}
                onPress={handleDeleteConfirmAndroid}
              >
                <Text style={{ color: '#fff', fontWeight: '600' }}>Delete</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
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
  // Android delete-account confirmation modal styles
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  modalCard: {
    width: '100%',
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 20,
    gap: 12,
  },
  modalTitle: { fontSize: 17, fontWeight: '700' },
  modalBody: { fontSize: 14, lineHeight: 20 },
  modalInput: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    fontSize: 16,
  },
  modalButtons: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 4,
  },
  modalBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
});
