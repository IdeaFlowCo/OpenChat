import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import {
  api, type AutoResponseDraft, type AutoResponseRule, type AutoResponseRuleInput, type AutoResponseSettings,
} from '../api/client';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';
import { radius, space, touchTarget, type } from '../theme/tokens';
import { Button, Chip, SectionLabel } from './ui';

type Person = { id: string; name: string };
const dollars = (micros: number) => `$${(micros / 1_000_000).toFixed(2)}`;

/** One line a person can read back: "When away · from Ben · about invoice → agent drafts". */
export function describeRule(rule: Pick<AutoResponseRule, 'whenAway' | 'fromUserIds' | 'topics' | 'action' | 'delivery'>, people: Person[]): string {
  const parts: string[] = [];
  if (rule.whenAway) parts.push('When I’m away');
  if (rule.fromUserIds.length) parts.push(`from ${rule.fromUserIds.map(id => people.find(p => p.id === id)?.name ?? 'someone').join(', ')}`);
  if (rule.topics.length) parts.push(`about ${rule.topics.join(', ')}`);
  const what = rule.action === 'agent' ? 'my agent writes a reply' : 'reply with my text';
  const how = rule.delivery === 'send' ? 'sent automatically' : 'draft for my approval';
  const when = parts.join(' · ');
  return `${when.charAt(0).toUpperCase()}${when.slice(1)} → ${what}, ${how}`;
}

const emptyRule = (): AutoResponseRuleInput => ({ whenAway: true, fromUserIds: [], topics: [], action: 'reply', replyText: '', delivery: 'draft' });

/**
 * The owner's built-in agent: the Ask-my-agent switch, auto-response rules and
 * drafts waiting for approval. Drafting is the default; auto-send is opt-in.
 */
export function AgentAutoResponses() {
  const { scheme } = useTheme();
  const c = getColors(scheme);
  const [settings, setSettings] = useState<AutoResponseSettings | null>(null);
  const [rules, setRules] = useState<AutoResponseRule[]>([]);
  const [drafts, setDrafts] = useState<AutoResponseDraft[]>([]);
  const [draftText, setDraftText] = useState<Record<string, string>>({});
  const [people, setPeople] = useState<Person[]>([]);
  const [form, setForm] = useState<AutoResponseRuleInput>(emptyRule);
  const [topicsText, setTopicsText] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    try {
      const [s, r, d] = await Promise.all([api.getAutoResponseSettings(), api.listAutoResponseRules(), api.listAutoResponseDrafts()]);
      setSettings(s); setRules(r.rules); setDrafts(d.drafts);
      setDraftText(current => Object.fromEntries(d.drafts.map(draft => [draft.id, current[draft.id] ?? draft.text])));
      setError('');
    } catch { setError('Could not load your agent settings.'); }
    finally { setLoaded(true); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  // People you have a direct chat with, for "from these people" (loaded once).
  useEffect(() => { void (async () => {
    try {
      const conversations = await api.getConversations();
      const me = await api.getMe().catch(() => null);
      const seen = new Map<string, string>();
      conversations.filter(cv => cv.type === 'direct').forEach(cv => cv.participants?.forEach(p => {
        if (p.user?.id && p.user.id !== me?.id && !p.user.isBot) seen.set(p.user.id, p.user.name || 'Someone');
      }));
      setPeople([...seen].map(([id, name]) => ({ id, name })).slice(0, 24));
    } catch { setPeople([]); }
  })(); }, []);

  const act = async (key: string, fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(key); setError('');
    try { await fn(); await load(); }
    catch (e) { setError(e instanceof Error ? e.message.replace(/^\d+: /, '') : 'Could not save. Try again.'); }
    finally { setBusy(null); }
  };

  const topics = useMemo(() => topicsText.split(',').map(t => t.trim()).filter(Boolean).slice(0, 10), [topicsText]);
  const formValid = (form.whenAway || form.fromUserIds.length > 0 || topics.length > 0) && (form.action === 'agent' || !!form.replyText?.trim());

  if (!loaded) return <ActivityIndicator color={c.primary} accessibilityLabel="Loading your agent" />;

  // One-time prompt: the agent is off until the owner chooses. Either answer records the choice.
  const showPrompt = !!settings && !settings.profileAgentDecided && settings.available;

  return <View style={{ gap: space[3] }}>
    <SectionLabel>YOUR OPENCHAT AGENT</SectionLabel>
    {showPrompt && <View accessibilityRole="summary" style={[styles.card, { backgroundColor: c.surface, borderColor: c.primary }]}>
      <Text style={{ ...type.title, color: c.textPrimary }}>Let people ask my agent?</Text>
      <Text style={{ ...type.body, color: c.textSecondary }}>Your agent is off. If you turn it on, people in your chats can ask it to answer one of your messages. It replies in the chat under your name, clearly labelled “your OpenChat agent, not you”, using only your public card and the notes you shared in that chat. It never reads your private notes. You can turn it off any time.</Text>
      <View style={styles.actions}>
        <Button label="Not now" variant="secondary" disabled={!!busy} onPress={() => { void act('agent', () => api.setProfileAgentEnabled(false)); }} />
        <Button label="Turn on my agent" variant="primary" disabled={!!busy} onPress={() => { void act('agent', () => api.setProfileAgentEnabled(true)); }} />
      </View>
    </View>}
    <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }]}>
      <View style={styles.row}>
        <View style={{ flex: 1 }}>
          <Text style={{ ...type.bodyStrong, color: c.textPrimary }}>Let people ask my agent</Text>
          <Text style={{ ...type.body, color: c.textSecondary }}>Anyone in a chat with you can choose {'“Ask <your name>’s agent”'} on one of your messages. Off unless you turn it on. It answers right away, labelled as your agent, not you, using only your public card and the notes you shared in that chat. It never reads your private notes.</Text>
        </View>
        <Switch
          value={settings?.profileAgentEnabled ?? false}
          onValueChange={value => { void act('agent', () => api.setProfileAgentEnabled(value)); }}
          trackColor={{ false: c.border, true: c.primary }}
          accessibilityLabel="Let people ask my agent"
        />
      </View>
      {settings && <Text style={{ ...type.meta, color: c.textMetadata }}>
        {settings.available ? `Used ${dollars(settings.spentMicros)} of ${dollars(settings.capMicros ?? 2_000_000)} this month. It pauses at the limit.` : 'Agents are not available on this server right now.'}
      </Text>}
    </View>

    {drafts.length > 0 && <>
      <SectionLabel>DRAFTS WAITING FOR YOU</SectionLabel>
      {drafts.map(draft => <View key={draft.id} style={[styles.card, { backgroundColor: c.surface, borderColor: c.primary }]}>
        <Text style={{ ...type.meta, color: c.textMetadata }}>Reply to {draft.senderName}: “{draft.sourceText}”</Text>
        <TextInput
          accessibilityLabel={`Draft reply to ${draft.senderName}`}
          value={draftText[draft.id] ?? draft.text}
          onChangeText={text => setDraftText(current => ({ ...current, [draft.id]: text }))}
          multiline maxLength={2000}
          style={[styles.input, styles.multiline, { borderColor: c.border, color: c.textPrimary, backgroundColor: c.background }]}
        />
        <Text style={{ ...type.meta, color: c.textMetadata }}>{draft.action === 'agent' ? 'They will see “Drafted by your OpenChat agent · approved by you”.' : 'They will see “Auto-reply · approved by you”.'}</Text>
        <View style={styles.actions}>
          <Button label="Discard" variant="secondary" disabled={!!busy} onPress={() => { void act(`discard:${draft.id}`, () => api.discardAutoResponseDraft(draft.id)); }} />
          <Button label="Send" variant="primary" disabled={!!busy || !(draftText[draft.id] ?? draft.text).trim()} onPress={() => { void act(`send:${draft.id}`, () => api.sendAutoResponseDraft(draft.id, (draftText[draft.id] ?? draft.text).trim())); }} />
        </View>
      </View>)}
    </>}

    <SectionLabel>AUTO-RESPONSE RULES</SectionLabel>
    {rules.length === 0 && <Text style={{ ...type.body, color: c.textMetadata }}>No rules yet. Rules apply in direct chats.</Text>}
    {rules.map(rule => <View key={rule.id} style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }]}>
      <View style={styles.row}>
        <Text style={{ ...type.body, color: c.textPrimary, flex: 1 }}>{describeRule(rule, people)}</Text>
        <Switch value={rule.enabled} accessibilityLabel="Rule on" trackColor={{ false: c.border, true: c.primary }}
          onValueChange={enabled => { void act(`toggle:${rule.id}`, () => api.updateAutoResponseRule(rule.id, { enabled })); }} />
      </View>
      {rule.action === 'reply' && !!rule.replyText && <Text style={{ ...type.meta, color: c.textSecondary }}>“{rule.replyText}”</Text>}
      <Button label="Delete rule" variant="ghost" disabled={!!busy} onPress={() => { void act(`delete:${rule.id}`, () => api.deleteAutoResponseRule(rule.id)); }} />
    </View>)}

    <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }]}>
      <Text style={{ ...type.title, color: c.textPrimary }}>Add a rule</Text>
      <Text style={{ ...type.label, color: c.textSecondary }}>When</Text>
      <View style={styles.chips}>
        <Chip label="I’m away" selected={form.whenAway} onPress={() => setForm(f => ({ ...f, whenAway: !f.whenAway }))} />
      </View>
      {people.length > 0 && <>
        <Text style={{ ...type.label, color: c.textSecondary }}>From (optional; anyone if none chosen)</Text>
        <View style={styles.chips}>{people.map(person => <Chip key={person.id} label={person.name} selected={form.fromUserIds.includes(person.id)}
          onPress={() => setForm(f => ({ ...f, fromUserIds: f.fromUserIds.includes(person.id) ? f.fromUserIds.filter(id => id !== person.id) : [...f.fromUserIds, person.id] }))} />)}</View>
      </>}
      <Text style={{ ...type.label, color: c.textSecondary }}>About (optional, comma-separated words)</Text>
      <TextInput accessibilityLabel="Topics" value={topicsText} onChangeText={setTopicsText} placeholder="invoice, schedule" placeholderTextColor={c.textMuted}
        style={[styles.input, { borderColor: c.border, color: c.textPrimary, backgroundColor: c.background }]} />
      <Text style={{ ...type.label, color: c.textSecondary }}>Then</Text>
      <View accessibilityRole="radiogroup" style={styles.chips}>
        <Chip label="Reply with my text" accessibilityRole="radio" selected={form.action === 'reply'} onPress={() => setForm(f => ({ ...f, action: 'reply' }))} />
        <Chip label="Let my agent write it" accessibilityRole="radio" selected={form.action === 'agent'} onPress={() => setForm(f => ({ ...f, action: 'agent' }))} />
      </View>
      {form.action === 'reply' && <TextInput accessibilityLabel="Reply text" value={form.replyText ?? ''} onChangeText={replyText => setForm(f => ({ ...f, replyText }))}
        placeholder="Thanks — I’m away until Monday." placeholderTextColor={c.textMuted} multiline maxLength={1000}
        style={[styles.input, styles.multiline, { borderColor: c.border, color: c.textPrimary, backgroundColor: c.background }]} />}
      <View accessibilityRole="radiogroup" style={styles.chips}>
        <Chip label="Draft for my approval" accessibilityRole="radio" selected={form.delivery === 'draft'} onPress={() => setForm(f => ({ ...f, delivery: 'draft' }))} />
        <Chip label="Send automatically" accessibilityRole="radio" selected={form.delivery === 'send'} onPress={() => setForm(f => ({ ...f, delivery: 'send' }))} />
      </View>
      <Text style={{ ...type.meta, color: form.delivery === 'send' ? c.textPrimary : c.textMetadata }}>
        {form.delivery === 'send'
          ? 'Sent without asking you, at most once every 6 hours per chat, labelled “Automatic reply · your OpenChat agent, not you”.'
          : 'Nothing is sent until you approve the draft here.'}
      </Text>
      {!!error && <Text accessibilityRole="alert" style={{ ...type.body, color: c.danger }}>{error}</Text>}
      <Button label="Add rule" disabled={!formValid || !!busy} loading={busy === 'create'}
        onPress={() => { void act('create', async () => { await api.createAutoResponseRule({ ...form, topics, replyText: form.action === 'reply' ? form.replyText?.trim() || null : null }); setForm(emptyRule()); setTopicsText(''); }); }} />
    </View>
  </View>;
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: radius.lg, padding: space[3], gap: space[2] },
  row: { flexDirection: 'row', alignItems: 'center', gap: space[3] },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space[2] },
  input: { ...type.body, borderWidth: 1, borderRadius: radius.md, minHeight: touchTarget, paddingHorizontal: space[3], paddingVertical: space[2] },
  multiline: { minHeight: touchTarget * 2, textAlignVertical: 'top' },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: space[2] },
});
