import { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { api } from '../api/client';
import { useChat } from '../contexts/ChatContext';
import { useTheme } from '../contexts/ThemeContext';
import type { NavProp, RouteProps } from '../navigation/types';
import { getColors } from '../theme/colors';
import { capsLabel, serif } from '../theme/typography';
import { Avatar } from '../components/Avatar';

function remaining(expiresAt: string): string {
  const ms = Math.max(0, Date.parse(expiresAt) - Date.now());
  const hours = Math.ceil(ms / 3_600_000);
  return hours < 24 ? `${hours} hours left` : `${Math.ceil(hours / 24)} days left`;
}

export function StoryViewerScreen() {
  const { scheme } = useTheme();
  const c = getColors(scheme);
  const navigation = useNavigation<NavProp<'StoryViewer'>>();
  const route = useRoute<RouteProps<'StoryViewer'>>();
  const { refreshConversations } = useChat();
  const { story } = route.params;
  const authorName = story.author.name || 'A friend';
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const agentPrompt = useMemo(
    () => `Help me think about ${authorName}’s Story: “${story.text}”`,
    [authorName, story.text],
  );

  const respond = async (message: string) => {
    if (!message.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.respondToStory(story.id, message.trim());
      await refreshConversations();
      navigation.replace('Chat', { conversationId: result.conversationId });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send this private response.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={[styles.page, { backgroundColor: c.background }]}>
      <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }]}>
        <View style={styles.authorRow}>
            <Avatar name={authorName} size={46} />
          <View style={{ flex: 1 }}>
            <Text style={[styles.author, { color: c.textPrimary }]}>{authorName}</Text>
            <Text style={[styles.expiry, { color: c.textMuted }]}>{remaining(story.storyExpiresAt)}</Text>
          </View>
          <Text style={[styles.eyebrow, { color: c.primary }]}>STORY</Text>
        </View>
        <Text style={[styles.storyText, { color: c.textPrimary }]}>{story.text}</Text>
      </View>

      <View style={[styles.replyCard, { backgroundColor: c.surface, borderColor: c.border }]}>
        <Text style={[styles.replyTitle, { color: c.textPrimary }]}>Reply privately</Text>
        <Text style={[styles.replyHint, { color: c.textSecondary }]}>Your response starts or opens a direct chat. Nothing is posted publicly.</Text>
        <TextInput
          value={reply}
          onChangeText={setReply}
          placeholder={`Message ${authorName}`}
          placeholderTextColor={c.textMuted}
          multiline
          style={[styles.input, { color: c.textPrimary, borderColor: c.border, backgroundColor: c.background }]}
        />
        <View style={styles.actions}>
          <TouchableOpacity disabled={busy} onPress={() => void respond(reply)} style={[styles.primary, { backgroundColor: c.primary }, busy && styles.disabled]}>
            {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryText}>Reply</Text>}
          </TouchableOpacity>
          <TouchableOpacity disabled={busy} onPress={() => void respond(`I may be able to help with this. Want to talk?`)} style={[styles.secondary, { borderColor: c.border }]}>
            <Text style={[styles.secondaryText, { color: c.primary }]}>I may be able to help</Text>
          </TouchableOpacity>
        </View>
        <TouchableOpacity onPress={() => navigation.navigate('AgentOverlay', { prompt: agentPrompt })} style={styles.agentAction}>
          <Text style={{ color: c.primary, fontWeight: '700' }}>Ask My Agent about this</Text>
        </TouchableOpacity>
        {error && <Text accessibilityRole="alert" style={[styles.error, { color: c.danger }]}>{error}</Text>}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, width: '100%', maxWidth: 720, alignSelf: 'center', padding: 18, gap: 14 },
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 22, padding: 20 },
  authorRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  author: { fontWeight: '700', fontSize: 16 },
  expiry: { fontSize: 12, marginTop: 2 },
  eyebrow: { ...capsLabel },
  storyText: { fontFamily: serif, fontSize: 26, lineHeight: 36, marginTop: 22 },
  replyCard: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 18, padding: 16 },
  replyTitle: { fontFamily: serif, fontWeight: '600', fontSize: 20 },
  replyHint: { fontSize: 12, lineHeight: 18, marginTop: 4 },
  input: { minHeight: 82, borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, padding: 12, marginTop: 12, textAlignVertical: 'top' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 },
  primary: { minHeight: 44, minWidth: 92, borderRadius: 12, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
  primaryText: { color: '#fff', fontWeight: '800' },
  secondary: { minHeight: 44, borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 14 },
  secondaryText: { fontWeight: '700' },
  agentAction: { minHeight: 46, alignItems: 'center', justifyContent: 'center', marginTop: 4 },
  disabled: { opacity: 0.55 },
  error: { marginTop: 8, fontSize: 13 },
});
