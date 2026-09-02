import { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { api, type AgentIntent, type AgentIntentKind, type AgentMatch } from '../api/client';
import { useChat } from '../contexts/ChatContext';
import { useTheme } from '../contexts/ThemeContext';
import type { NavProp } from '../navigation/types';
import { getColors } from '../theme/colors';
import { capsLabel, serif } from '../theme/typography';

const MATCH_ORDER: Record<AgentMatch['status'], number> = {
  pending: 0,
  awaiting_other: 1,
  connected: 2,
  closed: 3,
};

function kindLabel(kind: AgentIntentKind): string {
  return kind === 'ask' ? 'Ask' : 'Offer';
}

export function AgentOverlayScreen() {
  const navigation = useNavigation<NavProp<'AgentOverlay'>>();
  const { scheme } = useTheme();
  const c = getColors(scheme);
  const {
    matches,
    refetchMatches,
    respondToAgentMatch,
    refreshConversations,
  } = useChat();

  const [intents, setIntents] = useState<AgentIntent[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyMatchId, setBusyMatchId] = useState<string | null>(null);
  const [withdrawingId, setWithdrawingId] = useState<string | null>(null);
  const [kind, setKind] = useState<AgentIntentKind>('ask');
  const [terms, setTerms] = useState('');
  const [details, setDetails] = useState('');
  const [reviewTerms, setReviewTerms] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [composerError, setComposerError] = useState<string | null>(null);
  const [openingAgent, setOpeningAgent] = useState(false);

  const loadOverlay = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [, latestIntents] = await Promise.all([refetchMatches(), api.listIntents()]);
      setIntents(latestIntents);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Could not load your agent network.');
    } finally {
      setLoading(false);
    }
  }, [refetchMatches]);

  // Native-stack modals may remain mounted briefly while dismissing. Focus is
  // the precise "overlay opened" boundary required for an authoritative GET.
  useFocusEffect(useCallback(() => {
    void loadOverlay();
  }, [loadOverlay]));

  const visibleMatches = useMemo(
    () => Array.from(matches.values())
      .filter(match => match.status !== 'closed')
      .sort((a, b) => MATCH_ORDER[a.status] - MATCH_ORDER[b.status]
        || new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()),
    [matches]
  );

  const respond = async (matchId: string, decision: 'approve' | 'decline') => {
    if (busyMatchId) return;
    setBusyMatchId(matchId);
    setLoadError(null);
    try {
      await respondToAgentMatch(matchId, decision);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Could not update this match.');
    } finally {
      setBusyMatchId(null);
    }
  };

  const withdraw = async (intent: AgentIntent) => {
    setWithdrawingId(intent.id);
    try {
      const { intent: updated } = await api.withdrawIntent(intent.id);
      setIntents(prev => prev.map(item => item.id === updated.id ? updated : item));
    } catch (err) {
      Alert.alert('Could not withdraw', err instanceof Error ? err.message : 'Please try again.');
    } finally {
      setWithdrawingId(null);
    }
  };

  const confirmWithdraw = (intent: AgentIntent) => {
    Alert.alert(
      `Withdraw this ${intent.kind}?`,
      'It will stop being discoverable. Existing connected conversations are unchanged.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Withdraw', style: 'destructive', onPress: () => void withdraw(intent) },
      ]
    );
  };

  const beginReview = () => {
    const exactPublishedTerms = terms.trim();
    if (!exactPublishedTerms) {
      setComposerError('Enter anonymous terms before continuing.');
      return;
    }
    if (exactPublishedTerms.length > 500) {
      setComposerError('Anonymous terms must be 500 characters or fewer.');
      return;
    }
    if (details.length > 2000) {
      setComposerError('Private details must be 2,000 characters or fewer.');
      return;
    }
    setTerms(exactPublishedTerms);
    setComposerError(null);
    setReviewTerms(exactPublishedTerms);
  };

  const publish = async () => {
    if (reviewTerms === null || publishing) return;
    setPublishing(true);
    setComposerError(null);
    try {
      const { intent } = await api.publishIntent({
        kind,
        terms: reviewTerms,
        ...(details ? { details } : {}),
      });
      setIntents(prev => [intent, ...prev.filter(item => item.id !== intent.id)]);
      setTerms('');
      setDetails('');
      setReviewTerms(null);
    } catch (err) {
      setComposerError(err instanceof Error ? err.message : 'Could not publish this intent.');
    } finally {
      setPublishing(false);
    }
  };

  const openConversation = async (conversationId: string) => {
    // The conversation may have been created by the second approval on
    // another device; refresh metadata before opening its normal chat route.
    await refreshConversations();
    navigation.navigate('Chat', { conversationId });
  };

  const openAgentChat = async () => {
    if (openingAgent) return;
    setOpeningAgent(true);
    setLoadError(null);
    try {
      const conversation = await api.ensureAssistant();
      await refreshConversations();
      navigation.navigate('Chat', { conversationId: conversation.id });
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Could not open your agent chat.');
    } finally {
      setOpeningAgent(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={[styles.root, { backgroundColor: c.background }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={[styles.intro, { color: c.textSecondary }]}>Anonymous asks and offers, shared only when you choose.</Text>

        {loadError && (
          <View style={[styles.errorBox, { backgroundColor: c.dangerMuted }]}>
            <Text accessibilityRole="alert" style={[styles.errorText, { color: c.danger }]}>{loadError}</Text>
            <TouchableOpacity accessibilityRole="button" onPress={() => void loadOverlay()}>
              <Text style={[styles.retry, { color: c.primary }]}>Try again</Text>
            </TouchableOpacity>
          </View>
        )}

        <Text style={[styles.sectionTitle, { color: c.textPrimary }]}>Pending matches</Text>
        {loading ? (
          <ActivityIndicator color={c.primary} style={styles.loader} />
        ) : visibleMatches.length === 0 ? (
          <Text style={[styles.emptyText, { color: c.textMuted }]}>No matches need your attention.</Text>
        ) : visibleMatches.map(match => (
          <View key={match.id} style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }]}>
            <Text style={[styles.eyebrow, { color: c.textMuted }]}>ANONYMOUS {match.otherKind.toUpperCase()}</Text>
            <Text style={[styles.terms, { color: c.textPrimary }]}>{match.otherTerms}</Text>
            <View style={[styles.ownIntent, { borderTopColor: c.divider }]}>
              <Text style={[styles.ownLabel, { color: c.textSecondary }]}>Your {match.ownIntent.kind}</Text>
              <Text style={[styles.ownTerms, { color: c.textSecondary }]}>{match.ownIntent.terms}</Text>
            </View>

            {match.status === 'pending' && (
              <View style={styles.actionRow}>
                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityLabel="Approve anonymous match"
                  disabled={busyMatchId !== null}
                  onPress={() => void respond(match.id, 'approve')}
                  style={[styles.primaryButton, { backgroundColor: c.primary }, busyMatchId && styles.disabled]}
                >
                  {busyMatchId === match.id
                    ? <ActivityIndicator size="small" color="#fff" />
                    : <Text style={styles.primaryButtonText}>Approve</Text>}
                </TouchableOpacity>
                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityLabel="Decline anonymous match"
                  disabled={busyMatchId !== null}
                  onPress={() => void respond(match.id, 'decline')}
                  style={[styles.secondaryButton, { borderColor: c.border }, busyMatchId && styles.disabled]}
                >
                  <Text style={[styles.secondaryButtonText, { color: c.textSecondary }]}>Decline</Text>
                </TouchableOpacity>
              </View>
            )}
            {match.status === 'awaiting_other' && (
              <Text style={[styles.stateText, { color: c.textSecondary }]}>Approved · waiting for the other side</Text>
            )}
            {match.status === 'connected' && (
              <TouchableOpacity
                accessibilityRole="button"
                disabled={!match.conversationId}
                onPress={() => match.conversationId && void openConversation(match.conversationId)}
                style={[styles.openButton, { borderColor: c.primary }, !match.conversationId && styles.disabled]}
              >
                <Text style={[styles.openButtonText, { color: c.primary }]}>Open conversation</Text>
              </TouchableOpacity>
            )}
          </View>
        ))}

        <Text style={[styles.sectionTitle, styles.laterSection, { color: c.textPrimary }]}>Your asks &amp; offers</Text>
        {!loading && intents.length === 0 ? (
          <Text style={[styles.emptyText, { color: c.textMuted }]}>You haven’t published an ask or offer yet.</Text>
        ) : intents.map(intent => (
          <View key={intent.id} style={[styles.intentRow, { borderColor: c.divider }]}>
            <View style={styles.intentCopy}>
              <Text style={[styles.eyebrow, { color: c.textMuted }]}>{kindLabel(intent.kind).toUpperCase()} · {intent.status.toUpperCase()}</Text>
              <Text style={[styles.intentTerms, { color: c.textPrimary }]}>{intent.terms}</Text>
            </View>
            {intent.status === 'active' && (
              <TouchableOpacity
                accessibilityRole="button"
                disabled={withdrawingId !== null}
                onPress={() => confirmWithdraw(intent)}
                style={styles.withdrawButton}
              >
                {withdrawingId === intent.id
                  ? <ActivityIndicator size="small" color={c.danger} />
                  : <Text style={[styles.withdrawText, { color: c.danger }]}>Withdraw</Text>}
              </TouchableOpacity>
            )}
          </View>
        ))}

        <Text style={[styles.sectionTitle, styles.laterSection, { color: c.textPrimary }]}>New ask or offer</Text>
        <View style={styles.kindToggle}>
          {(['ask', 'offer'] as const).map(option => {
            const selected = kind === option;
            return (
              <TouchableOpacity
                key={option}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                disabled={reviewTerms !== null}
                onPress={() => setKind(option)}
                style={[
                  styles.kindButton,
                  { borderColor: selected ? c.primary : c.border, backgroundColor: selected ? c.primaryMuted : c.surface },
                ]}
              >
                <Text style={{ color: selected ? c.primary : c.textSecondary, fontWeight: '700' }}>{kindLabel(option)}</Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {reviewTerms === null ? (
          <>
            <Text style={[styles.fieldLabel, { color: c.textSecondary }]}>Anonymous terms</Text>
            <TextInput
              value={terms}
              onChangeText={setTerms}
              maxLength={500}
              multiline
              placeholder={kind === 'ask' ? 'What are you looking for?' : 'What can you offer?'}
              placeholderTextColor={c.textMuted}
              style={[styles.input, { color: c.textPrimary, backgroundColor: c.surface, borderColor: c.border }]}
            />
            <Text style={[styles.count, { color: c.textMuted }]}>{terms.length}/500</Text>

            <Text style={[styles.fieldLabel, { color: c.textSecondary }]}>Private details · optional</Text>
            <Text style={[styles.privacyNote, { color: c.textMuted }]}>Only you and your agent see this</Text>
            <TextInput
              value={details}
              onChangeText={setDetails}
              maxLength={2000}
              multiline
              placeholder="Context that should stay private"
              placeholderTextColor={c.textMuted}
              style={[styles.input, styles.detailsInput, { color: c.textPrimary, backgroundColor: c.surface, borderColor: c.border }]}
            />
            <Text style={[styles.count, { color: c.textMuted }]}>{details.length}/2000</Text>
            <TouchableOpacity
              accessibilityRole="button"
              onPress={beginReview}
              style={[styles.fullPrimaryButton, { backgroundColor: c.primary }]}
            >
              <Text style={styles.primaryButtonText}>Review before publishing</Text>
            </TouchableOpacity>
          </>
        ) : (
          <View style={[styles.confirmCard, { backgroundColor: c.surfaceElevated, borderColor: c.border }]}>
            <Text style={[styles.confirmTitle, { color: c.textPrimary }]}>Confirm anonymous terms</Text>
            <Text style={[styles.confirmWarning, { color: c.textSecondary }]}>This exact text becomes anonymously discoverable to other people&apos;s agents.</Text>
            <View style={[styles.exactTerms, { backgroundColor: c.surface, borderColor: c.border }]}>
              <Text style={[styles.terms, { color: c.textPrimary }]}>{reviewTerms}</Text>
            </View>
            <View style={styles.actionRow}>
              <TouchableOpacity
                accessibilityRole="button"
                disabled={publishing}
                onPress={() => void publish()}
                style={[styles.primaryButton, { backgroundColor: c.primary }, publishing && styles.disabled]}
              >
                {publishing
                  ? <ActivityIndicator size="small" color="#fff" />
                  : <Text style={styles.primaryButtonText}>Publish</Text>}
              </TouchableOpacity>
              <TouchableOpacity
                accessibilityRole="button"
                disabled={publishing}
                onPress={() => setReviewTerms(null)}
                style={[styles.secondaryButton, { borderColor: c.border }]}
              >
                <Text style={[styles.secondaryButtonText, { color: c.textSecondary }]}>Edit</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}
        {composerError && <Text accessibilityRole="alert" style={[styles.composerError, { color: c.danger }]}>{composerError}</Text>}

        <TouchableOpacity
          accessibilityRole="button"
          disabled={openingAgent}
          onPress={() => void openAgentChat()}
          style={[styles.agentFooter, { borderTopColor: c.divider }]}
        >
          {openingAgent
            ? <ActivityIndicator color={c.primary} />
            : <Text style={[styles.agentFooterText, { color: c.primary }]}>Chat with your agent</Text>}
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { width: '100%', maxWidth: 680, alignSelf: 'center', padding: 20, paddingBottom: 48 },
  intro: { fontSize: 14, lineHeight: 20, marginBottom: 24 },
  sectionTitle: { fontFamily: serif, fontSize: 21, fontWeight: '600', marginBottom: 12 },
  laterSection: { marginTop: 30 },
  loader: { marginVertical: 18 },
  emptyText: { fontSize: 14, lineHeight: 20 },
  errorBox: { borderRadius: 12, padding: 12, marginBottom: 18, gap: 8 },
  errorText: { fontSize: 13, lineHeight: 18 },
  retry: { fontSize: 13, fontWeight: '700' },
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 16, padding: 16, marginBottom: 12 },
  eyebrow: { ...capsLabel },
  terms: { marginTop: 6, fontSize: 15, lineHeight: 21 },
  ownIntent: { marginTop: 14, paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth },
  ownLabel: { fontSize: 12, fontWeight: '700' },
  ownTerms: { marginTop: 3, fontSize: 13, lineHeight: 19 },
  actionRow: { flexDirection: 'row', gap: 9, marginTop: 16 },
  primaryButton: { minWidth: 104, minHeight: 42, borderRadius: 10, paddingHorizontal: 18, alignItems: 'center', justifyContent: 'center' },
  primaryButtonText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  secondaryButton: { minWidth: 104, minHeight: 42, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 18, alignItems: 'center', justifyContent: 'center' },
  secondaryButtonText: { fontSize: 14, fontWeight: '700' },
  disabled: { opacity: 0.5 },
  stateText: { marginTop: 15, fontSize: 14, fontWeight: '600' },
  openButton: { alignSelf: 'flex-start', marginTop: 15, minHeight: 40, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 14, alignItems: 'center', justifyContent: 'center' },
  openButtonText: { fontSize: 14, fontWeight: '700' },
  intentRow: { flexDirection: 'row', alignItems: 'center', minWidth: 0, paddingVertical: 13, borderBottomWidth: StyleSheet.hairlineWidth, gap: 12 },
  intentCopy: { flex: 1, minWidth: 0 },
  intentTerms: { marginTop: 4, fontSize: 14, lineHeight: 20 },
  withdrawButton: { minWidth: 76, minHeight: 40, alignItems: 'center', justifyContent: 'center' },
  withdrawText: { fontSize: 13, fontWeight: '700' },
  kindToggle: { flexDirection: 'row', gap: 8, marginBottom: 16 },
  kindButton: { flex: 1, minHeight: 42, borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  fieldLabel: { fontSize: 13, fontWeight: '700', marginTop: 10, marginBottom: 6 },
  privacyNote: { fontSize: 12, marginTop: -3, marginBottom: 7 },
  input: { minHeight: 92, borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, padding: 12, fontSize: 15, lineHeight: 21, textAlignVertical: 'top' },
  detailsInput: { minHeight: 112 },
  count: { alignSelf: 'flex-end', fontSize: 11, marginTop: 4 },
  fullPrimaryButton: { minHeight: 46, borderRadius: 11, alignItems: 'center', justifyContent: 'center', marginTop: 18 },
  confirmCard: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 15, padding: 16 },
  confirmTitle: { fontFamily: serif, fontSize: 18, fontWeight: '600' },
  confirmWarning: { marginTop: 7, fontSize: 14, lineHeight: 20 },
  exactTerms: { marginTop: 14, borderWidth: StyleSheet.hairlineWidth, borderRadius: 11, padding: 12 },
  composerError: { marginTop: 10, fontSize: 13 },
  agentFooter: { minHeight: 64, borderTopWidth: StyleSheet.hairlineWidth, marginTop: 34, alignItems: 'center', justifyContent: 'center' },
  agentFooterText: { fontSize: 15, fontWeight: '700' },
});
