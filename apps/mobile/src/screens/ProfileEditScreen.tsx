/**
 * ProfileEditScreen — lets the user update their display name and status
 * message. Presented as a modal (same pattern as MyQrCodeScreen).
 *
 * OpenChat-tml
 */

import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { getInfoAsync, uploadAsync, FileSystemUploadType } from 'expo-file-system/legacy';
import { useNavigation } from '@react-navigation/native';
import { useTheme } from '../contexts/ThemeContext';
import { useChat } from '../contexts/ChatContext';
import { getColors } from '../theme/colors';
import type { NavProp } from '../navigation/types';
import { api } from '../api/client';
import { Avatar } from '../components/Avatar';

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
  const [discoveryMode, setDiscoveryMode] = useState<'name' | 'email_only' | 'hidden' | undefined>(
    currentUser?.discoveryMode
  );
  const [discoveryChanged, setDiscoveryChanged] = useState(false);
  const [avatarUri, setAvatarUri] = useState<string | undefined>(
    selfParticipant?.user.avatarUrl ?? currentUser?.avatarUrl
  );
  const [avatarMime, setAvatarMime] = useState('image/jpeg');
  const [avatarSize, setAvatarSize] = useState<number | undefined>();
  const [avatarChanged, setAvatarChanged] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!discoveryChanged && currentUser?.discoveryMode) {
      setDiscoveryMode(currentUser.discoveryMode);
    }
  }, [currentUser?.discoveryMode, discoveryChanged]);

  const pickAvatar = useCallback(async () => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('Photo access needed', 'Allow photo access to choose a profile picture.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.85,
      exif: false,
    });
    if (result.canceled || result.assets.length === 0) return;
    const asset = result.assets[0];
    setAvatarUri(asset.uri);
    setAvatarMime(asset.mimeType === 'image/jpg' ? 'image/jpeg' : (asset.mimeType || 'image/jpeg'));
    setAvatarSize(asset.fileSize);
    setAvatarChanged(true);
  }, []);

  const handleSave = useCallback(async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      Alert.alert('Name required', 'Please enter a display name.');
      return;
    }
    setSaving(true);
    try {
      let avatarUrl = currentUser?.avatarUrl;
      if (avatarChanged && avatarUri) {
        let webBlob: Blob | undefined;
        let sizeBytes = avatarSize;
        if (Platform.OS === 'web') {
          webBlob = await (await fetch(avatarUri)).blob();
          sizeBytes = webBlob.size;
        } else if (!sizeBytes) {
          const info = await getInfoAsync(avatarUri);
          if (info.exists) sizeBytes = info.size;
        }
        if (!sizeBytes || sizeBytes <= 0) throw new Error('Could not determine profile photo size.');
        const { putUrl, getUrl } = await api.presignAvatar({
          filename: `avatar_${Date.now()}.jpg`,
          mimeType: avatarMime,
          sizeBytes,
        });
        if (Platform.OS === 'web') {
          const upload = await fetch(putUrl, {
            method: 'PUT',
            headers: { 'Content-Type': avatarMime },
            body: webBlob,
          });
          if (!upload.ok) throw new Error(`Photo upload failed (${upload.status})`);
        } else {
          const upload = await uploadAsync(putUrl, avatarUri, {
            httpMethod: 'PUT',
            uploadType: FileSystemUploadType.BINARY_CONTENT,
            headers: { 'Content-Type': avatarMime },
          });
          if (upload.status < 200 || upload.status >= 300) {
            throw new Error(`Photo upload failed (${upload.status})`);
          }
        }
        avatarUrl = getUrl;
      }
      await updateProfile({
        name: trimmedName,
        statusMessage: statusMessage.trim() || undefined,
        avatarUrl,
        ...(discoveryChanged && discoveryMode ? { discoveryMode } : {}),
      });
      navigation.goBack();
    } catch (err) {
      Alert.alert('Error', err instanceof Error ? err.message : 'Failed to save profile.');
    } finally {
      setSaving(false);
    }
  }, [avatarChanged, avatarMime, avatarSize, avatarUri, currentUser?.avatarUrl, discoveryChanged, discoveryMode, name, statusMessage, updateProfile, navigation]);

  return (
    <ScrollView
      style={{ backgroundColor: c.background }}
      contentContainerStyle={styles.root}
      keyboardShouldPersistTaps="handled"
    >
      <View style={styles.avatarRow}>
        <Avatar
          name={name}
          email={currentUser?.email}
          avatarUrl={avatarUri}
          size={80}
        />
        <TouchableOpacity
          style={[styles.photoBtn, { borderColor: c.border }]}
          onPress={pickAvatar}
          activeOpacity={0.7}
        >
          <Text style={{ color: c.primary, fontWeight: '600' }}>Choose photo</Text>
        </TouchableOpacity>
      </View>
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
        <Text style={[styles.label, { color: c.textSecondary }]}>WHO CAN FIND YOU?</Text>
        {([
          ['name', 'Everyone by name', 'Your name and photo appear in search. Your email stays private.'],
          ['email_only', 'Only people with my email', 'Only a complete-email search can find you; the result does not reveal it.'],
          ['hidden', 'Nobody', 'You stay out of discovery. Existing chats are unchanged.'],
        ] as const).map(([value, label, detail]) => {
          const selected = discoveryMode === value;
          return (
            <TouchableOpacity
              key={value}
              style={[styles.discoveryOption, { borderColor: selected ? c.primary : c.border, backgroundColor: c.surface }]}
              onPress={() => {
                setDiscoveryMode(value);
                setDiscoveryChanged(true);
              }}
              activeOpacity={0.75}
            >
              <View style={[styles.radio, { borderColor: selected ? c.primary : c.textMuted }]}>
                {selected && <View style={[styles.radioDot, { backgroundColor: c.primary }]} />}
              </View>
              <View style={styles.discoveryCopy}>
                <Text style={[styles.discoveryTitle, { color: c.textPrimary }]}>{label}</Text>
                <Text style={[styles.discoveryDetail, { color: c.textMuted }]}>{detail}</Text>
              </View>
            </TouchableOpacity>
          );
        })}
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
    </ScrollView>
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
  avatarRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    marginBottom: 24,
  },
  photoBtn: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
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
  discoveryOption: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    padding: 12,
    marginBottom: 8,
  },
  radio: {
    width: 20,
    height: 20,
    borderWidth: 2,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  radioDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  discoveryCopy: {
    flex: 1,
    marginLeft: 10,
  },
  discoveryTitle: {
    fontSize: 14,
    fontWeight: '600',
  },
  discoveryDetail: {
    fontSize: 12,
    lineHeight: 17,
    marginTop: 2,
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
