import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { api, type AgentIntentKind, type IntentDraft, type MatchingMode } from '../api/client';
import { useChat } from '../contexts/ChatContext';
import { useTheme } from '../contexts/ThemeContext';
import type { NavProp, RouteProps } from '../navigation/types';
import { getColors } from '../theme/colors';
import { capsLabel, serif } from '../theme/typography';

type Expiry = 'day' | 'week';
export type ComposerDestination = 'agents_only' | 'both' | 'stories_only';

export interface DestinationOption {
  value: ComposerDestination;
  label: string;
  sentence: string;
}

export const DESTINATION_OPTIONS: DestinationOption[] = [
  {
    value: 'agents_only',
    label: 'Agents only',
    sentence: 'Only agents in the selected chats can search this; it never appears in anyone’s Stories feed.',
  },
  {
    value: 'both',
    label: 'Stories and agents',
    sentence: 'Posts to the selected chats’ Stories feed and lets their agents search quietly for matches.',
  },
  {
    value: 'stories_only',
    label: 'Stories only',
    sentence: 'Posts a visible Story to the selected chats’ Stories feed; no background agent search is run.',
  },
];

const MATCH_OPTIONS: Array<{ value: MatchingMode; label: string; detail: string }> = [
  { value: 'fulfillment', label: 'Find help', detail: 'Someone has what you need, or needs what you have.' },
  { value: 'reciprocal', label: 'Complementary', detail: 'You can each bring something the other needs.' },
  { value: 'shared_goal', label: 'Shared goal', detail: 'You may want to work on the same thing together.' },
];

function splitList(value: string): string[] {
  return value.split(',').map(item => item.trim()).filter(Boolean);
}

export function StoryComposerScreen() {
  const { scheme } = useTheme();
  const c = getColors(scheme);
  const navigation = useNavigation<NavProp<'StoryComposer'>>();
  const route = useRoute<RouteProps<'StoryComposer'>>();
  const { conversations, currentUser } = useChat();
  const [draft, setDraft] = useState<IntentDraft | null>(null);
  const [text, setText] = useState(route.params?.initialText ?? '');
  const [goal, setGoal] = useState('');
  const [seeks, setSeeks] = useState('');
  const [brings, setBrings] = useState('');
  const [matchingMode, setMatchingMode] = useState<MatchingMode>('fulfillment');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [destination, setDestination] = useState<ComposerDestination>(
    route.params?.destination ?? 'stories_only',
  );
  const [textOnlyKind, setTextOnlyKind] = useState<AgentIntentKind | null>(null);
  const [expiry, setExpiry] = useState<Expiry>('day');
  const [previewing, setPreviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const quietSearch = destination === 'agents_only' || destination === 'both';
  const storyEnabled = destination === 'stories_only' || destination === 'both';

  const shareableConversations = useMemo(() => conversations.filter(conversation =>
    conversation.participants?.some(participant => (
      participant.user.id !== currentUser?.userId && !participant.user.isBot
    )),
  ), [conversations, currentUser?.userId]);

  useEffect(() => {
    const draftId = route.params?.draftId;
    if (!draftId) return;
    api.listIntentDrafts().then(items => {
      const found = items.find(item => item.id === draftId);
      if (!found) return;
      setDraft(found);
      setText(current => current || found.goal || found.seeks.join(', '));
      setGoal(found.goal || '');
      setSeeks(found.seeks.join(', '));
      setBrings(found.brings.join(', '));
      setMatchingMode(found.matchingMode);
    }).catch(() => setError('Could not load this private draft.'));
  }, [route.params?.draftId]);

  const audienceNames = useMemo(() => shareableConversations
    .filter(conversation => selected.has(conversation.id))
    .map(conversation => conversation.title || conversation.participants
      ?.filter(participant => participant.user.id !== currentUser?.userId)
      .map(participant => participant.user.name || participant.user.email)
      .join(', ') || 'Chat'), [shareableConversations, currentUser?.userId, selected]);

  const expiresAt = useMemo(() => new Date(
    Date.now() + (expiry === 'day' ? 24 : 7 * 24) * 3_600_000,
  ).toISOString(), [expiry]);
  const searchExpiresAt = useMemo(
    () => new Date(Date.now() + 30 * 24 * 3_600_000).toISOString(),
    [],
  );

  const toggleAudience = useCallback((conversationId: string) => {
    setSelected(previous => {
      const next = new Set(previous);
      if (next.has(conversationId)) next.delete(conversationId);
      else next.add(conversationId);
      return next;
    });
  }, []);

  const review = () => {
    setError(null);
    if (!quietSearch && !storyEnabled) {
      setError('Choose where to share: Agents only, Stories, or both.');
      return;
    }
    if (!text.trim()) {
      setError('Say what you want to share.');
      return;
    }
    if (selected.size === 0) {
      setError('Choose at least one person or group. OpenChat never assumes a global audience.');
      return;
    }
    if (quietSearch && !draft && splitList(seeks).length === 0 && splitList(brings).length === 0 && textOnlyKind === null) {
      setError('Choose whether the quiet search is looking for something or offering something.');
      return;
    }
    setPreviewing(true);
  };

  const publish = async () => {
    setBusy(true);
    setError(null);
    if (!quietSearch && !storyEnabled) {
      setError('Choose where to share: Agents only, Stories, or both.');
      setBusy(false);
      return;
    }

    const audience = { userIds: [], conversationIds: Array.from(selected) };
    const approvedQuietSearch = quietSearch
      ? { enabled: true as const, expiresAt: searchExpiresAt, audience }
      : undefined;

    try {
      if (destination === 'agents_only') {
        if (draft) {
          await api.activateIntentDraft(draft.id, {
            confirm: true,
            quietSearch: { enabled: true, expiresAt: searchExpiresAt, audience },
            story: { enabled: false },
          });
        } else {
          const seeksList = splitList(seeks);
          const bringsList = splitList(brings);
          const inferredSeeks = seeksList.length > 0
            ? seeksList
            : (textOnlyKind === 'ask' || (!textOnlyKind && !bringsList.length) ? [text.trim()] : []);
          const inferredBrings = bringsList.length > 0
            ? bringsList
            : (textOnlyKind === 'offer' ? [text.trim()] : []);
          const createdDraft = await api.createIntentDraft({
            goal: goal.trim() || undefined,
            seeks: inferredSeeks,
            brings: inferredBrings,
            matchingMode,
            openToCollaborators: matchingMode === 'shared_goal',
          });
          await api.activateIntentDraft(createdDraft.draft.id, {
            confirm: true,
            quietSearch: { enabled: true, expiresAt: searchExpiresAt, audience },
            story: { enabled: false },
          });
        }
      } else {
        if (draft) {
          await api.activateIntentDraft(draft.id, {
            confirm: true,
            quietSearch: approvedQuietSearch,
            story: { enabled: true, text: text.trim(), expiresAt, audience },
          });
        } else {
          await api.createStory({
            confirm: true,
            ...(textOnlyKind ? { kind: textOnlyKind } : {}),
            text: text.trim(),
            goal: goal.trim() || undefined,
            seeks: splitList(seeks),
            brings: splitList(brings),
            matchingMode,
            openToCollaborators: matchingMode === 'shared_goal',
            audience,
            storyExpiresAt: expiresAt,
            quietSearch: approvedQuietSearch,
          });
        }
      }
      navigation.goBack();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not share this.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: c.background }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView
        style={{ backgroundColor: c.background }}
        contentContainerStyle={styles.page}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
      >
        <View style={styles.headingBlock}>
          <Text style={[styles.eyebrow, { color: c.primary }]}>
            {destination === 'agents_only' ? 'SEARCH WITH AGENTS' : 'SHARE AN ASK'}
          </Text>
          <Text style={[styles.title, { color: c.textPrimary }]}>
            {destination === 'agents_only' ? 'What should agents search for?' : 'What should your network know?'}
          </Text>
          <Text style={[styles.lede, { color: c.textSecondary }]}>
            Write it naturally. Choose whether this goes to your network’s Stories feed, agents only, or both.
          </Text>
        </View>

        {!previewing ? (
          <>
            <TextInput
              autoFocus
              multiline
              value={text}
              onChangeText={setText}
              placeholder={destination === 'agents_only' ? 'I’m looking for an extra ticket…' : 'I’m looking for a Burning Man ticket for a friend…'}
              placeholderTextColor={c.textMuted}
              accessibilityLabel={destination === 'agents_only' ? 'Ask text' : 'Story text'}
              style={[styles.storyInput, { color: c.textPrimary, backgroundColor: c.surface, borderColor: c.border }]}
            />

            <Text style={[styles.sectionLabel, { color: c.textSecondary }]}>WHERE THIS GOES</Text>
            <View
              style={[styles.choiceCard, { backgroundColor: c.surface, borderColor: c.border }]}
              accessibilityRole="radiogroup"
              accessibilityLabel="Where this ask goes"
            >
              {DESTINATION_OPTIONS.map((option, idx) => {
                const checked = destination === option.value;
                const isLast = idx === DESTINATION_OPTIONS.length - 1;
                return (
                  <TouchableOpacity
                    key={option.value}
                    onPress={() => setDestination(option.value)}
                    accessibilityRole="radio"
                    accessibilityState={{ checked }}
                    style={[
                      styles.destinationRow,
                      !isLast && { borderBottomColor: c.border, borderBottomWidth: StyleSheet.hairlineWidth },
                    ]}
                  >
                    <View style={[
                      styles.radioCircle,
                      { borderColor: checked ? c.primary : c.border },
                    ]}>
                      {checked && <View style={[styles.radioDot, { backgroundColor: c.primary }]} />}
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: c.textPrimary, fontWeight: '700', fontSize: 14 }}>{option.label}</Text>
                      <Text style={{ color: c.textSecondary, fontSize: 12, lineHeight: 18, marginTop: 2 }}>{option.sentence}</Text>
                    </View>
                  </TouchableOpacity>
                );
              })}
            </View>

            <Text style={[styles.sectionLabel, { color: c.textSecondary }]}>
              {destination === 'agents_only' ? 'WHOSE AGENTS CAN SEARCH' : 'WHO CAN SEE IT'}
            </Text>
            <View style={[styles.choiceCard, { backgroundColor: c.surface, borderColor: c.border }]}>
              {shareableConversations.map(conversation => {
                const label = conversation.title || conversation.participants
                  ?.filter(participant => participant.user.id !== currentUser?.userId)
                  .map(participant => participant.user.name || participant.user.email)
                  .join(', ') || 'Chat';
                const checked = selected.has(conversation.id);
                return (
                  <TouchableOpacity
                    key={conversation.id}
                    onPress={() => toggleAudience(conversation.id)}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked }}
                    style={[styles.audienceRow, { borderBottomColor: c.border }]}
                  >
                    <View style={[styles.checkbox, { borderColor: checked ? c.primary : c.border, backgroundColor: checked ? c.primary : 'transparent' }]}>
                      {checked && <Text style={[styles.checkmark, { color: c.onPrimary }]}>✓</Text>}
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: c.textPrimary, fontWeight: '600' }}>{label}</Text>
                      <Text style={{ color: c.textMetadata, fontSize: 12 }}>{conversation.type === 'group' ? 'Group chat' : 'Direct chat'}</Text>
                    </View>
                  </TouchableOpacity>
                );
              })}
              {shareableConversations.length === 0 && (
                <Text style={[styles.noAudience, { color: c.textSecondary }]}>
                  {destination === 'agents_only'
                    ? 'Start a chat with someone before searching. OpenChat scopes agent searches to people you are connected with.'
                    : 'Start a chat with someone before sharing a Story. For an agent-only search, tell OpenChat Agent instead.'}
                </Text>
              )}
            </View>

            <Text style={[styles.sectionLabel, { color: c.textSecondary }]}>AGENT CONTEXT · OPTIONAL</Text>
            <View style={[styles.detailsCard, { backgroundColor: c.surface, borderColor: c.border }]}>
              <TextInput value={goal} onChangeText={setGoal} placeholder="Goal" placeholderTextColor={c.textMuted} style={[styles.lineInput, { color: c.textPrimary, borderBottomColor: c.border }]} />
              <TextInput value={seeks} onChangeText={setSeeks} placeholder="Looking for (comma separated)" placeholderTextColor={c.textMuted} style={[styles.lineInput, { color: c.textPrimary, borderBottomColor: c.border }]} />
              <TextInput value={brings} onChangeText={setBrings} placeholder="I can bring (comma separated)" placeholderTextColor={c.textMuted} style={[styles.lineInput, { color: c.textPrimary }]} />
            </View>
            <View style={styles.modeRow}>
              {MATCH_OPTIONS.map(option => (
                <TouchableOpacity key={option.value} onPress={() => setMatchingMode(option.value)} style={[styles.modeChip, { borderColor: matchingMode === option.value ? c.primary : c.border, backgroundColor: matchingMode === option.value ? c.primaryMuted : c.surface }]}>
                  <Text style={{ color: matchingMode === option.value ? c.primary : c.textSecondary, fontWeight: '700', fontSize: 12 }}>{option.label}</Text>
                </TouchableOpacity>
              ))}
            </View>

            {quietSearch && !draft && splitList(seeks).length === 0 && splitList(brings).length === 0 && (
              <View style={styles.modeRow} accessibilityRole="radiogroup" accessibilityLabel="Quiet search direction">
                {([
                  { value: 'ask' as const, label: 'I’m looking for this' },
                  { value: 'offer' as const, label: 'I’m offering this' },
                ]).map(option => (
                  <TouchableOpacity
                    key={option.value}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: textOnlyKind === option.value }}
                    onPress={() => setTextOnlyKind(option.value)}
                    style={[styles.modeChip, {
                      borderColor: textOnlyKind === option.value ? c.primary : c.border,
                      backgroundColor: textOnlyKind === option.value ? c.primaryMuted : c.surface,
                    }]}
                  >
                    <Text style={{ color: textOnlyKind === option.value ? c.primary : c.textSecondary, fontWeight: '700', fontSize: 12 }}>{option.label}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            )}
            {storyEnabled ? (
              <View style={styles.expiryRow}>
                {(['day', 'week'] as Expiry[]).map(value => (
                  <TouchableOpacity key={value} onPress={() => setExpiry(value)} style={[styles.expiryChoice, { borderColor: expiry === value ? c.primary : c.border, backgroundColor: expiry === value ? c.primaryMuted : c.surface }]}>
                    <Text style={{ color: expiry === value ? c.primary : c.textSecondary, fontWeight: '700' }}>{value === 'day' ? '24 hours' : '7 days'}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            ) : (
              <View style={[styles.quietExpiryNote, { borderColor: c.border, backgroundColor: c.surface }]}>
                <Text style={{ color: c.textPrimary, fontWeight: '600', fontSize: 13 }}>Agent search duration · 30 days</Text>
                <Text style={{ color: c.textSecondary, fontSize: 12, marginTop: 2 }}>Agents search quietly for 30 days. No human Story is posted to any feed.</Text>
              </View>
            )}
            {error && <Text accessibilityRole="alert" style={[styles.error, { color: c.danger }]}>{error}</Text>}
            <TouchableOpacity onPress={review} style={[styles.primary, { backgroundColor: c.primary }]}>
              <Text style={[styles.primaryText, { color: c.onPrimary }]}>
                {destination === 'agents_only' ? 'Review agent-only ask' : 'Review exact Story'}
              </Text>
            </TouchableOpacity>
          </>
        ) : (
          <View style={[styles.preview, { backgroundColor: c.surface, borderColor: c.border }]}>
            <Text style={[styles.eyebrow, { color: c.primary }]}>EXACT PUBLISH PREVIEW</Text>
            <Text style={[styles.previewText, { color: c.textPrimary }]}>{text.trim()}</Text>
            <View style={[styles.rule, { backgroundColor: c.border }]} />
            <Text style={[styles.fact, { color: c.textSecondary }]}>
              Where this goes: {destination === 'agents_only' ? 'Agents only' : destination === 'both' ? 'Stories and agents' : 'Stories only'}
            </Text>
            <Text style={[styles.fact, { color: c.textSecondary }]}>Audience: {audienceNames.join(' · ')}</Text>
            {storyEnabled && (
              <Text style={[styles.fact, { color: c.textSecondary }]}>Story expires: {expiry === 'day' ? '24 hours' : '7 days'}</Text>
            )}
            <Text style={[styles.fact, { color: c.textSecondary }]}>
              Agent search: {quietSearch ? 'Selected audience’s agents · 30 days' : 'Off'}
            </Text>
            {quietSearch && (
              <View
                style={[styles.searchPreview, { borderColor: c.border, backgroundColor: c.background }]}
              >
                <Text style={[styles.searchPreviewTitle, { color: c.textPrimary }]}>What those agents can search</Text>
                {!!goal.trim() && <Text style={[styles.fact, { color: c.textSecondary }]}>Goal: {goal.trim()}</Text>}
                {splitList(seeks).length > 0 && <Text style={[styles.fact, { color: c.textSecondary }]}>Looking for: {splitList(seeks).join(', ')}</Text>}
                {splitList(brings).length > 0 && <Text style={[styles.fact, { color: c.textSecondary }]}>Can bring: {splitList(brings).join(', ')}</Text>}
                {splitList(seeks).length === 0 && splitList(brings).length === 0 && (
                  <>
                    <Text style={[styles.fact, { color: c.textSecondary }]}>Direction: {textOnlyKind === 'ask' ? 'Looking for' : 'Offering'}</Text>
                    {!goal.trim() && <Text style={[styles.fact, { color: c.textSecondary }]}>Matching text: {text.trim()}</Text>}
                  </>
                )}
                <Text style={[styles.fact, { color: c.textSecondary }]}>Identity stays hidden until both people approve.</Text>
              </View>
            )}
            <Text style={[styles.privacy, { color: c.textMetadata }]}>
              {destination === 'agents_only'
                ? 'This ask goes to agents only and will never appear in anyone’s Stories feed.'
                : 'Only this text is shown to the selected people. Private agent context is not included.'}
            </Text>
            {error && <Text accessibilityRole="alert" style={[styles.error, { color: c.danger }]}>{error}</Text>}
            <TouchableOpacity disabled={busy} onPress={() => void publish()} style={[styles.primary, { backgroundColor: c.primary }, busy && { opacity: 0.55 }]}>
              {busy ? <ActivityIndicator color={c.onPrimary} /> : (
                <Text style={[styles.primaryText, { color: c.onPrimary }]}>
                  {destination === 'agents_only' ? 'Approve and search quietly' : 'Approve and share'}
                </Text>
              )}
            </TouchableOpacity>
            <TouchableOpacity disabled={busy} onPress={() => setPreviewing(false)} style={styles.editButton}>
              <Text style={{ color: c.primary, fontWeight: '700' }}>Edit</Text>
            </TouchableOpacity>
          </View>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  page: { width: '100%', maxWidth: 720, alignSelf: 'center', padding: 18, paddingBottom: 80 },
  headingBlock: { marginBottom: 16 },
  eyebrow: { ...capsLabel },
  title: { fontFamily: serif, fontSize: 28, fontWeight: '600', marginTop: 5 },
  lede: { fontSize: 14, lineHeight: 21, marginTop: 7, maxWidth: 580 },
  storyInput: { minHeight: 148, borderWidth: StyleSheet.hairlineWidth, borderRadius: 18, padding: 16, fontSize: 18, lineHeight: 27, textAlignVertical: 'top' },
  sectionLabel: { ...capsLabel, marginTop: 22, marginBottom: 8 },
  choiceCard: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 14, overflow: 'hidden' },
  destinationRow: { minHeight: 58, paddingHorizontal: 14, paddingVertical: 12, flexDirection: 'row', alignItems: 'center', gap: 12 },
  radioCircle: { width: 20, height: 20, borderRadius: 10, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  radioDot: { width: 10, height: 10, borderRadius: 5 },
  audienceRow: { minHeight: 58, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', gap: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  noAudience: { padding: 14, fontSize: 13, lineHeight: 19 },
  checkbox: { width: 22, height: 22, borderRadius: 7, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  checkmark: { fontSize: 14, fontWeight: '800' },
  detailsCard: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 14, paddingHorizontal: 14 },
  lineInput: { minHeight: 50, borderBottomWidth: StyleSheet.hairlineWidth, fontSize: 14 },
  modeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 },
  modeChip: { minHeight: 40, borderWidth: StyleSheet.hairlineWidth, borderRadius: 20, paddingHorizontal: 13, alignItems: 'center', justifyContent: 'center' },
  expiryRow: { flexDirection: 'row', gap: 8, marginTop: 10 },
  expiryChoice: { minHeight: 44, flex: 1, borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  quietExpiryNote: { marginTop: 10, borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, padding: 12 },
  primary: { minHeight: 50, marginTop: 18, borderRadius: 14, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 18 },
  primaryText: { fontWeight: '800', fontSize: 15 },
  error: { marginTop: 12, fontSize: 13, lineHeight: 19 },
  preview: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 20, padding: 20 },
  previewText: { fontFamily: serif, fontSize: 23, lineHeight: 32, marginTop: 12 },
  rule: { height: StyleSheet.hairlineWidth, marginVertical: 18 },
  fact: { fontSize: 13, lineHeight: 21 },
  privacy: { fontSize: 12, lineHeight: 18, marginTop: 12 },
  searchPreview: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, padding: 12, marginTop: 10 },
  searchPreviewTitle: { fontSize: 12, fontWeight: '800', marginBottom: 4 },
  editButton: { minHeight: 48, alignItems: 'center', justifyContent: 'center' },
});
