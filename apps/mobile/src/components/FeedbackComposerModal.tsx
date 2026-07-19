import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { api } from '../api/client';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';

interface Props {
  visible: boolean;
  onClose: () => void;
  initialText?: string;
}

export function FeedbackComposerModal({ visible, onClose, initialText = '' }: Props) {
  const { scheme } = useTheme();
  const c = getColors(scheme);
  const inputRef = useRef<TextInput>(null);
  const [text, setText] = useState(initialText);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (!visible) return;
    setText(initialText);
    const timer = setTimeout(() => inputRef.current?.focus(), 120);
    return () => clearTimeout(timer);
  }, [initialText, visible]);

  const close = () => {
    if (!sending) onClose();
  };

  const submit = async () => {
    const message = text.trim();
    if (!message || sending) return;
    setSending(true);
    try {
      await api.submitFeedback(message);
      onClose();
      Alert.alert('Feedback sent', 'Thanks for helping improve OpenChat.');
    } catch (err) {
      Alert.alert(
        'Could not send feedback',
        err instanceof Error ? err.message : 'Please try again.'
      );
    } finally {
      setSending(false);
    }
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={close}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.overlay}
      >
        <Pressable style={StyleSheet.absoluteFill} onPress={close} />
        <View style={[styles.sheet, { backgroundColor: c.surface, borderColor: c.border }]}>
          <View style={styles.header}>
            <View style={styles.headerCopy}>
              <Text style={[styles.title, { color: c.textPrimary }]}>Send feedback</Text>
              <Text style={[styles.subtitle, { color: c.textSecondary }]}>Report a bug or request a feature</Text>
            </View>
            <Pressable
              onPress={close}
              disabled={sending}
              style={styles.closeButton}
              accessibilityRole="button"
              accessibilityLabel="Close feedback"
            >
              <Text style={[styles.closeText, { color: c.textSecondary }]}>×</Text>
            </Pressable>
          </View>
          <TextInput
            ref={inputRef}
            value={text}
            onChangeText={setText}
            editable={!sending}
            multiline
            maxLength={4000}
            textAlignVertical="top"
            placeholder="What is working, broken, or missing?"
            placeholderTextColor={c.textMuted}
            style={[
              styles.input,
              { color: c.textPrimary, backgroundColor: c.background, borderColor: c.border },
            ]}
          />
          <View style={styles.footer}>
            <Text style={[styles.count, { color: c.textMuted }]}>{text.length}/4000</Text>
            <Pressable
              onPress={() => void submit()}
              disabled={!text.trim() || sending}
              accessibilityRole="button"
              accessibilityLabel="Submit feedback"
              style={({ pressed }) => [
                styles.submitButton,
                { backgroundColor: c.primary },
                (!text.trim() || sending) && styles.disabled,
                pressed && { backgroundColor: c.primaryActive },
              ]}
            >
              {sending
                ? <ActivityIndicator size="small" color="#fff" />
                : <Text style={styles.submitText}>Send</Text>}
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'center',
    padding: 20,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  sheet: {
    width: '100%',
    maxWidth: 520,
    alignSelf: 'center',
    padding: 18,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
  },
  header: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  headerCopy: { flex: 1 },
  title: { fontSize: 20, fontWeight: '700' },
  subtitle: { marginTop: 3, fontSize: 13 },
  closeButton: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  closeText: { fontSize: 28, lineHeight: 30 },
  input: {
    minHeight: 150,
    maxHeight: 280,
    marginTop: 16,
    padding: 12,
    borderWidth: 1,
    borderRadius: 8,
    fontSize: 16,
    lineHeight: 22,
  },
  footer: { marginTop: 12, flexDirection: 'row', alignItems: 'center' },
  count: { flex: 1, fontSize: 12 },
  submitButton: {
    minWidth: 88,
    minHeight: 42,
    paddingHorizontal: 18,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
  },
  submitText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  disabled: { opacity: 0.45 },
});
