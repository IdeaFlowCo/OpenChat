/**
 * FeedbackModal (OpenChat-k9hj).
 *
 * Cross-platform replacement for Alert.prompt, which only iOS implements.
 * Android and web previously had no in-app feedback path at all — Send
 * feedback just opened worldissuetracker.com externally, so the deployed
 * web client (/app is this same RN code) could never file in-app feedback.
 *
 * This modal captures the same free-text feedback message uniformly on
 * every platform. The parent (SettingsScreen) owns submission via
 * services/witNativeFeedback.ts (julr.11: openchat-feedback board, verified
 * `wfb1.` sender) and shows the resulting issue URL.
 *
 * UX:
 *   - Modal slides in from below, matching NVCComposerModal
 *   - Send is disabled until the message is non-empty, and while sending
 *   - A subtle "Open issue tracker" link stays available as a fallback
 *   - Filed publicly under the person's own account by default; "Post
 *     anonymously" is an explicit opt-in (OpenChat-0xjt)
 *   - Optional screenshot from the photo library, removable before sending
 */

import { useState } from 'react';
import * as ImagePicker from 'expo-image-picker';
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';
import { radius, touchTarget } from '../theme/tokens';
import type { FeedbackScreenshot } from '../services/witNativeFeedback';

interface Props {
  visible: boolean;
  sending: boolean;
  /** The filer's display name, shown in the attribution line. */
  filerName?: string;
  onSubmit: (message: string, anonymous: boolean, screenshot: FeedbackScreenshot | null) => void;
  onCancel: () => void;
}

export function FeedbackModal({ visible, sending, filerName, onSubmit, onCancel }: Props) {
  const { scheme } = useTheme();
  const c = getColors(scheme);

  const [message, setMessage] = useState('');
  const [anonymous, setAnonymous] = useState(false);
  const [screenshot, setScreenshot] = useState<FeedbackScreenshot | null>(null);

  const pickScreenshot = async () => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) return;
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.8 });
    const asset = result.canceled ? null : result.assets[0];
    if (!asset) return;
    setScreenshot({
      uri: asset.uri,
      mimeType: asset.mimeType || 'image/jpeg',
      fileName: asset.fileName || 'screenshot.jpg',
    });
  };

  const canSubmit = message.trim().length > 0 && !sending;

  const handleSend = () => {
    if (!canSubmit) return;
    onSubmit(message.trim(), anonymous, screenshot);
  };

  const handleCancel = () => {
    if (sending) return;
    setMessage('');
    setAnonymous(false);
    setScreenshot(null);
    onCancel();
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={handleCancel}
    >
      <KeyboardAvoidingView
        style={styles.backdrop}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <Pressable style={styles.dim} onPress={handleCancel} />
        <View style={[styles.sheet, { backgroundColor: c.background, borderColor: c.border }]}>
          <View style={[styles.header, { borderBottomColor: c.border }]}>
            <Pressable onPress={handleCancel} hitSlop={8} disabled={sending}>
              <Text style={[styles.headerCancel, { color: c.textSecondary, opacity: sending ? 0.4 : 1 }]}>
                Cancel
              </Text>
            </Pressable>
            <Text style={[styles.headerTitle, { color: c.textPrimary }]}>Send feedback</Text>
            <Pressable onPress={handleSend} hitSlop={8} disabled={!canSubmit} style={{ opacity: canSubmit ? 1 : 0.4 }}>
              {sending ? (
                <ActivityIndicator size="small" color={c.primary} />
              ) : (
                <Text style={[styles.headerSend, { color: c.primary }]}>Send</Text>
              )}
            </Pressable>
          </View>

          <View style={styles.fields}>
            <TextInput
              style={[
                styles.input,
                { backgroundColor: c.surface, borderColor: c.border, color: c.textPrimary },
              ]}
              value={message}
              onChangeText={setMessage}
              placeholder="What’s working, broken, or missing?"
              placeholderTextColor={c.textMuted}
              multiline
              editable={!sending}
              autoFocus
            />
            {screenshot ? (
              <View style={styles.shotRow}>
                <Image source={{ uri: screenshot.uri }} style={[styles.shotThumb, { borderColor: c.border }]} accessibilityLabel="Attached screenshot" />
                <Text style={[styles.anonLabel, { color: c.textPrimary, flex: 1 }]}>Screenshot attached</Text>
                <Pressable onPress={() => setScreenshot(null)} hitSlop={8} disabled={sending} accessibilityRole="button" accessibilityLabel="Remove screenshot">
                  <Text style={[styles.headerCancel, { color: c.textSecondary }]}>Remove</Text>
                </Pressable>
              </View>
            ) : (
              <Pressable onPress={() => void pickScreenshot()} disabled={sending} style={styles.shotRow} accessibilityRole="button">
                <Text style={[styles.anonLabel, { color: c.primary }]}>Attach a screenshot</Text>
              </Pressable>
            )}
            <View style={styles.anonRow}>
              <Text style={[styles.anonLabel, { color: c.textPrimary }]}>Post anonymously</Text>
              <Switch
                value={anonymous}
                onValueChange={setAnonymous}
                disabled={sending}
                accessibilityLabel="Post anonymously"
              />
            </View>
            <Text style={[styles.attribution, { color: c.textSecondary }]}>
              {anonymous
                ? 'Sending anonymously. Shown publicly as Anonymous on World Issue Tracker.'
                : `Sending as ${filerName?.trim() || 'you'}. Shown publicly on World Issue Tracker under your Ideaflow account.`}
            </Text>
            <Pressable onPress={() => void Linking.openURL('https://worldissuetracker.com')} hitSlop={8}>
              <Text style={[styles.trackerLink, { color: c.textMetadata }]}>Open issue tracker</Text>
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  dim: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  sheet: {
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerCancel: { fontSize: 15 },
  headerTitle: { fontSize: 16, fontWeight: '700' },
  headerSend: { fontSize: 15, fontWeight: '700' },
  fields: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 24 },
  input: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 9,
    borderWidth: StyleSheet.hairlineWidth,
    fontSize: 15,
    minHeight: 120,
    textAlignVertical: 'top',
  },
  anonRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 14,
    minHeight: 44,
  },
  anonLabel: { fontSize: 15 },
  shotRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 14,
    minHeight: 44,
  },
  shotThumb: { width: touchTarget, height: touchTarget, borderRadius: radius.sm, borderWidth: StyleSheet.hairlineWidth },
  attribution: { fontSize: 13, lineHeight: 18, marginTop: 2 },
  trackerLink: {
    fontSize: 12,
    marginTop: 12,
    textAlign: 'center',
  },
});
