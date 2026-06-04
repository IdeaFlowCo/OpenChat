/**
 * ProfileEditScreen — lets the user update their display name and status
 * message. Presented as a modal (same pattern as MyQrCodeScreen).
 *
 * OpenChat-tml
 */

import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useTheme } from '../contexts/ThemeContext';
import { useChat } from '../contexts/ChatContext';
import { getColors } from '../theme/colors';
import type { NavProp } from '../navigation/types';

export function ProfileEditScreen() {
  const navigation = useNavigation<NavProp<'ProfileEdit'>>();
  const { scheme } = useTheme();
  const c = getColors(scheme);
  const { currentUser, conversations, updateProfile } = useChat();

  // Derive the current user's stored name and statusMessage from the
  // first conversation they appear in, falling back to currentUser.name.
  const selfParticipant = conversations
    .flatMap(cv => cv.participants ?? [])
    .find(p => p.user.id === currentUser?.userId);

  const [name, setName] = useState<string>(
    selfParticipant?.user.name ?? currentUser?.name ?? ''
  );
  const [statusMessage, setStatusMessage] = useState<string>(
    selfParticipant?.user.statusMessage ?? ''
  );
  const [saving, setSaving] = useState(false);

  const handleSave = useCallback(async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      Alert.alert('Name required', 'Please enter a display name.');
      return;
    }
    setSaving(true);
    try {
      await updateProfile({ name: trimmedName, statusMessage: statusMessage.trim() || undefined });
      navigation.goBack();
    } catch (err) {
      Alert.alert('Error', err instanceof Error ? err.message : 'Failed to save profile.');
    } finally {
      setSaving(false);
    }
  }, [name, statusMessage, updateProfile, navigation]);

  return (
    <View style={[styles.root, { backgroundColor: c.background }]}>
      <View style={styles.section}>
        <Text style={[styles.label, { color: c.textSecondary }]}>DISPLAY NAME</Text>
        <TextInput
          style={[styles.input, { backgroundColor: c.surface, borderColor: c.border, color: c.textPrimary }]}
          value={name}
          onChangeText={setName}
          placeholder="Your name"
          placeholderTextColor={c.textMuted}
          autoCorrect={false}
          maxLength={80}
          returnKeyType="next"
        />
      </View>

      <View style={styles.section}>
        <Text style={[styles.label, { color: c.textSecondary }]}>STATUS MESSAGE</Text>
        <TextInput
          style={[styles.input, { backgroundColor: c.surface, borderColor: c.border, color: c.textPrimary }]}
          value={statusMessage}
          onChangeText={setStatusMessage}
          placeholder="What's on your mind?"
          placeholderTextColor={c.textMuted}
          maxLength={120}
          returnKeyType="done"
          onSubmitEditing={handleSave}
        />
        <Text style={[styles.hint, { color: c.textMuted }]}>
          Shown below your name in conversations.
        </Text>
      </View>

      <TouchableOpacity
        style={[styles.saveBtn, { backgroundColor: c.primary, opacity: saving ? 0.7 : 1 }]}
        onPress={handleSave}
        disabled={saving}
        activeOpacity={0.8}
      >
        {saving ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.saveBtnText}>Save</Text>
        )}
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    paddingHorizontal: 16,
    paddingTop: 24,
  },
  section: {
    marginBottom: 24,
  },
  label: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
    marginBottom: 8,
  },
  input: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    fontSize: 16,
  },
  hint: {
    fontSize: 11,
    marginTop: 6,
  },
  saveBtn: {
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  saveBtnText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 16,
  },
});
