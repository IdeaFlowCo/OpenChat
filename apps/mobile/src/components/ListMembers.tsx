/**
 * The people on one of your private lists (Noos `list` kind, 2026-11-05):
 * one page at a time, newest pages appended, each removable. Being on a list
 * is your own bookkeeping, never a connection, and nobody is notified.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { api, type PrivateListMember } from '../api/client';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';
import { radius, space, touchTarget, type } from '../theme/tokens';
import { Button } from './ui';

export function ListMembers({ listId, onOpenThing, onOpenPerson }: { listId: string; onOpenThing: (thingId: string) => void; onOpenPerson: (userId: string) => void }) {
  const { scheme } = useTheme();
  const c = getColors(scheme);
  const [members, setMembers] = useState<PrivateListMember[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  // Only the latest load for this list may change the list shown.
  const latest = useRef(0);
  // Memberships removed while a page was loading must not reappear when that page lands.
  const removed = useRef(new Set<string>());

  const load = useCallback(async (after: string | null) => {
    const request = ++latest.current;
    setLoading(true);
    try {
      const page = await api.listPrivateListMembers(listId, after ?? undefined);
      if (request !== latest.current) return;
      const fresh = page.members.filter(member => !removed.current.has(member.linkId));
      setMembers(current => after ? [...current, ...fresh.filter(member => !current.some(known => known.linkId === member.linkId))] : fresh);
      setCursor(page.nextCursor);
      setError(null);
    } catch {
      if (request === latest.current) setError('Could not load the members of this list.');
    } finally {
      if (request === latest.current) setLoading(false);
    }
  }, [listId]);
  useEffect(() => { removed.current = new Set(); setMembers([]); setCursor(null); void load(null); }, [load]);

  const remove = async (member: PrivateListMember) => {
    setBusy(member.linkId);
    try {
      await api.removePrivateListMember(listId, member.linkId);
      removed.current.add(member.linkId);
      setMembers(current => current.filter(known => known.linkId !== member.linkId));
    } catch {
      setError(`Could not remove ${member.member.name}.`);
    } finally {
      setBusy(null);
    }
  };
  const add = async () => {
    const text = name.trim();
    if (!text) return;
    setBusy('new');
    try {
      const added = await api.addPrivateListMember(listId, { kind: 'person', name: text });
      setMembers(current => current.some(known => known.linkId === added.linkId) ? current : [...current, added]);
      setName('');
      setError(null);
    } catch (err) {
      // A name shared by several saved people is never merged: say so rather than guess.
      setError(err instanceof Error && err.message.includes('409') ? `More than one saved person is called ${text}. Add them from their own page instead.` : `Could not add ${text}.`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <View style={styles.root}>
      <Text style={[type.eyebrow, { color: c.textMetadata }]}>MEMBERS · ONLY YOU SEE THIS LIST</Text>
      {members.map(member => (
        <View key={member.linkId} style={[styles.row, { borderColor: c.border, backgroundColor: c.surface }]}>
          <TouchableOpacity accessibilityRole="link" accessibilityLabel={`Open ${member.member.name}`} style={styles.name}
            onPress={() => member.member.kind === 'user' ? onOpenPerson(member.member.id) : onOpenThing(member.member.id)}>
            <Text style={[type.bodyStrong, { color: c.textPrimary }]} numberOfLines={1}>{member.member.name}</Text>
            {member.member.kind === 'user' && <Text style={[type.meta, { color: c.textMetadata }]}>On OpenChat</Text>}
          </TouchableOpacity>
          <Button label="Remove" size="sm" variant="ghost" disabled={busy === member.linkId} accessibilityLabel={`Remove ${member.member.name} from this list`} onPress={() => void remove(member)} />
        </View>
      ))}
      {!loading && !members.length && !cursor && !error && <Text style={[type.label, { color: c.textSecondary }]}>Nobody on this list yet.</Text>}
      {loading ? <ActivityIndicator color={c.primary} /> : cursor ? <Button label="Show more" size="sm" onPress={() => void load(cursor)} /> : null}
      <View style={[styles.add, { borderColor: c.border, backgroundColor: c.surface }]}>
        <TextInput value={name} onChangeText={setName} placeholder="Add a saved person by name" placeholderTextColor={c.textMetadata} maxLength={120}
          accessibilityLabel="Add a saved person to this list by name" onSubmitEditing={() => void add()} returnKeyType="done" style={[type.body, styles.input, { color: c.textPrimary }]} />
        <Button label="Add" size="sm" variant="primary" disabled={!name.trim() || busy === 'new'} onPress={() => void add()} />
      </View>
      {error && <Text accessibilityRole="alert" style={[type.meta, { color: c.danger }]}>{error}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: space[2] },
  row: { flexDirection: 'row', alignItems: 'center', gap: space[2], borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, paddingLeft: space[3], paddingRight: space[1], minHeight: touchTarget },
  name: { flex: 1, minHeight: touchTarget, justifyContent: 'center' },
  add: { flexDirection: 'row', alignItems: 'center', gap: space[2], borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, paddingLeft: space[3], paddingRight: space[1], minHeight: touchTarget + space[2] },
  input: { flex: 1, minHeight: touchTarget },
});
