import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Text, TextInput, View } from 'react-native';
import { api, ApiError } from '../api/client';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';
import { radius, space, type } from '../theme/tokens';
import { Button } from './ui';

const MAX_QUESTION = 500;

/** Map server refusals to plain words; never echo raw server text for unknown failures. */
export function profileAgentErrorText(error: unknown, name: string): string {
  const status = error instanceof ApiError ? error.status : undefined;
  let code: string | undefined;
  if (error instanceof ApiError) { try { code = JSON.parse(error.body)?.code; } catch { code = undefined; } }
  if (code === 'announcements') return 'Agents do not answer in announcement chats.';
  if (code === 'bot') return 'Agents answer in chats between people.';
  if (code === 'off') return `${name} hasn’t turned on their OpenChat agent.`;
  if (code === 'self') return 'This is your own message.';
  if (code === 'automatic') return 'Agents do not answer automatic replies.';
  if (code === 'cap') return `${name}'s agent has used its allowance for now. Try again later.`;
  if (code === 'repeat') return 'This agent already answered this message for you.';
  if (status === 429) return 'Too many agent questions right now. Try again later.';
  if (status === 503) return 'OpenChat agents are not available right now.';
  return 'The agent could not answer. Nothing was posted.';
}

/** The same, for your own agent ("Ask my agent" and @agent). */
export function myAgentErrorText(error: unknown): string {
  const status = error instanceof ApiError ? error.status : undefined;
  let code: string | undefined;
  if (error instanceof ApiError) { try { code = JSON.parse(error.body)?.code; } catch { code = undefined; } }
  if (code === 'announcements') return 'Agents do not answer in announcement chats.';
  if (code === 'bot') return 'Agents answer in chats between people.';
  if (code === 'automatic') return 'Agents do not answer automatic replies.';
  if (code === 'cap') return 'Your agent has used its allowance for this month.';
  if (code === 'repeat') return 'Your agent already answered this message.';
  if (status === 429) return 'Your agent has answered a lot this hour. Try again later.';
  if (status === 503) return 'OpenChat agents are not available right now.';
  return 'Your agent could not answer. Nothing was posted.';
}

/**
 * "Ask {name}'s agent": the author's built-in OpenChat agent answers in this
 * chat, labelled as their agent and not them. It knows only what they shared.
 */
export function ProfileAgentAskControls({ messageId, name, onAnswered, mine = false }: {
  messageId: string; name: string; onAnswered: () => void;
  /** Your own agent, answering about this thread (the same as tagging @agent). */
  mine?: boolean;
}) {
  const { scheme } = useTheme();
  const c = getColors(scheme);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const sending = useRef(false);
  // Opt-in: check first whether this person turned their agent on (null while checking or unknown).
  const [enabled, setEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    let current = true;
    (mine ? api.getProfileAgentAvailability(messageId, 'mine') : api.getProfileAgentAvailability(messageId))
      .then(value => { if (current) setEnabled(value.enabled && value.available); })
      .catch(() => { if (current) setEnabled(true); }); // The server still enforces opt-in when asked.
    return () => { current = false; };
  }, [messageId, mine]);

  const ask = async () => {
    if (sending.current) return;
    sending.current = true; setBusy(true); setError('');
    try {
      if (mine) await api.askProfileAgent(messageId, question.trim() || undefined, 'mine');
      else await api.askProfileAgent(messageId, question.trim() || undefined);
      onAnswered();
    } catch (e) {
      setError(mine ? myAgentErrorText(e) : profileAgentErrorText(e, name));
    } finally { sending.current = false; setBusy(false); }
  };

  if (mine) {
    return <View style={{ gap: space[3], paddingHorizontal: space[4], paddingTop: space[2] }}>
      <Text style={{ ...type.title, color: c.textPrimary }}>Ask my agent</Text>
      <Text style={{ ...type.body, color: c.textMetadata }}>
        Your built-in OpenChat agent answers here right away, labelled as your agent, not you. It reads only this chat’s recent messages and what you shared here. Typing @agent in a message does the same.
      </Text>
      <TextInput
        accessibilityLabel="Question for your agent (optional)"
        placeholder="Optional: what do you want to know about this chat?"
        placeholderTextColor={c.textMuted}
        value={question}
        maxLength={MAX_QUESTION}
        onChangeText={setQuestion}
        multiline
        style={{ ...type.body, minHeight: 64, padding: space[3], borderRadius: radius.md, borderWidth: 1, borderColor: c.border, backgroundColor: c.surfaceElevated, color: c.textPrimary }}
      />
      {!!error && <Text accessibilityRole="alert" style={{ ...type.body, color: c.danger }}>{error}</Text>}
      {enabled === false && <Text accessibilityRole="alert" style={{ ...type.body, color: c.textMetadata }}>OpenChat agents are not available right now.</Text>}
      <Button label={busy ? 'Asking…' : 'Ask now'} variant="primary" disabled={busy || !enabled} onPress={() => { void ask(); }} />
      {busy && <ActivityIndicator accessibilityLabel="Waiting for your agent" color={c.primary} />}
      <Text style={{ ...type.meta, color: c.textMetadata }}>Everyone in this chat sees the answer, your question, and that you asked.</Text>
    </View>;
  }

  if (enabled === false) {
    return <View style={{ gap: space[3], paddingHorizontal: space[4], paddingTop: space[2] }}>
      <Text style={{ ...type.title, color: c.textPrimary }}>Ask {name}’s agent</Text>
      <Text accessibilityRole="alert" style={{ ...type.body, color: c.textMetadata }}>{name} hasn’t turned on their OpenChat agent. You can reply to them directly.</Text>
    </View>;
  }

  return <View style={{ gap: space[3], paddingHorizontal: space[4], paddingTop: space[2] }}>
    <Text style={{ ...type.title, color: c.textPrimary }}>Ask {name}’s agent</Text>
    <Text style={{ ...type.body, color: c.textMetadata }}>
      {name}’s built-in OpenChat agent answers here right away, labelled as their agent, not {name}. It only knows what {name} shared in this chat and on their public card.
    </Text>
    <TextInput
      accessibilityLabel="Question for the agent (optional)"
      placeholder="Optional: what do you want to know?"
      placeholderTextColor={c.textMuted}
      value={question}
      maxLength={MAX_QUESTION}
      onChangeText={setQuestion}
      multiline
      style={{ ...type.body, minHeight: 64, padding: space[3], borderRadius: radius.md, borderWidth: 1, borderColor: c.border, backgroundColor: c.surfaceElevated, color: c.textPrimary }}
    />
    {!!error && <Text accessibilityRole="alert" style={{ ...type.body, color: c.danger }}>{error}</Text>}
    <Button label={busy ? 'Asking…' : 'Ask now'} variant="primary" disabled={busy || enabled === null} onPress={() => { void ask(); }} />
    {busy && <ActivityIndicator accessibilityLabel="Waiting for the agent" color={c.primary} />}
    <Text style={{ ...type.meta, color: c.textMetadata }}>Everyone in this chat sees the answer, your question, and that you asked.</Text>
  </View>;
}
