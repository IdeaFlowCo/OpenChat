import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useFocusEffect, useNavigation, useRoute } from '@react-navigation/native';
import { api, type Message, type SocialReviewItem } from '../api/client';
import { useChat } from '../contexts/ChatContext';
import { useTheme } from '../contexts/ThemeContext';
import type { NavProp, RouteProps } from '../navigation/types';
import { getColors } from '../theme/colors';
import { capsLabel, serif } from '../theme/typography';
import { AppIcon } from '../components/AppIcon';
import { AgentNetworkCard } from '../components/AgentNetworkCard';

const EXAMPLES = [
  'I’m looking for a Burning Man ticket for a friend.',
  'I have an extra guest room in Denver next month.',
  'I’m technical and looking for a cofounder strong in distribution.',
];

interface AgentOverlayScreenProps {
  embedded?: boolean;
  onClose?: () => void;
  onOpenConversation?: (conversationId: string) => void;
}

export function AgentOverlayScreen({ embedded = false, onClose, onOpenConversation }: AgentOverlayScreenProps = {}) {
  const { scheme } = useTheme();
  const c = getColors(scheme);
  const navigation = useNavigation<NavProp<'AgentOverlay'>>();
  const route = useRoute<RouteProps<'AgentOverlay'>>();
  const { currentUser, sendMessageToConversation, refreshConversations } = useChat();
  const [prompt, setPrompt] = useState(route.params?.prompt ?? '');
  const [reviewItems, setReviewItems] = useState<SocialReviewItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [loadingReview, setLoadingReview] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [agentConversationId, setAgentConversationId] = useState<string | null>(null);
  const [threadMessages, setThreadMessages] = useState<Message[]>([]);
  const [loadingThread, setLoadingThread] = useState(embedded);

  const loadReview = useCallback(async () => {
    setLoadingReview(true);
    try {
      setReviewItems((await api.getSocialReview()).items);
    } catch {
      setReviewItems([]);
    } finally {
      setLoadingReview(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { void loadReview(); }, [loadReview]));

  const refreshThread = useCallback(async () => {
    if (!embedded) return;
    try {
      let conversationId = agentConversationId;
      if (!conversationId) {
        const conversation = await api.ensureAssistant();
        conversationId = conversation.id;
        setAgentConversationId(conversationId);
        await refreshConversations();
      }
      const result = await api.getMessages(conversationId);
      setThreadMessages(result.messages);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load My Agent.');
    } finally {
      setLoadingThread(false);
    }
  }, [agentConversationId, embedded, refreshConversations]);

  useEffect(() => {
    if (!embedded) return;
    void refreshThread();
    const interval = setInterval(() => { void refreshThread(); }, 3_000);
    return () => clearInterval(interval);
  }, [embedded, refreshThread]);

  const openConversation = async (content?: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const conversation = await api.ensureAssistant();
      await refreshConversations();
      if (content) await sendMessageToConversation(conversation.id, content);
      setPrompt('');
      if (onOpenConversation) onOpenConversation(conversation.id);
      else navigation.replace('Chat', { conversationId: conversation.id });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reach My Agent.');
    } finally {
      setBusy(false);
    }
  };

  const sendInPanel = async () => {
    const content = prompt.trim();
    if (!content || busy || !agentConversationId) return;
    setBusy(true);
    setError(null);
    try {
      const message = await api.sendMessage(agentConversationId, content);
      setThreadMessages(previous => previous.some(item => item.id === message.id) ? previous : [...previous, message]);
      setPrompt('');
      setTimeout(() => { void refreshThread(); }, 800);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not message My Agent.');
    } finally {
      setBusy(false);
    }
  };

  if (embedded) {
    return (
      <KeyboardAvoidingView style={[styles.root, { backgroundColor: c.background }]} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View
          style={[styles.threadHeader, { backgroundColor: c.surface, borderBottomColor: c.border }]}
        >
          <View style={[styles.threadMark, { backgroundColor: c.primaryMuted, borderColor: c.primary }]}>
            <AppIcon name="sparkle" color={c.primary} size={18} />
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={[styles.threadTitle, { color: c.textPrimary }]}>My Agent</Text>
            <Text style={[styles.threadSubtitle, { color: c.textMuted }]}>Private conversation</Text>
          </View>
          <TouchableOpacity onPress={() => navigation.navigate('SocialReview')} accessibilityLabel="Open Review" style={styles.threadHeaderButton}>
            <AppIcon name="sparkle" color={c.primary} size={18} />
          </TouchableOpacity>
          {onClose && (
            <TouchableOpacity onPress={onClose} accessibilityLabel="Close My Agent" style={styles.threadHeaderButton}>
              <AppIcon name="x" color={c.textSecondary} size={20} />
            </TouchableOpacity>
          )}
        </View>
        {loadingThread ? (
          <View style={styles.threadLoading}><ActivityIndicator color={c.primary} /></View>
        ) : (
          <FlatList
            data={threadMessages}
            keyExtractor={message => message.id}
            contentContainerStyle={styles.threadList}
            keyboardShouldPersistTaps="handled"
            renderItem={({ item }) => {
              const isNetworkCard = item.messageType === 'card' && ['intent_draft', 'match_proposal', 'match_status', 'match_context'].includes(item.cardKind ?? '');
              if (isNetworkCard) {
                return (
                  <AgentNetworkCard
                    message={item}
                    onOpenConversation={(conversationId) => onOpenConversation?.(conversationId)}
                    onShareDraft={(draftId, initialText) => navigation.navigate('StoryComposer', { draftId, initialText })}
                  />
                );
              }
              const own = item.senderId === currentUser?.userId;
              return (
                <View style={[styles.threadBubble, own ? styles.threadBubbleOwn : styles.threadBubbleAgent, { backgroundColor: own ? c.primaryMuted : c.surface, borderColor: c.border }]}>
                  {!own && <Text style={[styles.threadSender, { color: c.primary }]}>My Agent</Text>}
                  <Text style={[styles.threadText, { color: c.textPrimary }]}>{item.content}</Text>
                </View>
              );
            }}
            ListEmptyComponent={<Text style={[styles.threadEmpty, { color: c.textSecondary }]}>Tell My Agent what you’re looking for, offering, or thinking about. It stays private until you approve a next step.</Text>}
          />
        )}
        <View
          style={[styles.threadComposer, { backgroundColor: c.surface, borderTopColor: c.border }]}
        >
          <TextInput
            value={prompt}
            onChangeText={setPrompt}
            multiline
            placeholder="Message My Agent privately…"
            placeholderTextColor={c.textMuted}
            accessibilityLabel="Message My Agent"
            style={[styles.threadInput, { color: c.textPrimary, backgroundColor: c.background, borderColor: c.border }]}
          />
          <TouchableOpacity disabled={!prompt.trim() || busy || !agentConversationId} onPress={() => void sendInPanel()} accessibilityLabel="Send privately to My Agent" style={[styles.threadSend, { backgroundColor: c.primary }, (!prompt.trim() || busy || !agentConversationId) && styles.disabled]}>
            {busy ? <ActivityIndicator size="small" color="#fff" /> : <Text style={styles.sendText}>Send</Text>}
          </TouchableOpacity>
        </View>
        {error && <Text accessibilityRole="alert" style={[styles.threadError, { color: c.danger, backgroundColor: c.background }]}>{error}</Text>}
      </KeyboardAvoidingView>
    );
  }

  return (
    <KeyboardAvoidingView style={[styles.root, { backgroundColor: c.background }]} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {embedded && onClose && (
          <TouchableOpacity onPress={onClose} accessibilityLabel="Close My Agent" style={styles.closeButton}>
            <AppIcon name="x" color={c.textSecondary} size={20} />
          </TouchableOpacity>
        )}
        <View style={styles.headingRow}>
          <View style={[styles.agentMark, { backgroundColor: c.primaryMuted, borderColor: c.primary }]}>
            <AppIcon name="sparkle" color={c.primary} size={23} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[styles.eyebrow, { color: c.primary }]}>PRIVATE BY DEFAULT</Text>
            <Text style={[styles.title, { color: c.textPrimary }]}>Tell My Agent anything</Text>
          </View>
        </View>
        <Text style={[styles.intro, { color: c.textSecondary }]}>Your message starts as a private conversation. If it sounds like an ask, offer, or shared goal, your agent will prepare a card and ask before searching or sharing.</Text>

        <View style={[styles.composer, { backgroundColor: c.surface, borderColor: c.border }]}>
          <TextInput
            autoFocus
            multiline
            value={prompt}
            onChangeText={setPrompt}
            placeholder="What are you looking for, offering, or thinking about?"
            placeholderTextColor={c.textMuted}
            accessibilityLabel="Message My Agent"
            style={[styles.input, { color: c.textPrimary }]}
          />
          <View style={styles.composerFooter}>
            <Text style={[styles.privateNote, { color: c.textMuted }]}>Only you and My Agent can see this message.</Text>
            <TouchableOpacity disabled={!prompt.trim() || busy} onPress={() => void openConversation(prompt.trim())} accessibilityLabel="Send privately to My Agent" style={[styles.send, { backgroundColor: c.primary }, (!prompt.trim() || busy) && styles.disabled]}>
              {busy ? <ActivityIndicator size="small" color="#fff" /> : <Text style={styles.sendText}>Send</Text>}
            </TouchableOpacity>
          </View>
        </View>

        <Text style={[styles.suggestionLabel, { color: c.textMuted }]}>TRY SAYING</Text>
        <View style={styles.suggestions}>
          {EXAMPLES.map(example => (
            <TouchableOpacity key={example} onPress={() => setPrompt(example)} style={[styles.suggestion, { backgroundColor: c.surface, borderColor: c.border }]}>
              <Text style={[styles.suggestionText, { color: c.textSecondary }]}>{example}</Text>
            </TouchableOpacity>
          ))}
        </View>

        <View style={[styles.reviewCard, { backgroundColor: c.surface, borderColor: c.border }]}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={[styles.reviewTitle, { color: c.textPrimary }]}>Review</Text>
            <Text style={[styles.reviewText, { color: c.textSecondary }]}>{loadingReview ? 'Checking for decisions…' : reviewItems.length ? `${reviewItems.length} item${reviewItems.length === 1 ? '' : 's'} need your attention.` : 'Nothing needs a decision right now.'}</Text>
          </View>
          <TouchableOpacity onPress={() => navigation.navigate('SocialReview')} style={[styles.reviewButton, { borderColor: c.border }]}>
            <Text style={{ color: c.primary, fontWeight: '800' }}>Open</Text>
          </TouchableOpacity>
        </View>

        <TouchableOpacity disabled={busy} onPress={() => void openConversation()} style={styles.fullChatButton}>
          <Text style={{ color: c.primary, fontWeight: '700' }}>Open the full My Agent conversation</Text>
        </TouchableOpacity>
        {error && <Text accessibilityRole="alert" style={[styles.error, { color: c.danger }]}>{error}</Text>}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  threadHeader: { minHeight: 58, borderBottomWidth: StyleSheet.hairlineWidth, paddingLeft: 12, paddingRight: 4, flexDirection: 'row', alignItems: 'center', gap: 9 },
  threadMark: { width: 34, height: 34, borderRadius: 11, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center' },
  threadTitle: { fontFamily: serif, fontSize: 18, fontWeight: '600' },
  threadSubtitle: { fontSize: 11, marginTop: 1 },
  threadHeaderButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  threadLoading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  threadList: { flexGrow: 1, justifyContent: 'flex-end', padding: 12, gap: 8 },
  threadEmpty: { fontSize: 13, lineHeight: 20, textAlign: 'center', padding: 18 },
  threadBubble: { maxWidth: '88%', borderWidth: StyleSheet.hairlineWidth, borderRadius: 15, paddingHorizontal: 12, paddingVertical: 9 },
  threadBubbleOwn: { alignSelf: 'flex-end', borderBottomRightRadius: 5 },
  threadBubbleAgent: { alignSelf: 'flex-start', borderBottomLeftRadius: 5 },
  threadSender: { fontSize: 10, fontWeight: '800', marginBottom: 3 },
  threadText: { fontSize: 14, lineHeight: 20 },
  threadComposer: { borderTopWidth: StyleSheet.hairlineWidth, padding: 10, flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  threadInput: { flex: 1, maxHeight: 120, minHeight: 44, borderWidth: StyleSheet.hairlineWidth, borderRadius: 13, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, textAlignVertical: 'top' },
  threadSend: { minWidth: 64, minHeight: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12 },
  threadError: { paddingHorizontal: 12, paddingVertical: 7, fontSize: 12 },
  content: { width: '100%', maxWidth: 680, alignSelf: 'center', padding: 20, paddingBottom: 70 },
  closeButton: { width: 44, height: 44, alignSelf: 'flex-end', alignItems: 'center', justifyContent: 'center', marginTop: -10, marginRight: -10 },
  headingRow: { flexDirection: 'row', alignItems: 'center', gap: 13 },
  agentMark: { width: 48, height: 48, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center' },
  eyebrow: { ...capsLabel },
  title: { fontFamily: serif, fontSize: 28, fontWeight: '600', marginTop: 3 },
  intro: { fontSize: 14, lineHeight: 21, marginTop: 13, maxWidth: 590 },
  composer: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 18, padding: 14, marginTop: 20 },
  input: { minHeight: 118, fontSize: 18, lineHeight: 26, textAlignVertical: 'top' },
  composerFooter: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 8 },
  privateNote: { flex: 1, fontSize: 11, lineHeight: 16 },
  send: { minWidth: 80, minHeight: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
  sendText: { color: '#fff', fontWeight: '800' },
  disabled: { opacity: 0.45 },
  suggestionLabel: { ...capsLabel, marginTop: 24, marginBottom: 8 },
  suggestions: { gap: 7 },
  suggestion: { minHeight: 44, borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, paddingHorizontal: 13, paddingVertical: 11, justifyContent: 'center' },
  suggestionText: { fontSize: 13, lineHeight: 19 },
  reviewCard: { marginTop: 24, borderWidth: StyleSheet.hairlineWidth, borderRadius: 16, padding: 15, flexDirection: 'row', alignItems: 'center', gap: 12 },
  reviewTitle: { fontFamily: serif, fontSize: 19, fontWeight: '600' },
  reviewText: { fontSize: 12, lineHeight: 18, marginTop: 3 },
  reviewButton: { minWidth: 70, minHeight: 44, borderWidth: StyleSheet.hairlineWidth, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  fullChatButton: { minHeight: 50, alignItems: 'center', justifyContent: 'center', marginTop: 10 },
  error: { fontSize: 13, lineHeight: 19, marginTop: 8 },
});
