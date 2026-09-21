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
 * api.submitFeedback and shows the resulting issue URL.
 *
 * UX:
 *   - Modal slides in from below, matching NVCComposerModal
 *   - Send is disabled until the message is non-empty, and while sending
 *   - A subtle "Open issue tracker" link stays available as a fallback
 */

import { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';

interface Props {
  visible: boolean;
  sending: boolean;
  onSubmit: (message: string) => void;
  onCancel: () => void;
}

export function FeedbackModal({ visible, sending, onSubmit, onCancel }: Props) {
  const { scheme } = useTheme();
  const c = getColors(scheme);

  const [message, setMessage] = useState('');

  const canSubmit = message.trim().length > 0 && !sending;

  const handleSend = () => {
    if (!canSubmit) return;
    onSubmit(message.trim());
  };

  const handleCancel = () => {
    if (sending) return;
    setMessage('');
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
  trackerLink: {
    fontSize: 12,
    marginTop: 12,
    textAlign: 'center',
  },
});
