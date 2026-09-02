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
import { ActivityIndicator, Alert, Clipboard, Linking, Modal, Platform, ScrollView, Share, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import * as Notifications from 'expo-notifications';
import * as Updates from 'expo-updates';
import Constants from 'expo-constants';
import { useFocusEffect } from '@react-navigation/native';
import { useNavigation } from '@react-navigation/native';
import { useTheme, ThemePref } from '../contexts/ThemeContext';
import { useChat } from '../contexts/ChatContext';
import { api, ExportRangeKey, OPENCHAT_URL } from '../api/client';
import { buildAgentSetupBlob } from '../utils/agentSetupBlob';
import { getColors } from '../theme/colors';
import type { NavProp } from '../navigation/types';
import { registerForPushNotificationsAsync } from '../services/notifications';
import { ExportSheet } from '../components/ExportSheet';
import { saveJsonDownload } from '../services/exportDownload';
import { AppIcon } from '../components/AppIcon';

const OPTIONS: { value: ThemePref; label: string; hint: string }[] = [
  { value: 'system', label: 'System', hint: 'Follow your phone' },
  { value: 'light', label: 'Light', hint: '' },
  { value: 'dark', label: 'Dark', hint: '' },
];

type NotifStatus = 'granted' | 'denied' | 'undetermined' | 'unknown';

export function SettingsScreen() {
  const navigation = useNavigation<NavProp<'Settings'>>();
  const { preference, setPreference, scheme } = useTheme();
  const { currentUser, isConnected, signOut } = useChat();
  const c = getColors(scheme);

  // Account deletion (OpenChat-nhy)
  const [deleteModalVisible, setDeleteModalVisible] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [exportSheetVisible, setExportSheetVisible] = useState(false);
  const [exportBusyRange, setExportBusyRange] = useState<ExportRangeKey | null>(null);

  // One-click "Copy agent setup" (openchat-bbr): mints a key + copies the
  // tool-less paste-anywhere REST blob. No navigation, no reveal step.
  const [mintingSetup, setMintingSetup] = useState(false);
  const handleCopyAgentSetup = useCallback(async () => {
    if (mintingSetup) return;
    setMintingSetup(true);
    try {
      const result = await api.createAgentKey({
        name: `Quick setup ${new Date().toISOString().slice(0, 10)}`,
        scopes: ['read', 'write'],
      });
      const blob = buildAgentSetupBlob(result.key, OPENCHAT_URL);
      Clipboard.setString(blob);
      Alert.alert(
        'Agent setup copied',
        'Paste it into ChatGPT, Claude, Gemini, or any chatbot — no install needed. The model will read and send messages on your behalf.'
      );
    } catch (err) {
      Alert.alert(
        'Could not create setup',
        err instanceof Error ? err.message : 'Failed to mint an agent key. Please try again.'
      );
    } finally {
      setMintingSetup(false);
    }
  }, [mintingSetup]);

  // Send feedback -> server creates a WorldIssueTracker issue (oc8.3).
  const [sendingFeedback, setSendingFeedback] = useState(false);
  const handleSendFeedback = useCallback(() => {
    const submit = async (message?: string) => {
      const text = (message || '').trim();
      if (!text) return;
      setSendingFeedback(true);
      try {
        const { url } = await api.submitFeedback(text);
        Alert.alert('Thanks!', `Your feedback was sent.${url ? `\n\n${url}` : ''}`);
      } catch (err) {
        Alert.alert(
          'Couldn’t send feedback',
          err instanceof Error ? err.message : 'Please try again later.'
        );
      } finally {
        setSendingFeedback(false);
      }
    };
    if (Platform.OS === 'ios') {
      Alert.prompt(
        'Send feedback',
        'What’s working, broken, or missing?',
        submit,
        'plain-text'
      );
    } else {
      // Android has no Alert.prompt; v1 falls back to the web tracker.
      Linking.openURL('https://worldissuetracker.com');
    }
  }, []);

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

  const handleAccountExport = useCallback(async (range: ExportRangeKey) => {
    if (!isConnected || exportBusyRange) return;
    setExportBusyRange(range);
    try {
      const download = await api.exportAccount(range);
      const filename = await saveJsonDownload(download.filename, download.text);
      setExportSheetVisible(false);
      Alert.alert('Export ready', `${filename} has been prepared.`);
    } catch (err) {
      Alert.alert(
        'Export failed',
        !isConnected
          ? 'OpenChat is offline. Reconnect, then try the export again.'
          : err instanceof Error
            ? err.message
            : 'Could not export your account data.'
      );
    } finally {
      setExportBusyRange(null);
    }
  }, [exportBusyRange, isConnected]);

  // ── App / update provenance (openchat-3jq.3) ──────────────────────────────
  // Surface version + build number + OTA update channel so support can ask
  // "what version are you on?" and get a precise answer. expo-updates exposes
  // the running channel/runtimeVersion/updateId; expo-constants the native
  // version + build number. All read-only.
  const appVersion = Constants.expoConfig?.version ?? '?';
  const buildNumber =
    Constants.expoConfig?.ios?.buildNumber ??
    (Constants.expoConfig?.android?.versionCode != null
      ? String(Constants.expoConfig.android.versionCode)
      : undefined) ??
    '?';
  // expo-updates: channel (production/preview/development), runtimeVersion, and
  // the active update id. isEmbeddedLaunch => running the bundled JS (no OTA
  // applied yet); otherwise an OTA bundle is live.
  const updateChannel = Updates.channel ?? (Updates.isEnabled ? 'default' : 'none (dev)');
  const runtimeVersion = Updates.runtimeVersion ?? appVersion;
  const otaState = !Updates.isEnabled
    ? 'OTA disabled (dev build)'
    : Updates.isEmbeddedLaunch
      ? 'Bundled JS (no OTA applied)'
      : `OTA bundle ${Updates.updateId ? Updates.updateId.slice(0, 8) : 'active'}`;
  const provenanceSummary =
    Platform.OS === 'web'
      ? `Web · v${appVersion}`
      : `v${appVersion} (build ${buildNumber}) · channel ${updateChannel}`;

  return (
    <ScrollView
      style={[styles.root, { backgroundColor: c.background }]}
      contentContainerStyle={styles.content}
    >
      {/*
       * One-click "Copy agent setup" (openchat-bbr).
       * TRUE one-tap: mints a key + copies a paste-anywhere setup blob. No
       * navigation, no reveal step. Sits above the Agent Keys hero (which
       * remains for managing existing keys).
       */}
      <TouchableOpacity
        style={[styles.copySetupBtn, { backgroundColor: c.primary, opacity: mintingSetup ? 0.6 : 1 }]}
        onPress={handleCopyAgentSetup}
        disabled={mintingSetup}
        activeOpacity={0.85}
      >
        {mintingSetup ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><AppIcon name="copy" color={c.textPrimary} size={16} /><Text style={styles.copySetupTitle}>Copy agent setup</Text></View>
            <Text style={styles.copySetupSub}>
              Mints a key + copies a paste-anywhere setup for ChatGPT, Claude, any LLM
            </Text>
          </>
        )}
      </TouchableOpacity>

      {/*
       * Hero: Agent keys (OpenChat-i9h).
       * Top-of-settings placement because bi-directional agent access is
       * OpenChat's main product differentiator. Replaces the buried
       * "DEVELOPER → Agent keys" row. Kept below the one-click action for
       * managing (list/reveal/revoke) existing keys.
       */}
      <TouchableOpacity
        style={[styles.agentHero, { backgroundColor: c.primary }]}
        onPress={() => navigation.navigate('AgentKeys')}
        activeOpacity={0.88}
      >
        <View style={{ flex: 1 }}>
          <Text style={styles.agentHeroEyebrow}>OPENCHAT FOR AGENTS</Text>
          <Text style={styles.agentHeroTitle}>Plug in Claude, Cursor, Codex</Text>
          <Text style={styles.agentHeroSubtitle}>
            Bi-directional MCP access · paste-into-Claude-Code prompt · 30-second setup
          </Text>
        </View>
        <Text style={styles.agentHeroArrow}>→</Text>
      </TouchableOpacity>

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
        <Text style={[styles.sectionLabel, { color: c.textSecondary }]}>AUTOMATION</Text>
        <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }]}>
          <TouchableOpacity
            style={styles.optionRow}
            onPress={() => navigation.navigate('Secretary')}
            activeOpacity={0.7}
          >
            <View style={{ flex: 1 }}>
              <Text style={[styles.optionLabel, { color: c.textPrimary }]}>Secretary</Text>
              <Text style={[styles.optionHint, { color: c.textSecondary }]}>Auto-answer repetitive questions using replies you approve</Text>
            </View>
            <Text style={{ color: c.textMuted, fontSize: 18 }}>›</Text>
          </TouchableOpacity>
        </View>
      </View>

      <View style={styles.section}>
        <Text style={[styles.sectionLabel, { color: c.textSecondary }]}>FEEDBACK</Text>
        <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }]}>
          <TouchableOpacity
            style={[styles.optionRow]}
            onPress={handleSendFeedback}
            disabled={sendingFeedback}
            activeOpacity={0.7}
          >
            <View style={{ flex: 1 }}>
              <Text style={[styles.optionLabel, { color: c.textPrimary }]}>
                {sendingFeedback ? 'Sending…' : 'Send feedback'}
              </Text>
              <Text style={[styles.optionHint, { color: c.textSecondary }]}>
                Report a bug or request a feature
              </Text>
            </View>
            <Text style={{ color: c.textMuted, fontSize: 18 }}>›</Text>
          </TouchableOpacity>
        </View>
      </View>

      <View style={styles.section}>
        <Text style={[styles.sectionLabel, { color: c.textSecondary }]}>DATA</Text>
        <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }]}>
          <TouchableOpacity
            style={styles.optionRow}
            onPress={() => setExportSheetVisible(true)}
            activeOpacity={0.7}
          >
            <View style={{ flex: 1 }}>
              <Text style={[styles.optionLabel, { color: c.textPrimary }]}>Export my data</Text>
              <Text style={[styles.optionHint, { color: c.textSecondary }]}>
                Download messages, thoughts, settings, and account metadata
              </Text>
            </View>
            <Text style={{ color: c.primary, fontSize: 18 }}>↓</Text>
          </TouchableOpacity>
        </View>
      </View>

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
            {/* Unified permissions panel: notifications + mic + camera + photos
                with re-request affordances. Surfaces here so users who arrive
                looking for "where do I re-enable that thing I denied?" find it. */}
            <TouchableOpacity
              style={[styles.optionRow, { borderTopColor: c.divider, borderTopWidth: StyleSheet.hairlineWidth }]}
              onPress={() => navigation.navigate('Permissions')}
              activeOpacity={0.7}
            >
              <View style={{ flex: 1 }}>
                <Text style={[styles.optionLabel, { color: c.textPrimary }]}>All permissions</Text>
                <Text style={[styles.optionHint, { color: c.textSecondary }]}>
                  Camera, microphone, photos, notifications — manage each
                </Text>
              </View>
              <Text style={{ color: c.textMuted, fontSize: 18 }}>›</Text>
            </TouchableOpacity>
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

      {/* Invite people (openchat-37z). Shareable QR/link points to the landing
          page (chat.globalbr.ai) which branches to iOS TestFlight, web, and
          Android — so one QR works for whoever scans it. */}
      <View style={styles.section}>
        <Text style={[styles.sectionLabel, { color: c.textSecondary }]}>INVITE PEOPLE</Text>
        <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }]}>
          <View style={{ alignItems: 'center', paddingVertical: 18 }}>
            <View style={{ backgroundColor: '#fff', padding: 12, borderRadius: 12 }}>
              <QRCode value="https://chat.globalbr.ai" size={168} />
            </View>
            <Text style={[styles.optionHint, { color: c.textSecondary, marginTop: 10, textAlign: 'center', paddingHorizontal: 16 }]}>
              Scan to open the OpenChat download page — iOS TestFlight, web, or Android
            </Text>
          </View>
          <TouchableOpacity
            style={[styles.optionRow, { borderBottomColor: c.divider, borderBottomWidth: StyleSheet.hairlineWidth }]}
            onPress={async () => {
              const url = 'https://chat.globalbr.ai';
              const message = `Try OpenChat — chat with a built-in AI assistant: ${url}`;
              if (Platform.OS === 'web') {
                const nav = (globalThis as unknown as { navigator?: { share?: (d: unknown) => Promise<void> } }).navigator;
                if (nav?.share) { try { await nav.share({ title: 'OpenChat', text: message, url }); } catch { /* cancelled */ } return; }
                Clipboard.setString(url); Alert.alert('Copied', 'Invite link copied to clipboard.'); return;
              }
              try { await Share.share({ message, url }); } catch { /* cancelled */ }
            }}
            activeOpacity={0.7}
          >
            <View style={{ flex: 1 }}>
              <Text style={[styles.optionLabel, { color: c.textPrimary }]}>📤  Share invite link</Text>
              <Text style={[styles.optionHint, { color: c.textSecondary }]}>chat.globalbr.ai · works on any device</Text>
            </View>
            <Text style={{ color: c.textMuted, fontSize: 18 }}>›</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.optionRow, { borderBottomColor: c.divider, borderBottomWidth: StyleSheet.hairlineWidth }]}
            onPress={() => Linking.openURL('https://testflight.apple.com/join/QvUPzDMY')}
            activeOpacity={0.7}
          >
            <View style={{ flex: 1 }}>
              <Text style={[styles.optionLabel, { color: c.textPrimary }]}>Get the iOS app · TestFlight</Text>
              <Text style={[styles.optionHint, { color: c.textSecondary }]}>Install the native beta on iPhone</Text>
            </View>
            <Text style={{ color: c.textMuted, fontSize: 18 }}>›</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.optionRow}
            onPress={() => Linking.openURL('https://chat.globalbr.ai/about')}
            activeOpacity={0.7}
          >
            <View style={{ flex: 1 }}>
              <Text style={[styles.optionLabel, { color: c.textPrimary }]}>View the download page</Text>
              <Text style={[styles.optionHint, { color: c.textSecondary }]}>The landing page with every platform</Text>
            </View>
            <Text style={{ color: c.textMuted, fontSize: 18 }}>›</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* About / web version (OpenChat-e4n) */}
      <View style={styles.section}>
        <Text style={[styles.sectionLabel, { color: c.textSecondary }]}>ABOUT</Text>
        <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }]}>
          <TouchableOpacity
            style={[styles.optionRow, { borderBottomColor: c.divider, borderBottomWidth: StyleSheet.hairlineWidth }]}
            onPress={() => Linking.openURL('https://github.com/IdeaFlowCo/OpenChat')}
            activeOpacity={0.7}
          >
            <View style={{ flex: 1 }}>
              <Text style={[styles.optionLabel, { color: c.textPrimary }]}>Source code · GitHub</Text>
              <Text style={[styles.optionHint, { color: c.textSecondary }]}>github.com/IdeaFlowCo/OpenChat — open source</Text>
            </View>
            <Text style={{ color: c.textMuted, fontSize: 18 }}>›</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.optionRow, { borderBottomColor: c.divider, borderBottomWidth: StyleSheet.hairlineWidth }]}
            onPress={() => Linking.openURL('https://chat.globalbr.ai/')}
            activeOpacity={0.7}
          >
            <View style={{ flex: 1 }}>
              <Text style={[styles.optionLabel, { color: c.textPrimary }]}>OpenChat home page</Text>
              <Text style={[styles.optionHint, { color: c.textSecondary }]}>
                chat.globalbr.ai · platform docs, agent setup, source
              </Text>
            </View>
            <Text style={{ color: c.textMuted, fontSize: 18 }}>›</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.optionRow, { borderBottomColor: c.divider, borderBottomWidth: StyleSheet.hairlineWidth }]}
            onPress={() => Linking.openURL('https://chat.globalbr.ai/m/')}
            activeOpacity={0.7}
          >
            <View style={{ flex: 1 }}>
              <Text style={[styles.optionLabel, { color: c.textPrimary }]}>Open web app</Text>
              <Text style={[styles.optionHint, { color: c.textSecondary }]}>
                Use OpenChat in any browser
              </Text>
            </View>
            <Text style={{ color: c.textMuted, fontSize: 18 }}>›</Text>
          </TouchableOpacity>

          {/* App / update provenance (openchat-3jq.3). Tap to copy the full
              version string for support / bug reports. */}
          <TouchableOpacity
            style={styles.optionRow}
            onPress={() => {
              Clipboard.setString(provenanceSummary);
              Alert.alert('Copied', provenanceSummary);
            }}
            activeOpacity={0.7}
          >
            <View style={{ flex: 1 }}>
              <Text style={[styles.optionLabel, { color: c.textPrimary }]}>App version &amp; updates</Text>
              {Platform.OS === 'web' ? (
                <Text style={[styles.optionHint, { color: c.textSecondary }]}>Web · v{appVersion}</Text>
              ) : (
                <>
                  <Text style={[styles.optionHint, { color: c.textSecondary }]}>
                    v{appVersion} (build {buildNumber}) · runtime {runtimeVersion}
                  </Text>
                  <Text style={[styles.optionHint, { color: c.textSecondary }]}>
                    Update channel: {updateChannel} · {otaState}
                  </Text>
                </>
              )}
            </View>
            <Text style={{ color: c.textMuted, fontSize: 16 }}>⧉</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Agent keys (OpenChat-7c9) — promoted to the top of Settings as a
          hero card (OpenChat-i9h). The hero is at the very top of this
          screen; there is no longer a buried DEVELOPER row. */}

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

      <ExportSheet
        visible={exportSheetVisible}
        title="Export my data"
        subtitle="Download a JSON bundle of your OpenChat account. Pick a recent window or all available history."
        disabledReason={!isConnected ? 'OpenChat is offline. Downloads need a live connection.' : null}
        busyRange={exportBusyRange}
        onClose={() => !exportBusyRange && setExportSheetVisible(false)}
        onExport={handleAccountExport}
      />

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
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 32 },

  // One-click "Copy agent setup" primary action (openchat-bbr)
  copySetupBtn: {
    borderRadius: 14,
    paddingVertical: 16,
    paddingHorizontal: 18,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 64,
    marginBottom: 12,
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 3,
  },
  copySetupTitle: { color: '#fff', fontSize: 16, fontWeight: '700' },
  copySetupSub: {
    color: 'rgba(255,255,255,0.88)',
    fontSize: 12,
    marginTop: 3,
    textAlign: 'center',
    lineHeight: 16,
  },

  // Top-of-settings hero promoting Agent Keys (OpenChat-i9h)
  agentHero: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 18,
    paddingVertical: 18,
    borderRadius: 14,
    marginBottom: 28,
    gap: 12,
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 3,
  },
  agentHeroEyebrow: {
    color: 'rgba(255,255,255,0.85)',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1.2,
    marginBottom: 4,
  },
  agentHeroTitle: {
    color: '#fff',
    fontSize: 17,
    fontWeight: '700',
    marginBottom: 3,
  },
  agentHeroSubtitle: {
    color: 'rgba(255,255,255,0.92)',
    fontSize: 12,
    lineHeight: 17,
  },
  agentHeroArrow: { color: '#fff', fontSize: 22, fontWeight: '300' },

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
