import { useEffect, useState, useRef, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  ActivityIndicator,
  useColorScheme,
} from 'react-native';
import { api, Conversation, Message, getUser, CurrentUser } from '../api/client';
import { getSocket, joinConversation, leaveConversation, sendMessage as wsSend } from '../api/socket';
import { getColors } from '../theme/colors';

interface Props {
  conversation: Conversation;
  onBack: () => void;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function ChatScreen({ conversation, onBack }: Props) {
  const scheme = useColorScheme() || 'light';
  const c = getColors(scheme);
  const [me, setMe] = useState<CurrentUser | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const listRef = useRef<FlatList<Message>>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setMe(await getUser());
      try {
        const msgs = await api.getMessages(conversation.id);
        if (!cancelled) {
          setMessages(msgs);
          setLoading(false);
          setTimeout(() => listRef.current?.scrollToEnd({ animated: false }), 50);
        }
      } catch (err) {
        console.warn('Failed to load messages:', err);
        setLoading(false);
      }
    })();
    joinConversation(conversation.id);
    const sock = getSocket();
    const onMessage = (msg: Message) => {
      if (msg.conversationId !== conversation.id) return;
      setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 50);
    };
    sock?.on('message:new', onMessage);
    return () => {
      cancelled = true;
      sock?.off('message:new', onMessage);
      leaveConversation(conversation.id);
    };
  }, [conversation.id]);

  const handleSend = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    setSending(true);
    setText('');
    try {
      await wsSend(conversation.id, trimmed);
    } catch (err) {
      console.warn('Socket send failed, falling back to REST:', err);
      try {
        const msg = await api.sendMessage(conversation.id, trimmed);
        setMessages((prev) => [...prev, msg]);
      } catch (err2) {
        console.error('REST send failed too:', err2);
      }
    } finally {
      setSending(false);
    }
  }, [conversation.id, text, sending]);

  const title =
    conversation.title ||
    (conversation.type === 'direct'
      ? conversation.participants?.find((p) => p.user.id !== me?.userId)?.user.name ||
        conversation.participants?.find((p) => p.user.id !== me?.userId)?.user.email ||
        'Chat'
      : 'Group Chat');

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={[styles.root, { backgroundColor: c.background }]}
    >
      <View style={[styles.header, { backgroundColor: c.surface, borderColor: c.border }]}>
        <TouchableOpacity onPress={onBack} style={styles.backButton}>
          <Text style={{ color: c.primary, fontSize: 17 }}>‹ Back</Text>
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: c.textPrimary }]} numberOfLines={1}>
          {title}
        </Text>
        <View style={styles.backButton} />
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={c.primary} />
        </View>
      ) : (
        <FlatList
          ref={listRef}
          data={messages}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{ padding: 12, gap: 8 }}
          onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
          renderItem={({ item }) => {
            const isOwn = item.senderId === me?.userId;
            return (
              <View style={[styles.row, { justifyContent: isOwn ? 'flex-end' : 'flex-start' }]}>
                <View
                  style={[
                    styles.bubble,
                    {
                      backgroundColor: isOwn ? c.bubbleOwn : c.bubbleOther,
                      borderBottomRightRadius: isOwn ? 4 : 18,
                      borderBottomLeftRadius: isOwn ? 18 : 4,
                    },
                  ]}
                >
                  {!isOwn && item.sender && (
                    <Text style={[styles.sender, { color: c.textSecondary }]}>
                      {item.sender.name || item.sender.email}
                    </Text>
                  )}
                  <Text style={{ color: isOwn ? c.bubbleOwnText : c.bubbleOtherText, fontSize: 16 }}>
                    {item.content}
                  </Text>
                  <Text style={[styles.time, { color: isOwn ? 'rgba(255,255,255,0.7)' : c.textMuted }]}>
                    {formatTime(item.createdAt)}
                  </Text>
                </View>
              </View>
            );
          }}
        />
      )}

      <View style={[styles.composer, { backgroundColor: c.surface, borderColor: c.border }]}>
        <TextInput
          style={[styles.input, { backgroundColor: c.surfaceElevated, color: c.textPrimary, borderColor: c.border }]}
          value={text}
          onChangeText={setText}
          placeholder="Type a message…"
          placeholderTextColor={c.textMuted}
          multiline
        />
        <TouchableOpacity
          style={[styles.send, { backgroundColor: c.primary, opacity: !text.trim() || sending ? 0.5 : 1 }]}
          onPress={handleSend}
          disabled={!text.trim() || sending}
        >
          <Text style={{ color: '#fff', fontWeight: '600' }}>Send</Text>
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  backButton: { width: 64, paddingVertical: 4 },
  headerTitle: { flex: 1, textAlign: 'center', fontSize: 17, fontWeight: '600' },
  row: { flexDirection: 'row' },
  bubble: {
    maxWidth: '78%',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 18,
  },
  sender: { fontSize: 12, marginBottom: 2, fontWeight: '500' },
  time: { fontSize: 10, marginTop: 4 },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: 8,
  },
  input: {
    flex: 1,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    fontSize: 16,
    minHeight: 40,
    maxHeight: 120,
  },
  send: {
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
