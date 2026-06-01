/**
 * Add / Edit Thought modal. (OpenChat-zi1)
 *
 * - Multi-line TextInput for text (autofocus)
 * - Kind picker (5 options, default "observation")
 * - Status picker (3 options, default "none")
 * - Save / Cancel buttons
 *
 * When `route.params.thought` is provided the screen is in edit mode and
 * pre-fills all fields from the existing thought.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';
import { createThought, updateThought, ThoughtKind, ThoughtStatus } from '../services/thoughts';
import type { ThoughtsNavProp, ThoughtsRouteProps } from '../navigation/types';

const KINDS: { value: ThoughtKind; label: string; color: string }[] = [
  { value: 'observation', label: 'Observation', color: '#3b82f6' },
  { value: 'fact',        label: 'Fact',        color: '#6366f1' },
  { value: 'decision',    label: 'Decision',    color: '#f59e0b' },
  { value: 'commitment',  label: 'Commitment',  color: '#10b981' },
  { value: 'reminder',    label: 'Reminder',    color: '#f97316' },
];

const STATUSES: { value: ThoughtStatus; label: string }[] = [
  { value: 'none',   label: 'No status' },
  { value: 'open',   label: 'Open' },
  { value: 'closed', label: 'Closed' },
];

export function AddEditThoughtScreen() {
  const navigation = useNavigation<ThoughtsNavProp<'AddEditThought'>>();
  const route = useRoute<ThoughtsRouteProps<'AddEditThought'>>();
  const { scheme } = useTheme();
  const c = getColors(scheme);

  const existing = route.params?.thought;
  const isEdit = Boolean(existing);

  const [text, setText] = useState(existing?.text ?? '');
  const [kind, setKind] = useState<ThoughtKind>(existing?.kind ?? 'observation');
  const [status, setStatus] = useState<ThoughtStatus>(existing?.status ?? 'none');
  const [saving, setSaving] = useState(false);

  const inputRef = useRef<TextInput>(null);

  useEffect(() => {
    // Auto-focus after mount
    const t = setTimeout(() => inputRef.current?.focus(), 100);
    return () => clearTimeout(t);
  }, []);

  const handleSave = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed) {
      Alert.alert('Text required', 'Please enter some text for your thought.');
      return;
    }
    if (trimmed.length > 4000) {
      Alert.alert('Too long', 'Text must be 4000 characters or fewer.');
      return;
    }

    setSaving(true);
    try {
      if (isEdit && existing) {
        await updateThought(existing.id, { text: trimmed, kind, status });
      } else {
        await createThought({ text: trimmed, kind, status });
      }
      navigation.goBack();
    } catch (e) {
      Alert.alert('Error', e instanceof Error ? e.message : 'Failed to save thought');
    } finally {
      setSaving(false);
    }
  }, [text, kind, status, isEdit, existing, navigation]);

  const handleCancel = useCallback(() => {
    navigation.goBack();
  }, [navigation]);

  return (
    <KeyboardAvoidingView
      style={[styles.root, { backgroundColor: c.background }]}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={88}
    >
      <ScrollView
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
      >
        {/* Text input */}
        <View style={[styles.inputContainer, { backgroundColor: c.surface, borderColor: c.border }]}>
          <TextInput
            ref={inputRef}
            style={[styles.textInput, { color: c.textPrimary }]}
            placeholder="What's on your mind?"
            placeholderTextColor={c.textMuted}
            multiline
            value={text}
            onChangeText={setText}
            maxLength={4000}
            textAlignVertical="top"
          />
          <Text style={[styles.charCount, { color: c.textMuted }]}>
            {text.length}/4000
          </Text>
        </View>

        {/* Kind picker */}
        <Text style={[styles.sectionLabel, { color: c.textSecondary }]}>Kind</Text>
        <View style={styles.pickerRow}>
          {KINDS.map((k) => {
            const selected = kind === k.value;
            return (
              <TouchableOpacity
                key={k.value}
                onPress={() => setKind(k.value)}
                style={[
                  styles.pill,
                  {
                    backgroundColor: selected ? k.color + '22' : c.surface,
                    borderColor: selected ? k.color : c.border,
                  },
                ]}
                activeOpacity={0.7}
              >
                <Text
                  style={[
                    styles.pillText,
                    { color: selected ? k.color : c.textSecondary },
                  ]}
                >
                  {k.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* Status picker */}
        <Text style={[styles.sectionLabel, { color: c.textSecondary }]}>Status</Text>
        <View style={styles.pickerRow}>
          {STATUSES.map((s) => {
            const selected = status === s.value;
            const activeColor = s.value === 'open' ? '#3b82f6' : s.value === 'closed' ? '#6b7280' : c.primary;
            return (
              <TouchableOpacity
                key={s.value}
                onPress={() => setStatus(s.value)}
                style={[
                  styles.pill,
                  {
                    backgroundColor: selected ? activeColor + '22' : c.surface,
                    borderColor: selected ? activeColor : c.border,
                  },
                ]}
                activeOpacity={0.7}
              >
                <Text
                  style={[
                    styles.pillText,
                    { color: selected ? activeColor : c.textSecondary },
                  ]}
                >
                  {s.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* Action buttons */}
        <View style={styles.actions}>
          <TouchableOpacity
            style={[styles.cancelBtn, { borderColor: c.border }]}
            onPress={handleCancel}
            disabled={saving}
          >
            <Text style={[styles.cancelBtnText, { color: c.textSecondary }]}>Cancel</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.saveBtn, { backgroundColor: c.primary, opacity: saving ? 0.7 : 1 }]}
            onPress={handleSave}
            disabled={saving}
          >
            {saving ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <Text style={styles.saveBtnText}>{isEdit ? 'Save changes' : 'Add thought'}</Text>
            )}
          </TouchableOpacity>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  scroll: { padding: 16 },
  inputContainer: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 12,
    marginBottom: 20,
  },
  textInput: {
    fontSize: 16,
    lineHeight: 24,
    minHeight: 120,
  },
  charCount: {
    fontSize: 11,
    textAlign: 'right',
    marginTop: 4,
  },
  sectionLabel: {
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  pickerRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 20,
  },
  pill: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1.5,
  },
  pillText: {
    fontSize: 13,
    fontWeight: '500',
  },
  actions: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 8,
  },
  cancelBtn: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
  },
  cancelBtnText: {
    fontSize: 15,
    fontWeight: '500',
  },
  saveBtn: {
    flex: 2,
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  saveBtnText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
});
