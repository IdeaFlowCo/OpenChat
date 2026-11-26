import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { api, type ThoughtStatus } from '../api/client';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';
import { space, type } from '../theme/tokens';
import { Button } from './ui';

const choices = [
  { value: 'open', label: 'Open' },
  { value: 'closed', label: 'Closed' },
  { value: 'none', label: 'No status' },
] as const;

/** Status starts in the owner’s Stream; this action never shares or posts it. */
export function MessageStatusControls({ messageId }: { messageId: string }) {
  const { scheme } = useTheme();
  const c = getColors(scheme);
  const [status, setStatus] = useState<ThoughtStatus | null>(null);
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
      .then(value => { if (current) setStatus(value.status); })
      .catch(() => { if (current) setError('Could not load this message’s status.'); });
    return () => { current = false; generation.current++; };
  }, [messageId, revision]);

  const save = async (next: ThoughtStatus) => {
    if (saving.current || status === null) return;
    const requestGeneration = generation.current;
    saving.current = true;
    setBusy(true);
    setError('');
    setSaved(false);
    try {
      const value = await api.setMessageStatus(messageId, next);
      if (requestGeneration === generation.current) {
        setStatus(value.status);
        setSaved(true);
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

  return <View style={{ gap: space[3] }}>
    <Text style={{ ...type.title, color: c.textPrimary }}>Message status</Text>
    <Text style={{ ...type.body, color: c.textMetadata }}>Private by default · saved in your Stream</Text>
    <Text style={{ ...type.meta, color: c.textMetadata }}>Sharing is a separate action in Stream.</Text>
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
        onPress={() => { void save(choice.value); }}
      />)}
    </>}
    {busy && <ActivityIndicator accessibilityLabel="Saving message status" color={c.primary} />}
    {saved && <Text accessibilityLiveRegion="polite" style={{ ...type.meta, color: c.textMetadata }}>Status saved</Text>}
  </View>;
}
