/**
 * The owner's asks from their people overlay (OpenChat-2fsy.1), by
 * direction: asks for you (placed on your stream, or you carry them), your
 * friends' asks, and your own. Who cares, who carries and where an ask was
 * placed are separate facts. One home for asks; only the owner ever sees
 * this section, whatever an ask's exposure says.
 */
import { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, Linking, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { api, type OverlayAsk, type OverlayAskParty, type OverlayAskPlacement, type OverlayAskStatus } from '../api/client';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';
import { capsLabel, serif } from '../theme/typography';
import { radius, space, touchTarget, type } from '../theme/tokens';

const HORIZON_LABEL: Record<OverlayAsk['horizon'], string> = { event: 'Event', short: 'Short-term', medium: 'Medium-term', evergreen: 'Long-term' };
const STATUS_LABEL: Record<OverlayAskStatus, string> = { open: 'Open', stale: 'Unsure if current', fulfilled: 'Fulfilled', withdrawn: 'Withdrawn' };
const EXPOSURE_LABEL: Record<OverlayAsk['exposure'], string> = { only_me: 'Only you', this_chat: 'Meant for one chat · only you see it', friends: 'Meant for friends · only you see it', public: 'Meant to be public · only you see it' };
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

export function askMeta(ask: OverlayAsk): string {
  const timing = ask.status === 'open' || ask.status === 'stale' ? ask.needsRecheck ? 'Due for a recheck' : `Recheck ${day(ask.recheckAfter)}` : ask.closedAt ? `Closed ${day(ask.closedAt)}` : STATUS_LABEL[ask.status];
  const intended = ask.sources?.at(-1)?.audienceIntent;
  return [STATUS_LABEL[ask.status], HORIZON_LABEL[ask.horizon], timing, intended ? `Only you can currently see this · intended for ${intended}` : EXPOSURE_LABEL[ask.exposure]].join(' · ');
}

type Person = Exclude<OverlayAskParty, { kind: 'self' }>;
const isPerson = (party: OverlayAskPlacement | null | undefined): party is Person => !!party && party.kind !== 'self' && party.kind !== 'conversation' && party.kind !== 'ref';
/** Who carries it and where it was placed, in a few words. */
export function askParties(ask: OverlayAsk): string {
  const parts: string[] = [];
  if (ask.carrier) parts.push(isPerson(ask.carrier) ? `${ask.carrier.name} carries it` : 'You carry it');
  if (ask.placements.some(place => place.kind === 'self')) parts.push('On your stream');
  const chats = ask.placements.filter(place => place.kind === 'conversation').length;
  if (chats) parts.push(`In ${chats} chat${chats === 1 ? '' : 's'}`);
  const people = ask.placements.filter(isPerson);
  if (people.length) parts.push(`Placed with ${people.map(place => place.name).join(', ')}`);
  return parts.join(' · ');
}

export function PeopleAsks({ onOpenPerson, onOpenAsk, onOpenSource }: { onOpenPerson: (person: Person) => void; onOpenAsk?: (askId: string) => void; onOpenSource?: (conversationId: string, messageId: string) => void }) {
  const { scheme } = useTheme();
  const c = getColors(scheme);
  const [asks, setAsks] = useState<OverlayAsk[]>([]);
  const [showClosed, setShowClosed] = useState(true);
  const [direction, setDirection] = useState<'from_me' | 'for_me' | 'from_others'>('from_me');
  const [query, setQuery] = useState('');
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Only the latest load may set the list, and every reload uses the current closed-asks choice.
  const latest = useRef(0), closedRef = useRef(showClosed);
  const load = useCallback(async (closed = closedRef.current) => {
    const request = ++latest.current;
    setLoading(true);
    try {
      const result = await api.listAsks({ status: closed ? 'all' : 'open,stale', direction, q: query, limit: 200 });
      if (request !== latest.current) return;
      setAsks(result.asks);
      setTruncated(result.truncated);
      setError(null);
    } catch (err) {
      if (request === latest.current) setError(err instanceof Error ? err.message : 'Could not load asks.');
    } finally {
      if (request === latest.current) setLoading(false);
    }
  }, [direction, query]);
  useFocusEffect(useCallback(() => { void load(); }, [load]));

  const change = async (ask: OverlayAsk, patch: { status?: OverlayAskStatus; recheckedNow?: true; carrier?: 'self' | null }) => {
    setBusyId(ask.id);
    try {
      await api.updateAsk(ask.id, patch);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update this ask.');
    } finally {
      setBusyId(null);
    }
  };
  const addOwn = async () => {
    const text = draft.trim();
    if (!text) return;
    setBusyId('new');
    try {
      await api.saveAsk({ author: 'self', text });
      setDraft('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save your ask.');
    } finally {
      setBusyId(null);
    }
  };

  // By direction: for you (someone else's, on your stream or carried by you), friends' (someone else cares), yours (you care).
  const forYou = asks.filter(ask => ask.forMe && !ask.fromMe), friends = asks.filter(ask => !ask.fromMe && !ask.forMe), own = asks.filter(ask => ask.fromMe);
  const action = (label: string, ask: OverlayAsk, patch: { status?: OverlayAskStatus; recheckedNow?: true; carrier?: 'self' | null }, primary = false) => (
    <TouchableOpacity key={label} accessibilityRole="button" accessibilityLabel={`${label}: ${ask.text}`} disabled={busyId === ask.id} onPress={() => void change(ask, patch)}
      style={[styles.action, { borderColor: primary ? c.primary : c.border, backgroundColor: primary ? c.primaryMuted : c.surface, opacity: busyId === ask.id ? 0.5 : 1 }]}>
      <Text style={{ ...type.label, fontWeight: '600', color: primary ? c.primary : c.textSecondary }}>{label}</Text>
    </TouchableOpacity>
  );
  const row = (ask: OverlayAsk) => {
    const closed = ask.status === 'fulfilled' || ask.status === 'withdrawn';
    return (
      <View key={ask.id} style={[styles.row, { borderColor: c.border, backgroundColor: c.surface }]}>
        {isPerson(ask.authorParty) && (
          <TouchableOpacity accessibilityRole="link" accessibilityLabel={`Open ${ask.authorParty.name}`} onPress={() => onOpenPerson(ask.authorParty as Person)} style={styles.askerButton}>
            <Text style={[styles.asker, { color: c.primary }]} numberOfLines={1}>{ask.authorParty.name}</Text>
          </TouchableOpacity>
        )}
        <Text style={[styles.text, { color: closed ? c.textSecondary : c.textPrimary }]}>{ask.text}</Text>
        <Text style={[styles.meta, { color: ask.needsRecheck ? c.primary : c.textMetadata }]}>{askMeta(ask)}{ask.status === 'stale' ? ` · ${STATUS_LABEL.stale}` : ''}</Text>
        {askParties(ask) ? <Text style={[styles.meta, { color: c.textSecondary }]}>{askParties(ask)}</Text> : null}
        {ask.evidence && (ask.evidence.label || ask.evidence.url) && (
          ask.evidence.url
            ? <Text accessibilityRole="link" onPress={() => void Linking.openURL(ask.evidence!.url!)} style={[styles.meta, { color: c.primary }]} numberOfLines={1}>{ask.evidence.label ?? 'Source'}{ask.evidence.seenAt ? ` · seen ${ask.evidence.seenAt}` : ''}</Text>
            : <Text style={[styles.meta, { color: c.textMetadata }]} numberOfLines={2}>{ask.evidence.label}{ask.evidence.seenAt && !ask.evidence.label?.includes(ask.evidence.seenAt) ? ` · seen ${ask.evidence.seenAt}` : ''}</Text>
        )}
        {onOpenAsk && <TouchableOpacity accessibilityRole="link" onPress={() => onOpenAsk(ask.id)} style={styles.toggle}><Text style={{ ...type.label, color: c.primary }}>Details & sources</Text></TouchableOpacity>}
        {ask.sources?.map(source => <View key={`${source.app}:${source.conversationId}:${source.messageId}:${source.itemIndex}`}>
          <Text style={[styles.meta, { color: c.textMetadata }]}>{source.assertion === 'inferred' ? 'Inferred from' : 'From'} {source.app} · {source.excerpt}</Text>
          {source.app === 'openchat' && onOpenSource && <TouchableOpacity accessibilityRole="link" onPress={() => onOpenSource(source.conversationId, source.sourceMessageId ?? source.messageId)} style={styles.toggle}><Text style={{ ...type.label, color: c.primary }}>Open source message</Text></TouchableOpacity>}
        </View>)}
        <View style={styles.actions}>
          {closed ? action('Reopen', ask, { status: 'open' }) : [
            ask.needsRecheck ? action('Still open', ask, { recheckedNow: true }, true) : null,
            !ask.fromMe && !(ask.carrier && ask.carrier.kind === 'self') ? action('I\u2019ll carry it', ask, { carrier: 'self' }) : null,
            action('Fulfilled', ask, { status: 'fulfilled' }),
            action('Withdrawn', ask, { status: 'withdrawn' }),
          ]}
        </View>
      </View>
    );
  };

  return (
    <View style={styles.root}>
      <View style={styles.heading}>
        <Text style={[styles.eyebrow, { color: c.primary }]}>PERSONAL ASKS · ONLY YOU SEE THESE</Text>
        <TouchableOpacity accessibilityRole="switch" accessibilityState={{ checked: showClosed }} onPress={() => { const next = !showClosed; closedRef.current = next; setShowClosed(next); void load(next); }} style={styles.toggle}>
          <Text style={{ ...type.label, fontWeight: '600', color: c.textSecondary }}>{showClosed ? 'Hide closed' : 'Show closed'}</Text>
        </TouchableOpacity>
      </View>
      <View style={styles.actions}>
        {([['from_me', 'My asks'], ['for_me', 'For me'], ['from_others', "People’s asks"]] as const).map(([value, label]) => <TouchableOpacity key={value} accessibilityRole="tab" accessibilityState={{ selected: direction === value }} onPress={() => { setAsks([]); setDirection(value); }} style={[styles.action, { borderColor: direction === value ? c.primary : c.border }]}><Text style={{ ...type.label, color: direction === value ? c.primary : c.textSecondary }}>{label}</Text></TouchableOpacity>)}
      </View>
      <TextInput accessibilityLabel="Search asks" placeholder="Search asks" placeholderTextColor={c.textMetadata} value={query} onChangeText={setQuery} style={[styles.input, { color: c.textPrimary }]} />
      {truncated && <Text accessibilityRole="alert" style={[styles.meta, { color: c.textMetadata }]}>Showing the first 200 matching asks. Search or change the view to narrow this partial inventory.</Text>}
      {loading && !asks.length ? <ActivityIndicator color={c.primary} style={{ marginVertical: 16 }} /> : (
        <>
          {forYou.length > 0 && <>
            <Text style={[styles.section, { color: c.textPrimary }]}>For you</Text>
            {forYou.map(row)}
          </>}
          {direction === 'from_others' && <Text style={[styles.section, { color: c.textPrimary }]}>People’s asks</Text>}
          {friends.length ? friends.map(row) : direction === 'from_others' ? (
            <Text style={[styles.empty, { color: c.textSecondary }]}>None yet. Tell OpenChat Agent what someone is looking for, for example “Maya needs a physio in Oakland.” Nobody is notified.</Text>
          ) : null}
          {direction === 'from_me' && <Text style={[styles.section, { color: c.textPrimary }]}>My asks</Text>}
          {own.map(row)}
          <View style={[styles.addRow, { borderColor: c.border, backgroundColor: c.surface }]}>
            <TextInput value={draft} onChangeText={setDraft} placeholder="Add one of your own asks" placeholderTextColor={c.textMetadata} maxLength={1000}
              accessibilityLabel="Add one of your own asks" onSubmitEditing={() => void addOwn()} returnKeyType="done" style={[styles.input, { color: c.textPrimary }]} />
            <TouchableOpacity accessibilityRole="button" disabled={!draft.trim() || busyId === 'new'} onPress={() => void addOwn()}
              style={[styles.save, { backgroundColor: c.primary, opacity: !draft.trim() || busyId === 'new' ? 0.5 : 1 }]}>
              <Text style={{ color: c.onPrimary, fontWeight: '700' }}>Save</Text>
            </TouchableOpacity>
          </View>
        </>
      )}
      {error && <Text accessibilityRole="alert" style={[styles.meta, { color: c.danger }]}>{error}</Text>}
      <Text style={[styles.divider, { color: c.textMetadata }]}>MATCHING · INTENTIONS AND STORIES</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: space[2], paddingBottom: space[2] },
  heading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space[2] },
  eyebrow: { ...capsLabel },
  toggle: { minHeight: touchTarget, justifyContent: 'center', paddingHorizontal: space[2] },
  section: { ...type.heading, fontFamily: serif, marginTop: space[2] },
  row: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, padding: space[3], gap: space[1] },
  askerButton: { alignSelf: 'flex-start', minHeight: touchTarget - space[3], justifyContent: 'center' },
  asker: { ...type.label, fontWeight: '700' },
  text: { ...type.body },
  meta: { ...type.meta },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: space[2], marginTop: space[2] },
  action: { minHeight: touchTarget, paddingHorizontal: space[3], borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  empty: { ...type.label, fontWeight: '400' },
  addRow: { flexDirection: 'row', alignItems: 'center', gap: space[2], borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, paddingLeft: space[3], paddingRight: space[1], minHeight: 52 },
  input: { ...type.body, flex: 1, minHeight: touchTarget },
  save: { minHeight: touchTarget, paddingHorizontal: space[4], borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  divider: { ...capsLabel, marginTop: space[4] },
});
