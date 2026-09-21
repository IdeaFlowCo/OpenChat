import { useEffect, useState } from 'react';
import { View, Text, StyleSheet, ActivityIndicator, TouchableOpacity } from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';
import { api } from '../api/client';
import { useChat } from '../contexts/ChatContext';
import { useEntryContext } from '../contexts/EntryContext';
import type { NavProp, RouteProps } from '../navigation/types';

export function PersonEntryScreen() {
  const navigation = useNavigation<NavProp<'PersonEntry'>>();
  const route = useRoute<RouteProps<'PersonEntry'>>();
  const { userId } = route.params;
  const { scheme } = useTheme();
  const c = getColors(scheme);
  const { createConversation } = useChat();
  const { clearEntry } = useEntryContext();

  const [person, setPerson] = useState<{ name: string; avatarUrl: string | null } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [messaging, setMessaging] = useState(false);

  useEffect(() => {
    const load = async () => {
      try {
        const res = await api.getPublicUser(userId);
        setPerson(res);
      } catch (err: any) {
        setError(err.message || 'Failed to load user profile');
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [userId]);

  const handleMessage = async () => {
    setMessaging(true);
    try {
      const conv = await createConversation([userId], { type: 'direct' });
      await clearEntry();
      navigation.replace('Chat', { conversationId: conv.id });
    } catch (err: any) {
      setError(err.message || 'Failed to open chat');
      setMessaging(false);
    }
  };

  const handleClose = async () => {
    await clearEntry();
    if (navigation.canGoBack()) navigation.goBack();
    else navigation.replace('Conversations');
  };

  if (loading) {
    return (
      <View style={[styles.root, { backgroundColor: c.background }]}>
        <ActivityIndicator color={c.primary} size="large" />
      </View>
    );
  }

  if (error || !person) {
    return (
      <View style={[styles.root, { backgroundColor: c.background }]}>
        <View style={[styles.card, { backgroundColor: c.surfaceElevated, borderColor: c.border }]}>
          <Text style={[styles.errorHeading, { color: c.danger }]}>User Unavailable</Text>
          <Text style={[styles.errorMsg, { color: c.textSecondary }]}>{error || 'User not found'}</Text>
          <TouchableOpacity style={[styles.closeBtn, { borderColor: c.border }]} onPress={handleClose}>
            <Text style={{ color: c.textPrimary, fontWeight: '600' }}>Close</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.root, { backgroundColor: c.background }]}>
      <View style={[styles.card, { backgroundColor: c.surfaceElevated, borderColor: c.border }]}>
        <Text style={[styles.heading, { color: c.textPrimary }]}>{person.name}</Text>
        <Text style={[styles.subtitle, { color: c.textSecondary }]}>wants to connect on OpenChat</Text>

        <TouchableOpacity
          style={[styles.btn, { backgroundColor: c.primary, opacity: messaging ? 0.6 : 1 }]}
          onPress={handleMessage}
          disabled={messaging}
        >
          {messaging ? (
            <ActivityIndicator color={c.onPrimary} size="small" />
          ) : (
            <Text style={[styles.btnText, { color: c.onPrimary }]}>Message</Text>
          )}
        </TouchableOpacity>

        <TouchableOpacity style={styles.cancelBtn} onPress={handleClose}>
          <Text style={{ color: c.textSecondary, fontWeight: '600' }}>Cancel</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 },
  card: { width: '100%', maxWidth: 360, borderRadius: 20, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 28, paddingVertical: 32, alignItems: 'center' },
  heading: { fontSize: 22, fontWeight: '700', marginBottom: 8, textAlign: 'center' },
  subtitle: { fontSize: 15, marginBottom: 28, textAlign: 'center' },
  btn: { width: '100%', paddingVertical: 14, borderRadius: 12, alignItems: 'center', marginBottom: 12 },
  btnText: { fontSize: 17, fontWeight: '700' },
  cancelBtn: { paddingVertical: 10 },
  errorHeading: { fontSize: 18, fontWeight: '700', marginBottom: 10, textAlign: 'center' },
  errorMsg: { fontSize: 15, textAlign: 'center', marginBottom: 20 },
  closeBtn: { paddingVertical: 12, paddingHorizontal: 32, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth },
});
