/**
 * The owner's asks from their people overlay (OpenChat-2fsy.1): what the
 * people they know are asking for, and their own asks. One home for asks;
 * only the owner ever sees this section, whatever an ask's exposure says.
 */
import { useCallback, useState } from 'react';
import { ActivityIndicator, Linking, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { api, type OverlayAsk, type OverlayAskStatus } from '../api/client';
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
  return [HORIZON_LABEL[ask.horizon], timing, EXPOSURE_LABEL[ask.exposure]].join(' · ');
}

export function PeopleAsks({ onOpenAsker }: { onOpenAsker: (asker: NonNullable<OverlayAsk['asker']>) => void }) {
  const { scheme } = useTheme();
  const c = getColors(scheme);
  const [asks, setAsks] = useState<OverlayAsk[]>([]);
  const [showClosed, setShowClosed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (closed = showClosed) => {
    setLoading(true);
    try {
      const result = await api.listAsks({ status: closed ? 'all' : 'open,stale', limit: 200 });
      setAsks(result.asks);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load asks.');
    } finally {
      setLoading(false);
    }
  }, [showClosed]);
  useFocusEffect(useCallback(() => { void load(); }, [load]));

  const change = async (ask: OverlayAsk, patch: { status?: OverlayAskStatus; recheckedNow?: true }) => {
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
      await api.saveAsk({ asker: 'self', text });
      setDraft('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save your ask.');
    } finally {
      setBusyId(null);
    }
  };

  const friends = asks.filter(ask => !ask.own), own = asks.filter(ask => ask.own);
  const action = (label: string, ask: OverlayAsk, patch: { status?: OverlayAskStatus; recheckedNow?: true }, primary = false) => (
    <TouchableOpacity key={label} accessibilityRole="button" accessibilityLabel={`${label}: ${ask.text}`} disabled={busyId === ask.id} onPress={() => void change(ask, patch)}
      style={[styles.action, { borderColor: primary ? c.primary : c.border, backgroundColor: primary ? c.primaryMuted : c.surface, opacity: busyId === ask.id ? 0.5 : 1 }]}>
      <Text style={{ ...type.label, fontWeight: '600', color: primary ? c.primary : c.textSecondary }}>{label}</Text>
    </TouchableOpacity>
  );
  const row = (ask: OverlayAsk) => {
    const closed = ask.status === 'fulfilled' || ask.status === 'withdrawn';
    return (
      <View key={ask.id} style={[styles.row, { borderColor: c.border, backgroundColor: c.surface }]}>
        {ask.asker && (
          <TouchableOpacity accessibilityRole="link" accessibilityLabel={`Open ${ask.asker.name}`} onPress={() => onOpenAsker(ask.asker!)} style={styles.askerButton}>
            <Text style={[styles.asker, { color: c.primary }]} numberOfLines={1}>{ask.asker.name}</Text>
          </TouchableOpacity>
        )}
        {!ask.asker && !ask.own && <Text style={[styles.asker, { color: c.textMetadata }]}>Someone you no longer keep a card for</Text>}
        <Text style={[styles.text, { color: closed ? c.textSecondary : c.textPrimary }]}>{ask.text}</Text>
        <Text style={[styles.meta, { color: ask.needsRecheck ? c.primary : c.textMetadata }]}>{askMeta(ask)}{ask.status === 'stale' ? ` · ${STATUS_LABEL.stale}` : ''}</Text>
        {ask.evidence && (ask.evidence.label || ask.evidence.url) && (
          ask.evidence.url
            ? <Text accessibilityRole="link" onPress={() => void Linking.openURL(ask.evidence!.url!)} style={[styles.meta, { color: c.primary }]} numberOfLines={1}>{ask.evidence.label ?? 'Source'}{ask.evidence.seenAt ? ` · seen ${ask.evidence.seenAt}` : ''}</Text>
            : <Text style={[styles.meta, { color: c.textMetadata }]} numberOfLines={2}>{ask.evidence.label}{ask.evidence.seenAt && !ask.evidence.label?.includes(ask.evidence.seenAt) ? ` · seen ${ask.evidence.seenAt}` : ''}</Text>
        )}
        <View style={styles.actions}>
          {closed ? action('Reopen', ask, { status: 'open' }) : [
            ask.needsRecheck ? action('Still open', ask, { recheckedNow: true }, true) : null,
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
        <Text style={[styles.eyebrow, { color: c.primary }]}>PEOPLE'S ASKS · ONLY YOU SEE THESE</Text>
        <TouchableOpacity accessibilityRole="switch" accessibilityState={{ checked: showClosed }} onPress={() => { const next = !showClosed; setShowClosed(next); void load(next); }} style={styles.toggle}>
          <Text style={{ ...type.label, fontWeight: '600', color: c.textSecondary }}>{showClosed ? 'Hide closed' : 'Show closed'}</Text>
        </TouchableOpacity>
      </View>
      {loading && !asks.length ? <ActivityIndicator color={c.primary} style={{ marginVertical: 16 }} /> : (
        <>
          <Text style={[styles.section, { color: c.textPrimary }]}>Friends' asks</Text>
          {friends.length ? friends.map(row) : (
            <Text style={[styles.empty, { color: c.textSecondary }]}>None yet. Tell OpenChat Agent what someone is looking for, for example “Maya needs a physio in Oakland.” Nobody is notified.</Text>
          )}
          <Text style={[styles.section, { color: c.textPrimary }]}>Your asks</Text>
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
