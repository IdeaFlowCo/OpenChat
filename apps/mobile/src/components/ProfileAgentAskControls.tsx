import { useRef, useState } from 'react';
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
  if (code === 'off') return `${name} has turned off their OpenChat agent.`;
  if (code === 'self') return 'This is your own message.';
  if (code === 'automatic') return 'Agents do not answer automatic replies.';
  if (code === 'cap') return `${name}'s agent has used its allowance for now. Try again later.`;
  if (code === 'repeat') return 'This agent already answered this message for you.';
  if (status === 429) return 'Too many agent questions right now. Try again later.';
  if (status === 503) return 'OpenChat agents are not available right now.';
  return 'The agent could not answer. Nothing was posted.';
}

/**
 * "Ask {name}'s agent": the author's built-in OpenChat agent answers in this
 * chat, labelled as their agent and not them. It knows only what they shared.
 */
export function ProfileAgentAskControls({ messageId, name, onAnswered }: { messageId: string; name: string; onAnswered: () => void }) {
  const { scheme } = useTheme();
  const c = getColors(scheme);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const sending = useRef(false);

  const ask = async () => {
    if (sending.current) return;
    sending.current = true; setBusy(true); setError('');
    try {
      await api.askProfileAgent(messageId, question.trim() || undefined);
      onAnswered();
    } catch (e) {
      setError(profileAgentErrorText(e, name));
    } finally { sending.current = false; setBusy(false); }
  };

  return <View style={{ gap: space[3] }}>
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
    <Button label={busy ? 'Asking…' : 'Ask now'} disabled={busy} onPress={() => { void ask(); }} />
    {busy && <ActivityIndicator accessibilityLabel="Waiting for the agent" color={c.primary} />}
    <Text style={{ ...type.meta, color: c.textMetadata }}>Everyone in this chat sees the answer, your question, and that you asked.</Text>
  </View>;
}
