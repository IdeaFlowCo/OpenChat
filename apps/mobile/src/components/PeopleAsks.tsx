/**
 * The owner's asks from their people overlay (OpenChat-2fsy.1), in three
 * plain views: To do (you act on it: your own to-dos, and asks you carry or
 * that were placed with you), My asks (you want it) and People's asks (what
 * the people you know are looking for). Who cares, who carries and where an
 * ask was placed stay separate facts underneath. One home for asks; only the
 * owner ever sees this section, whatever an ask's exposure says.
 *
 * A row shows the ask, one line about it, and a tick to finish it. The other
 * actions and the sources open under More, and the long form (horizon,
 * recheck date, every source) is the ask's detail screen.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Linking, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { api, type OverlayAsk, type OverlayAskParty, type OverlayAskPlacement, type OverlayAskStatus } from '../api/client';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';
import { radius, roles, space, touchTarget, type } from '../theme/tokens';
import { useChat } from '../contexts/ChatContext';
import { askConversationIds, isTodoAsk } from '../utils/chatTodos';
import { AppIcon } from './AppIcon';

const HORIZON_LABEL: Record<OverlayAsk['horizon'], string> = { event: 'Event', short: 'Short-term', medium: 'Medium-term', evergreen: 'Long-term' };
const STATUS_LABEL: Record<OverlayAskStatus, string> = { open: 'Open', stale: 'Unsure if current', fulfilled: 'Fulfilled', withdrawn: 'Withdrawn' };
const EXPOSURE_LABEL: Record<OverlayAsk['exposure'], string> = { only_me: 'Only you', this_chat: 'Meant for one chat · only you see it', friends: 'Meant for friends · only you see it', public: 'Meant to be public · only you see it' };
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

export function askMeta(ask: OverlayAsk): string {
  const timing = ask.status === 'open' || ask.status === 'stale' ? ask.needsRecheck ? 'Due for a recheck' : `Recheck ${day(ask.recheckAfter)}` : ask.closedAt ? `Closed ${day(ask.closedAt)}` : STATUS_LABEL[ask.status];
  const intended = ask.sources?.at(-1)?.audienceIntent;
  const access = ask.publication?.state === 'active' ? `${ask.publication.audienceKind === 'public' ? 'Public' : 'Shared with selected people'}${ask.publication.sourceRevision !== ask.revision ? ' · Private version changed' : ''}` : intended ? `Only you can currently see this · intended for ${intended}` : EXPOSURE_LABEL[ask.exposure];
  return [STATUS_LABEL[ask.status], HORIZON_LABEL[ask.horizon], timing, access].join(' · ');
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

/** Who can see an ask, in the fewest honest words: what is true now first, what was intended second. */
export function askAccess(ask: OverlayAsk): { label: string; onlyMe: boolean } {
  if (ask.publication?.state === 'active') {
    return { label: `${ask.publication.audienceKind === 'public' ? 'Public' : 'Shared with selected people'}${ask.publication.sourceRevision !== ask.revision ? ' · Private version changed' : ''}`, onlyMe: false };
  }
  const intended = ask.sources?.at(-1)?.audienceIntent;
  return { label: intended ? `Only you can currently see this · intended for ${intended}` : EXPOSURE_LABEL[ask.exposure], onlyMe: true };
}

type AskView = 'for_me' | 'from_me' | 'from_others';
const VIEWS: [AskView, string][] = [['from_me', 'My asks'], ['for_me', 'To do'], ['from_others', 'People’s asks']];
const EMPTY: Record<AskView, string> = {
  for_me: 'Nothing to do. A private to-do you add in a chat (type /todo, or use To-do on a message) shows up here.',
  from_me: 'None yet. Add something you are looking for above. It stays private until you choose to share it.',
  from_others: 'None yet. Tell OpenChat Agent what someone is looking for, for example “Maya needs a physio in Oakland.” Nobody is notified.',
};
type Patch = { status?: OverlayAskStatus; recheckedNow?: true; carrier?: 'self' | null };

export function PeopleAsks({ onOpenPerson, onOpenAsk, onOpenSource }: { onOpenPerson: (person: Person) => void; onOpenAsk?: (askId: string) => void; onOpenSource?: (conversationId: string, messageId: string) => void }) {
  const { scheme } = useTheme();
  const c = getColors(scheme);
  const r = roles(c);
  const { conversations } = useChat();
  const [asks, setAsks] = useState<OverlayAsk[]>([]);
  const [showClosed, setShowClosed] = useState(false);
  const [direction, setDirection] = useState<AskView>('from_me');
  const [query, setQuery] = useState('');
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Only the latest load may set the list. Closed asks come in the same page (open ones sort first) and wait under a count.
  const latest = useRef(0);
  const load = useCallback(async () => {
    const request = ++latest.current;
    setLoading(true);
    try {
      const result = await api.listAsks({ direction, status: 'all', q: query, limit: 200 });
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

  const chatTitles = useMemo(() => new Map((conversations ?? []).map(conversation => [conversation.id, conversation.title || (conversation.type === 'group' ? 'a group chat' : 'a chat')])), [conversations]);

  const change = async (ask: OverlayAsk, patch: Patch) => {
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
      // On To do the new item is something you will do yourself; elsewhere it is something you are looking for.
      await api.saveAsk({ author: 'self', text, ...(direction === 'for_me' ? { carrier: 'self' as const } : {}) });
      setDraft('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save your ask.');
    } finally {
      setBusyId(null);
    }
  };

  // My asks leaves out your own to-dos: those are things you do, and they live under To do.
  const shown = direction === 'from_me' ? asks.filter(ask => !isTodoAsk(ask)) : asks;
  const isClosed = (ask: OverlayAsk) => ask.status === 'fulfilled' || ask.status === 'withdrawn';
  const open = shown.filter(ask => !isClosed(ask)), closed = shown.filter(isClosed);

  const action = (label: string, ask: OverlayAsk, patch: Patch) => (
    <TouchableOpacity key={label} accessibilityRole="button" accessibilityLabel={`${label}: ${ask.text}`} disabled={busyId === ask.id} onPress={() => void change(ask, patch)}
      style={[styles.action, { borderColor: c.border, backgroundColor: c.surface, opacity: busyId === ask.id ? 0.5 : 1 }]}>
      <Text style={{ ...type.label, color: c.textPrimary }}>{label}</Text>
    </TouchableOpacity>
  );
  const row = (ask: OverlayAsk) => {
    const closedAsk = isClosed(ask);
    const expanded = expandedId === ask.id;
    const access = askAccess(ask);
    const chats = askConversationIds(ask);
    const facts = [
      closedAsk ? `${STATUS_LABEL[ask.status]}${ask.closedAt ? ` ${day(ask.closedAt)}` : ''}` : ask.needsRecheck || ask.status === 'stale' ? 'Check if this is still current' : '',
      ask.carrier && isPerson(ask.carrier) ? `${ask.carrier.name} is on it` : !ask.fromMe && ask.carrier?.kind === 'self' ? 'You said you would help' : '',
      chats.length === 1 ? `From ${chatTitles.get(chats[0]) ?? 'a chat'}` : chats.length > 1 ? `From ${chats.length} chats` : '',
    ].filter(Boolean);
    const firstChatSource = ask.sources?.find(source => source.app === 'openchat');
    return (
      <View key={ask.id} style={[styles.row, { borderColor: c.border, backgroundColor: c.surface }]}>
        <TouchableOpacity
          accessibilityRole="checkbox"
          accessibilityState={{ checked: closedAsk, busy: busyId === ask.id }}
          accessibilityLabel={`${closedAsk ? 'Reopen' : 'Mark done'}: ${ask.text}`}
          disabled={busyId === ask.id}
          onPress={() => void change(ask, { status: closedAsk ? 'open' : 'fulfilled' })}
          style={styles.check}
        >
          {busyId === ask.id ? <ActivityIndicator size="small" color={c.primary} /> : <AppIcon name={closedAsk ? 'todo' : 'circle'} color={closedAsk ? c.textMetadata : c.primary} size={20} />}
        </TouchableOpacity>
        <View style={styles.rowBody}>
          {isPerson(ask.authorParty) && (
            <TouchableOpacity accessibilityRole="link" accessibilityLabel={`Open ${ask.authorParty.name}`} onPress={() => onOpenPerson(ask.authorParty as Person)} style={styles.askerButton}>
              <Text style={[styles.asker, { color: c.primary }]} numberOfLines={1}>{ask.authorParty.name}</Text>
            </TouchableOpacity>
          )}
          <Text style={[styles.text, { color: closedAsk ? c.textSecondary : c.textPrimary }, closedAsk && styles.struck]}>{ask.text}</Text>
          <View style={styles.metaLine}>
            {access.onlyMe && <AppIcon name="lock" color={c.textMetadata} size={11} strokeWidth={2.4} />}
            <Text style={[styles.meta, styles.metaText, { color: c.textMetadata }]}>{[access.label, ...facts].join(' · ')}</Text>
          </View>
          {expanded && (
            <View style={styles.expanded}>
              {askParties(ask) ? <Text style={[styles.meta, { color: c.textSecondary }]}>{askParties(ask)}</Text> : null}
              {ask.evidence && (ask.evidence.label || ask.evidence.url) && (
                ask.evidence.url
                  ? <Text accessibilityRole="link" onPress={() => void Linking.openURL(ask.evidence!.url!)} style={[styles.meta, { color: c.primary }]} numberOfLines={1}>{ask.evidence.label ?? 'Source'}{ask.evidence.seenAt ? ` · seen ${ask.evidence.seenAt}` : ''}</Text>
                  : <Text style={[styles.meta, { color: c.textMetadata }]} numberOfLines={2}>{ask.evidence.label}{ask.evidence.seenAt && !ask.evidence.label?.includes(ask.evidence.seenAt) ? ` · seen ${ask.evidence.seenAt}` : ''}</Text>
              )}
              {ask.sources?.map(source => (
                <Text key={`${source.app}:${source.conversationId}:${source.messageId}:${source.itemIndex}`} style={[styles.meta, { color: c.textMetadata }]} numberOfLines={3}>
                  {source.assertion === 'inferred' ? 'Inferred from' : 'From'} {source.app} · {source.excerpt}
                </Text>
              ))}
              <View style={styles.actions}>
                {closedAsk ? action('Reopen', ask, { status: 'open' }) : [
                  ask.needsRecheck ? action('Still open', ask, { recheckedNow: true }) : null,
                  !ask.fromMe && !(ask.carrier && ask.carrier.kind === 'self') ? action('I’ll help with it', ask, { carrier: 'self' }) : null,
                  action('No longer needed', ask, { status: 'withdrawn' }),
                ]}
                {firstChatSource && onOpenSource && (
                  <TouchableOpacity accessibilityRole="link" onPress={() => onOpenSource(firstChatSource.conversationId, firstChatSource.sourceMessageId ?? firstChatSource.messageId)} style={[styles.action, { borderColor: c.border, backgroundColor: c.surface }]}>
                    <Text style={{ ...type.label, color: c.textPrimary }}>Open source conversation</Text>
                  </TouchableOpacity>
                )}
                {onOpenAsk && (
                  <TouchableOpacity accessibilityRole="link" onPress={() => onOpenAsk(ask.id)} style={[styles.action, { borderColor: c.border, backgroundColor: c.surface }]}>
                    <Text style={{ ...type.label, color: c.textPrimary }}>Details & sources</Text>
                  </TouchableOpacity>
                )}
              </View>
            </View>
          )}
        </View>
        <TouchableOpacity accessibilityRole="button" accessibilityState={{ expanded }} accessibilityLabel={`${expanded ? 'Less' : 'More'} about: ${ask.text}`} onPress={() => setExpandedId(expanded ? null : ask.id)} style={styles.more}>
          <Text style={{ ...type.label, color: c.textSecondary }}>{expanded ? 'Less' : 'More'}</Text>
        </TouchableOpacity>
      </View>
    );
  };

  return (
    <View style={styles.root}>
      <View accessibilityRole="tablist" style={[styles.segments, { backgroundColor: c.surfaceElevated }]}>
        {VIEWS.map(([value, label]) => {
          const selected = direction === value;
          return (
            <TouchableOpacity key={value} accessibilityRole="tab" accessibilityState={{ selected }} onPress={() => { if (!selected) { setAsks([]); setExpandedId(null); setDirection(value); } }}
              style={[styles.segment, selected && { backgroundColor: c.surface, borderColor: c.border }]}>
              <Text style={{ ...type.label, fontWeight: selected ? '600' : '500', color: selected ? c.textPrimary : c.textSecondary }}>{label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
      {direction !== 'from_others' && (
        <View style={[styles.addRow, { borderColor: c.border, backgroundColor: c.surface }]}>
          <TextInput value={draft} onChangeText={setDraft} placeholder={direction === 'for_me' ? 'Add a to-do' : 'Add something you are looking for'} placeholderTextColor={c.textMuted} maxLength={1000}
            accessibilityLabel={direction === 'for_me' ? 'Add a to-do' : 'Add one of your own asks'} onSubmitEditing={() => void addOwn()} returnKeyType="done" style={[styles.input, { color: c.textPrimary }]} />
          <TouchableOpacity accessibilityRole="button" disabled={!draft.trim() || busyId === 'new'} onPress={() => void addOwn()}
            style={[styles.save, { backgroundColor: c.primary, opacity: !draft.trim() || busyId === 'new' ? 0.5 : 1 }]}>
            <Text style={{ color: c.onPrimary, fontWeight: '700' }}>Save</Text>
          </TouchableOpacity>
        </View>
      )}
      <TextInput accessibilityLabel="Search asks" placeholder="Search" placeholderTextColor={c.textMuted} value={query} onChangeText={setQuery} style={[styles.search, { color: c.textPrimary, borderColor: c.border, backgroundColor: c.surface }]} />
      {truncated && <Text accessibilityRole="alert" style={[styles.meta, { color: c.textMetadata }]}>Showing the first 200 matching asks. Search or change the view to narrow this partial inventory.</Text>}
      {loading && !asks.length ? <ActivityIndicator color={c.primary} style={{ marginVertical: 16 }} /> : (
        <>
          {open.map(row)}
          {!open.length && !error && <Text style={[styles.empty, { color: c.textSecondary }]}>{query ? 'Nothing matches that search.' : EMPTY[direction]}</Text>}
          {closed.length > 0 && (
            <TouchableOpacity accessibilityRole="button" accessibilityState={{ expanded: showClosed }} onPress={() => setShowClosed(value => !value)} style={styles.closedToggle}>
              <AppIcon name={showClosed ? 'chevron-down' : 'chevron-right'} color={c.textMetadata} size={14} />
              <Text style={{ ...type.label, color: c.textMetadata }}>{`${showClosed ? 'Hide closed' : 'Show closed'} · ${closed.length}`}</Text>
            </TouchableOpacity>
          )}
          {showClosed && closed.map(row)}
        </>
      )}
      {error && <Text accessibilityRole="alert" style={[styles.meta, { color: c.danger }]}>{error}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: space[2], paddingBottom: space[2] },
  segments: { flexDirection: 'row', padding: 2, borderRadius: radius.md, gap: 2 },
  segment: { flex: 1, minHeight: 36, alignItems: 'center', justifyContent: 'center', borderRadius: radius.sm, borderWidth: StyleSheet.hairlineWidth, borderColor: 'transparent', paddingHorizontal: space[2] },
  search: { ...type.body, minHeight: 40, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, paddingHorizontal: space[3] },
  row: { flexDirection: 'row', alignItems: 'flex-start', borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md },
  check: { width: touchTarget, minHeight: touchTarget, alignItems: 'center', justifyContent: 'center' },
  rowBody: { flex: 1, minWidth: 0, paddingVertical: space[2] + 2, gap: 2 },
  more: { minHeight: touchTarget, paddingHorizontal: space[3], justifyContent: 'center' },
  askerButton: { alignSelf: 'flex-start', justifyContent: 'center' },
  asker: { ...type.label, fontWeight: '600' },
  text: { ...type.body },
  struck: { textDecorationLine: 'line-through' },
  metaLine: { flexDirection: 'row', alignItems: 'center', gap: space[1] },
  metaText: { flex: 1, minWidth: 0 },
  meta: { ...type.meta },
  expanded: { gap: space[1], marginTop: space[1] },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: space[2], marginTop: space[1] },
  action: { minHeight: 36, paddingHorizontal: space[3], borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  empty: { ...type.label, fontWeight: '400', paddingVertical: space[3] },
  addRow: { flexDirection: 'row', alignItems: 'center', gap: space[2], borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, paddingLeft: space[3], paddingRight: space[1], minHeight: 52 },
  input: { ...type.body, flex: 1, minHeight: touchTarget },
  save: { minHeight: 40, paddingHorizontal: space[4], borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  closedToggle: { flexDirection: 'row', alignItems: 'center', gap: space[1], minHeight: touchTarget, paddingHorizontal: space[1] },
});
