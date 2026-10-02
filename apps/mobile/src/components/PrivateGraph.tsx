/**
 * Private graph — the signed-in person's own notes and links about someone or
 * something. Nobody else ever sees these, including the person they are about.
 *
 * `PrivateNotes` and `PrivateLinks` work for a contact (`kind: 'user'`) or for
 * a saved company, idea, project or person (`kind: 'thing'`). `PrivateCard`
 * is the collapsed card on a contact's profile: it stays out of the way until
 * opened, so the profile itself reads as it always has.
 */
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import {
  api, type PrivateLink, type PrivateLinkTarget, type PrivateNote, type PrivatePersonCard, type PrivateSubject,
  type PrivateThing, type PrivateThingKind,
} from '../api/client';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';

export const CADENCES: Array<{ label: string; days: number | null }> = [
  { label: 'None', days: null }, { label: 'Weekly', days: 7 }, { label: 'Monthly', days: 30 },
  { label: 'Quarterly', days: 90 }, { label: 'Yearly', days: 365 },
];
export const RELATIONS = ['knows', 'works at', 'works on', 'interested in'];
export const THING_KINDS: Array<{ kind: PrivateThingKind; label: string }> = [
  { kind: 'company', label: 'Company' }, { kind: 'idea', label: 'Idea' }, { kind: 'project', label: 'Project' }, { kind: 'person', label: 'Person' },
];
const kindLabel = (kind: string) => kind === 'user' ? 'on OpenChat' : kind;

export function cadenceLabel(card: Pick<PrivatePersonCard, 'cadenceDays'>): string {
  if (!card.cadenceDays) return '';
  return CADENCES.find(option => option.days === card.cadenceDays)?.label.toLowerCase() ?? `every ${card.cadenceDays} days`;
}

/** "Due now", or the date the next catch-up falls on. */
export function dueLabel(nextDueAt: string | null, now = Date.now()): string {
  if (!nextDueAt) return '';
  const due = Date.parse(nextDueAt);
  if (!Number.isFinite(due)) return '';
  return due <= now ? 'Due now' : `Next catch-up ${new Date(due).toLocaleDateString()}`;
}

export function privateSummary(card: PrivatePersonCard, notes: number, links: number): string {
  const parts = [
    card.important ? 'Important' : '',
    card.cadenceDays ? `catch up ${cadenceLabel(card)}` : '',
    notes ? `${notes} ${notes === 1 ? 'note' : 'notes'}` : '',
    links ? `${links} ${links === 1 ? 'link' : 'links'}` : '',
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'Notes, importance, catch-up and links';
}

type Colors = ReturnType<typeof getColors>;
function Chip({ label, selected, onPress, c, disabled }: { label: string; selected: boolean; onPress: () => void; c: Colors; disabled?: boolean }) {
  return (
    <TouchableOpacity onPress={onPress} disabled={disabled} accessibilityRole="button" accessibilityState={{ selected }}
      style={[styles.chip, { borderColor: c.border, backgroundColor: selected ? c.primary : c.surface }]}>
      <Text style={{ color: selected ? c.onPrimary : c.textPrimary, fontSize: 14 }}>{label}</Text>
    </TouchableOpacity>
  );
}

export function PrivateNotes({ subject, notes, onChange }: { subject: PrivateSubject; notes: PrivateNote[]; onChange: (notes: PrivateNote[]) => void }) {
  const { scheme } = useTheme();
  const c = getColors(scheme);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const add = async () => {
    const value = text.trim();
    if (!value || busy) return;
    setBusy(true); setError(null);
    try { onChange([await api.addPrivateNote(subject, value), ...notes]); setText(''); }
    catch { setError('Could not save the note. Try again.'); }
    finally { setBusy(false); }
  };
  const remove = async (noteId: string) => {
    setBusy(true); setError(null);
    try { await api.deletePrivateNote(noteId); onChange(notes.filter(note => note.id !== noteId)); }
    catch { setError('Could not delete the note. Try again.'); }
    finally { setBusy(false); }
  };

  return (
    <View style={styles.section}>
      <Text style={[styles.heading, { color: c.textPrimary }]}>Notes</Text>
      {notes.map(note => (
        <View key={note.id} style={[styles.item, { borderBottomColor: c.divider }]}>
          <Text style={{ color: c.textPrimary, fontSize: 15 }}>{note.text}</Text>
          <View style={styles.itemMeta}>
            <Text style={{ color: c.textMetadata, fontSize: 12 }}>{new Date(note.createdAt).toLocaleDateString()}</Text>
            <TouchableOpacity onPress={() => void remove(note.id)} disabled={busy}><Text style={{ color: c.textSecondary, fontSize: 13 }}>Delete</Text></TouchableOpacity>
          </View>
        </View>
      ))}
      <TextInput
        value={text} onChangeText={setText} multiline maxLength={4000} editable={!busy}
        placeholder="Add a note only you can see" placeholderTextColor={c.textMuted} accessibilityLabel="Private note"
        style={[styles.input, styles.noteInput, { color: c.textPrimary, borderColor: c.border, backgroundColor: c.background }]}
      />
      <TouchableOpacity onPress={() => void add()} disabled={busy || !text.trim()} style={[styles.button, { backgroundColor: c.primary, opacity: busy || !text.trim() ? 0.5 : 1 }]}>
        <Text style={{ color: c.onPrimary, fontWeight: '700' }}>Add note</Text>
      </TouchableOpacity>
      {error && <Text style={{ color: c.danger }}>{error}</Text>}
    </View>
  );
}

export function PrivateLinks({ subject, links, onChange, onOpenThing, onOpenPerson }: {
  subject: PrivateSubject; links: PrivateLink[]; onChange: (links: PrivateLink[]) => void;
  onOpenThing: (thingId: string) => void; onOpenPerson: (userId: string) => void;
}) {
  const { scheme } = useTheme();
  const c = getColors(scheme);
  const [relation, setRelation] = useState(RELATIONS[0]!);
  const [kind, setKind] = useState<PrivateThingKind>('company');
  const [name, setName] = useState('');
  const [suggestions, setSuggestions] = useState<PrivateThing[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Offer things you already saved, so the same company or idea is linked rather than duplicated.
  useEffect(() => {
    const query = name.trim();
    if (!query) { setSuggestions([]); return; }
    let active = true;
    const timer = setTimeout(() => {
      api.listPrivateThings(query, kind).then(result => { if (active) setSuggestions(result.things.slice(0, 5)); }).catch(() => { if (active) setSuggestions([]); });
    }, 250);
    return () => { active = false; clearTimeout(timer); };
  }, [name, kind]);

  const add = async (target: PrivateLinkTarget) => {
    const label = relation.trim();
    if (!label || busy) return;
    setBusy(true); setError(null);
    try {
      const link = await api.addPrivateLink(subject, label, target);
      onChange([link, ...links.filter(existing => existing.id !== link.id)]);
      setName(''); setSuggestions([]);
    } catch { setError('Could not save the link. Try again.'); }
    finally { setBusy(false); }
  };
  const remove = async (linkId: string) => {
    setBusy(true); setError(null);
    try { await api.deletePrivateLink(linkId); onChange(links.filter(link => link.id !== linkId)); }
    catch { setError('Could not remove the link. Try again.'); }
    finally { setBusy(false); }
  };

  return (
    <View style={styles.section}>
      <Text style={[styles.heading, { color: c.textPrimary }]}>Links</Text>
      {links.map(link => (
        <View key={link.id} style={[styles.item, { borderBottomColor: c.divider }]}>
          <TouchableOpacity onPress={() => link.other.kind === 'user' ? onOpenPerson(link.other.id) : onOpenThing(link.other.id)} accessibilityRole="link">
            <Text style={{ color: c.textPrimary, fontSize: 15 }}>
              <Text style={{ color: c.textMetadata }}>{link.direction === 'out' ? `${link.relation} ` : `← ${link.relation} `}</Text>
              <Text style={{ color: c.primary, fontWeight: '700' }}>{link.other.name}</Text>
              <Text style={{ color: c.textMetadata }}>{`  ${kindLabel(link.other.kind)}`}</Text>
            </Text>
          </TouchableOpacity>
          <View style={styles.itemMeta}>
            <TouchableOpacity onPress={() => void remove(link.id)} disabled={busy}><Text style={{ color: c.textSecondary, fontSize: 13 }}>Remove</Text></TouchableOpacity>
          </View>
        </View>
      ))}
      <View style={styles.chips}>
        {RELATIONS.map(option => <Chip key={option} label={option} selected={relation === option} onPress={() => setRelation(option)} c={c} disabled={busy} />)}
      </View>
      <TextInput
        value={relation} onChangeText={setRelation} maxLength={60} editable={!busy} autoCapitalize="none"
        placeholder="How they are connected" placeholderTextColor={c.textMuted} accessibilityLabel="Relation"
        style={[styles.input, { color: c.textPrimary, borderColor: c.border, backgroundColor: c.background }]}
      />
      <View style={styles.chips}>
        {THING_KINDS.map(option => <Chip key={option.kind} label={option.label} selected={kind === option.kind} onPress={() => setKind(option.kind)} c={c} disabled={busy} />)}
      </View>
      <TextInput
        value={name} onChangeText={setName} maxLength={120} editable={!busy}
        placeholder={`Name of the ${kind}`} placeholderTextColor={c.textMuted} accessibilityLabel="Name"
        style={[styles.input, { color: c.textPrimary, borderColor: c.border, backgroundColor: c.background }]}
      />
      {suggestions.map(thing => (
        <TouchableOpacity key={thing.id} onPress={() => void add({ kind: thing.kind, id: thing.id })} disabled={busy}>
          <Text style={{ color: c.primary, fontSize: 14 }}>{`Use “${thing.name}”`}</Text>
        </TouchableOpacity>
      ))}
      <TouchableOpacity onPress={() => void add({ kind, name: name.trim() })} disabled={busy || !name.trim() || !relation.trim()}
        style={[styles.button, { backgroundColor: c.primary, opacity: busy || !name.trim() || !relation.trim() ? 0.5 : 1 }]}>
        <Text style={{ color: c.onPrimary, fontWeight: '700' }}>Add link</Text>
      </TouchableOpacity>
      {error && <Text style={{ color: c.danger }}>{error}</Text>}
    </View>
  );
}

export function PrivateCard({ userId, onOpenThing, onOpenPerson }: { userId: string; onOpenThing: (thingId: string) => void; onOpenPerson: (userId: string) => void }) {
  const { scheme } = useTheme();
  const c = getColors(scheme);
  const [open, setOpen] = useState(false);
  const [card, setCard] = useState<PrivatePersonCard | null>(null);
  const [notes, setNotes] = useState<PrivateNote[]>([]);
  const [links, setLinks] = useState<PrivateLink[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    api.getPrivatePerson(userId)
      .then(result => { if (active) { setCard(result.card); setNotes(result.notes); setLinks(result.links); } })
      .catch(() => { if (active) setError('Private notes unavailable'); });
    return () => { active = false; };
  }, [userId]);

  const patch = useCallback(async (change: Parameters<typeof api.updatePrivatePerson>[1]) => {
    setBusy(true); setError(null);
    try { setCard((await api.updatePrivatePerson(userId, change)).card); }
    catch { setError('Could not save that. Try again.'); }
    finally { setBusy(false); }
  }, [userId]);

  if (!card) return error ? <Text style={{ color: c.textMetadata, marginTop: 16 }}>{error}</Text> : <ActivityIndicator color={c.primary} style={{ marginTop: 16 }} />;
  const subject: PrivateSubject = { kind: 'user', id: userId };
  const due = dueLabel(card.nextDueAt);
  return (
    <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }]}>
      <TouchableOpacity onPress={() => setOpen(value => !value)} style={styles.header} accessibilityRole="button" accessibilityState={{ expanded: open }}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[styles.title, { color: c.textPrimary }]}>Private to you</Text>
          <Text style={{ color: c.textMetadata, fontSize: 13 }} numberOfLines={2}>{privateSummary(card, notes.length, links.length)}</Text>
        </View>
        <Text style={{ color: c.textMuted, fontSize: 18 }}>{open ? '⌄' : '›'}</Text>
      </TouchableOpacity>
      {open && (
        <View style={styles.body}>
          <Text style={{ color: c.textMetadata, fontSize: 13 }}>Only you can see this. They are never told and cannot see it.</Text>
          <TouchableOpacity onPress={() => void patch({ important: !card.important })} disabled={busy} accessibilityRole="switch" accessibilityState={{ checked: card.important }}
            style={[styles.chip, { alignSelf: 'flex-start', borderColor: c.border, backgroundColor: card.important ? c.primary : c.surface }]}>
            <Text style={{ color: card.important ? c.onPrimary : c.textPrimary }}>{card.important ? '★ Important' : '☆ Mark important'}</Text>
          </TouchableOpacity>
          <View style={styles.section}>
            <Text style={[styles.heading, { color: c.textPrimary }]}>Catch up</Text>
            <View style={styles.chips}>
              {CADENCES.map(option => <Chip key={option.label} label={option.label} selected={card.cadenceDays === option.days} onPress={() => void patch({ cadenceDays: option.days })} c={c} disabled={busy} />)}
            </View>
            {card.cadenceDays !== null && <>
              <Chip label={card.cadenceMode === 'expanding' ? 'Stretching the gap each time' : 'Stretch the gap each time'} selected={card.cadenceMode === 'expanding'}
                onPress={() => void patch({ cadenceMode: card.cadenceMode === 'expanding' ? 'fixed' : 'expanding' })} c={c} disabled={busy} />
              {!!due && <Text style={{ color: c.textMetadata, fontSize: 13 }}>{due}</Text>}
              <TouchableOpacity onPress={() => void patch({ contactedNow: true })} disabled={busy} style={[styles.button, { backgroundColor: c.surfaceElevated, borderColor: c.border, borderWidth: StyleSheet.hairlineWidth }]}>
                <Text style={{ color: c.textPrimary, fontWeight: '700' }}>Caught up today</Text>
              </TouchableOpacity>
            </>}
          </View>
          <PrivateNotes subject={subject} notes={notes} onChange={setNotes} />
          <PrivateLinks subject={subject} links={links} onChange={setLinks} onOpenThing={onOpenThing} onOpenPerson={onOpenPerson} />
          {error && <Text style={{ color: c.danger }}>{error}</Text>}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { marginTop: 16, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 14 },
  title: { fontSize: 16, fontWeight: '700' },
  body: { paddingHorizontal: 14, paddingBottom: 16, gap: 14 },
  section: { gap: 10 },
  heading: { fontSize: 15, fontWeight: '700' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 18, paddingVertical: 8, paddingHorizontal: 14, minHeight: 36, justifyContent: 'center' },
  item: { paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, gap: 6 },
  itemMeta: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  input: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15 },
  noteInput: { minHeight: 72, textAlignVertical: 'top' },
  button: { alignSelf: 'flex-start', borderRadius: 8, paddingVertical: 10, paddingHorizontal: 16, minHeight: 40, justifyContent: 'center' },
});
