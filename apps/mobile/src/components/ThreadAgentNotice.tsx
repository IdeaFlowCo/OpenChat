import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { getSocket } from '../api/socket';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';
import { radius, space, type } from '../theme/tokens';
import { hasAgentTag, isTypingAgentTag } from '../utils/agentTag';
import { AppIcon } from './AppIcon';

type Status = { conversationId?: string; messageId?: string; state?: 'working' | 'answered' | 'failed'; code?: string };

/** Plain words for a refusal code; never raw server text. */
export function threadAgentFailureText(code: string | undefined): string {
  if (code === 'cap') return 'Your agent has used its allowance for this month. Nothing was posted.';
  if (code === 'rate') return 'Your agent has answered a lot this hour. Try again later.';
  if (code === 'repeat') return 'Your agent already answered this message.';
  if (code === 'unavailable') return 'OpenChat agents are not available right now. Your message was sent.';
  if (code === 'changed') return 'The chat changed before your agent could answer. Nothing was posted.';
  if (code === 'named') return 'Here @agent mentions a person, so your agent did not answer. Hold your message and choose Ask my agent.';
  return 'Your agent could not answer. Your message was sent; nothing else was posted.';
}

/**
 * The composer's line about `@agent`: offers the tag while it is being typed,
 * says before sending who will see the answer, and afterwards shows that the
 * agent is working or why it did not answer. Only the sender sees this line.
 */
export function ThreadAgentNotice({ conversationId, text, onInsert, offerTag = true }: {
  conversationId: string; text: string; onInsert: () => void;
  /** False while editing, or where @agent mentions a person: progress and refusals still show. */
  offerTag?: boolean;
}) {
  const { scheme } = useTheme();
  const c = getColors(scheme);
  const [status, setStatus] = useState<Status | null>(null);
  useEffect(() => { setStatus(null); }, [conversationId]);
  useEffect(() => {
    const socket = getSocket();
    const onStatus = (payload: Status) => {
      if (payload?.conversationId !== conversationId) return;
      // An answer only clears the line for the message it answers, never a newer question's.
      if (payload.state === 'answered') setStatus(current => (current?.messageId === payload.messageId ? null : current));
      else setStatus(payload);
    };
    socket?.on('agent-reply:status', onStatus);
    return () => { socket?.off('agent-reply:status', onStatus); };
  }, [conversationId]);
  // A refusal clears itself; "working" clears itself too if the answer event is lost.
  useEffect(() => {
    if (!status) return;
    const timer = setTimeout(() => setStatus(null), status.state === 'failed' ? 8000 : 45000);
    return () => clearTimeout(timer);
  }, [status]);

  const card = [styles.card, { backgroundColor: c.surface, borderColor: c.border }];
  if (offerTag && hasAgentTag(text)) {
    return <View accessibilityRole="summary" style={card}>
      <AppIcon name="bot" color={c.primary} size={16} />
      <Text style={{ ...type.meta, color: c.textMetadata, flex: 1 }}>
        Your OpenChat agent will answer here, from this chat’s recent messages. Everyone in this chat sees your message and its answer.
      </Text>
    </View>;
  }
  if (offerTag && isTypingAgentTag(text)) {
    return <TouchableOpacity accessibilityRole="button" accessibilityLabel="Tag @agent: ask your agent about this chat" onPress={onInsert} style={card}>
      <AppIcon name="bot" color={c.primary} size={16} />
      <Text style={{ ...type.label, color: c.textPrimary }}>@agent</Text>
      <Text style={{ ...type.meta, color: c.textMetadata, flex: 1 }} numberOfLines={1}>Ask your agent about this chat</Text>
    </TouchableOpacity>;
  }
  if (status?.state === 'working') {
    return <View accessibilityRole="summary" accessibilityLiveRegion="polite" style={card}>
      <ActivityIndicator accessibilityLabel="Waiting for your agent" color={c.primary} size="small" />
      <Text style={{ ...type.meta, color: c.textMetadata, flex: 1 }}>Your agent is reading this chat…</Text>
    </View>;
  }
  if (status?.state === 'failed') {
    return <View accessibilityRole="alert" style={card}>
      <Text style={{ ...type.meta, color: c.danger, flex: 1 }}>{threadAgentFailureText(status.code)}</Text>
    </View>;
  }
  return null;
}

const styles = StyleSheet.create({
  card: { flexDirection: 'row', alignItems: 'center', gap: space[2], borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, paddingHorizontal: space[3], paddingVertical: space[2], marginHorizontal: space[3], marginBottom: space[2] },
});
