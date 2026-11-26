import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { api, type MessageStatusVisibility, type ThoughtStatus } from '../api/client';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';
import { space, type } from '../theme/tokens';
import { Button, Chip } from './ui';

const choices = [
  { value: 'open', label: 'Open' },
  { value: 'closed', label: 'Closed' },
  { value: 'none', label: 'No status' },
] as const;

const audiences = [
  { value: 'chat', label: 'This chat' },
  { value: 'private', label: 'Only me' },
] as const;

/**
 * Same states as Stream items. "This chat" shares the status capture with the
 * conversation the way Stream shares any item (a pin), so participants see a
 * chip on the message; "Only me" keeps it in the owner's Stream alone.
 */
export function MessageStatusControls({ messageId, onSaved }: { messageId: string; onSaved?: () => void }) {
  const { scheme } = useTheme();
  const c = getColors(scheme);
  const [status, setStatus] = useState<ThoughtStatus | null>(null);
  const [visibility, setVisibility] = useState<MessageStatusVisibility>('chat');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [saved, setSaved] = useState(false);
  const generation = useRef(0);
  const saving = useRef(false);

  useEffect(() => {
    let current = true;
    generation.current++;
    saving.current = false;
    setBusy(false);
    setStatus(null);
    setError('');
    setSaved(false);
    api.getMessageStatus(messageId)
      .then(value => {
        if (!current) return;
        setStatus(value.status);
        // A message without a status starts shared with the chat; an existing
        // status keeps whatever its owner chose.
        setVisibility(value.status === 'none' ? 'chat' : value.visibility ?? 'private');
      })
      .catch(() => { if (current) setError('Could not load this message’s status.'); });
    return () => { current = false; generation.current++; };
  }, [messageId, revision]);

  const save = async (next: ThoughtStatus, nextVisibility: MessageStatusVisibility) => {
    if (saving.current || status === null) return;
    const requestGeneration = generation.current;
    saving.current = true;
    setBusy(true);
    setError('');
    setSaved(false);
    try {
      const value = await api.setMessageStatus(messageId, next, nextVisibility);
      if (requestGeneration === generation.current) {
        setStatus(value.status);
        if (value.status !== 'none') setVisibility(value.visibility ?? nextVisibility);
        setSaved(true);
        onSaved?.();
      }
    } catch {
      if (requestGeneration === generation.current) {
        setError('Could not confirm status. Retry safely or reopen to check.');
      }
    } finally {
      if (requestGeneration === generation.current) {
        saving.current = false;
        setBusy(false);
      }
    }
  };

  const chooseAudience = (next: MessageStatusVisibility) => {
    if (busy || next === visibility) return;
    setVisibility(next);
    // With no status yet, the choice applies to the next status you set.
    if (status && status !== 'none') void save(status, next);
  };

  const audienceNote = visibility === 'chat'
    ? 'Everyone in this chat sees the status on the message.'
    : 'Only you see it. It stays in your Stream.';

  return <View style={{ gap: space[3] }}>
    <Text style={{ ...type.title, color: c.textPrimary }}>Message status</Text>
    <Text style={{ ...type.body, color: c.textMetadata }}>Same states as your Stream items.</Text>
    {status === null && !error && <ActivityIndicator accessibilityLabel="Loading message status" color={c.primary} />}
    {!!error && <Text accessibilityRole="alert" style={{ ...type.body, color: c.danger }}>{error}</Text>}
    {status === null && !!error && <Button label="Retry" variant="secondary" onPress={() => setRevision(value => value + 1)} />}
    {status !== null && <>
      <Text style={{ ...type.meta, color: c.textMetadata }}>Current: {choices.find(choice => choice.value === status)?.label}</Text>
      {choices.map(choice => <Button
        key={choice.value}
        label={`${status === choice.value ? '✓ ' : ''}${choice.label}`}
        variant={status === choice.value ? 'primary' : 'secondary'}
        disabled={busy}
        onPress={() => { void save(choice.value, visibility); }}
      />)}
      <Text style={{ ...type.label, color: c.textPrimary }}>Visible to</Text>
      <View accessibilityRole="radiogroup" accessibilityLabel="Visible to" style={{ flexDirection: 'row', gap: space[2] }}>
        {audiences.map(audience => <Chip
          key={audience.value}
          label={audience.label}
          accessibilityRole="radio"
          selected={visibility === audience.value}
          disabled={busy}
          onPress={() => chooseAudience(audience.value)}
        />)}
      </View>
      <Text style={{ ...type.meta, color: c.textMetadata }}>{audienceNote}</Text>
    </>}
    {busy && <ActivityIndicator accessibilityLabel="Saving message status" color={c.primary} />}
    {saved && <Text accessibilityLiveRegion="polite" style={{ ...type.meta, color: c.textMetadata }}>Status saved</Text>}
  </View>;
}
