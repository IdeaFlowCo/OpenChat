import React, { useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { api, type AgentIntentKind, type AgentMatchStatus, type MatchingMode, type Message } from '../api/client';
import { useChat } from '../contexts/ChatContext';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';

type CardPayload = MatchProposalPayload | MatchStatusPayload | MatchContextPayload | IntentDraftPayload;
type MatchType = 'complementary' | 'reciprocal' | 'shared_goal';

interface IntentDraftPayload {
  kind: 'intent_draft';
  version: 1;
  draft: {
    id: string;
    goal: string | null;
    seeks: string[];
    brings: string[];
    matchingMode: MatchingMode;
    openToCollaborators: boolean;
    confidence: number | null;
    state: 'pending' | 'dismissed' | 'activated';
    createdAt: string;
  };
  visibility: { current: 'private'; humanVisible: false; agentSearchEnabled: false };
  suggestedActivation: {
    quietSearch: { enabled: true; expiresAt: string };
    closeOnConnect: boolean;
    audienceLabel: string;
  };
  actions: string[];
}

interface MatchProposalPayload {
  kind: 'match_proposal';
  matchId: string;
  ownIntent: { id: string; kind: AgentIntentKind; terms: string };
  otherTerms: string;
  otherKind: AgentIntentKind;
  status: AgentMatchStatus;
  matchType: MatchType;
  score?: number;
}

interface MatchStatusPayload {
  kind: 'match_status';
  matchId: string;
  status: AgentMatchStatus;
}

interface MatchContextPayload {
  kind: 'match_context';
  matchId: string;
  askTerms: string;
  offerTerms: string;
  matchType: MatchType;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isIntentKind(value: unknown): value is AgentIntentKind {
  return value === 'ask' || value === 'offer';
}

function isMatchStatus(value: unknown): value is AgentMatchStatus {
  return value === 'pending' || value === 'awaiting_other' || value === 'closed' || value === 'connected';
}

function isMatchType(value: unknown): value is MatchType {
  return value === 'complementary' || value === 'reciprocal' || value === 'shared_goal';
}

function parseCard(message: Message): CardPayload | null {
  if (typeof message.cardPayload !== 'string') return null;

  let payload: unknown;
  try {
    payload = JSON.parse(message.cardPayload);
  } catch {
    return null;
  }
  if (!isRecord(payload)) return null;

  if (message.cardKind === 'intent_draft') {
    const draft = payload.draft;
    const visibility = payload.visibility;
    const suggestedActivation = payload.suggestedActivation;
    const quietSearch = isRecord(suggestedActivation) ? suggestedActivation.quietSearch : null;
    if (
      payload.version === 1
      && isRecord(draft)
      && typeof draft.id === 'string'
      && (typeof draft.goal === 'string' || draft.goal === null)
      && Array.isArray(draft.seeks) && draft.seeks.every(value => typeof value === 'string')
      && Array.isArray(draft.brings) && draft.brings.every(value => typeof value === 'string')
      && (draft.matchingMode === 'fulfillment' || draft.matchingMode === 'reciprocal' || draft.matchingMode === 'shared_goal')
      && typeof draft.openToCollaborators === 'boolean'
      && (typeof draft.confidence === 'number' || draft.confidence === null)
      && (draft.state === 'pending' || draft.state === 'dismissed' || draft.state === 'activated')
      && typeof draft.createdAt === 'string'
      && isRecord(visibility)
      && visibility.current === 'private'
      && visibility.humanVisible === false
      && visibility.agentSearchEnabled === false
      && isRecord(suggestedActivation)
      && isRecord(quietSearch)
      && quietSearch.enabled === true
      && typeof quietSearch.expiresAt === 'string'
      && typeof suggestedActivation.closeOnConnect === 'boolean'
      && typeof suggestedActivation.audienceLabel === 'string'
      && Array.isArray(payload.actions)
    ) {
      return {
        kind: 'intent_draft',
        version: 1,
        draft: draft as unknown as IntentDraftPayload['draft'],
        visibility: visibility as unknown as IntentDraftPayload['visibility'],
        suggestedActivation: suggestedActivation as unknown as IntentDraftPayload['suggestedActivation'],
        actions: payload.actions.filter(value => typeof value === 'string') as string[],
      };
    }
  }

  if (message.cardKind === 'match_proposal') {
    const ownIntent = payload.ownIntent;
    if (
      typeof payload.matchId === 'string'
      && isRecord(ownIntent)
      && typeof ownIntent.id === 'string'
      && isIntentKind(ownIntent.kind)
      && typeof ownIntent.terms === 'string'
      && typeof payload.otherTerms === 'string'
      && isIntentKind(payload.otherKind)
      && isMatchStatus(payload.status)
    ) {
      return {
        kind: 'match_proposal',
        matchId: payload.matchId,
        ownIntent: { id: ownIntent.id, kind: ownIntent.kind, terms: ownIntent.terms },
        otherTerms: payload.otherTerms,
        otherKind: payload.otherKind,
        status: payload.status,
        matchType: isMatchType(payload.matchType) ? payload.matchType : 'complementary',
        ...(typeof payload.score === 'number' ? { score: payload.score } : {}),
      };
    }
  }

  if (
    message.cardKind === 'match_status'
    && typeof payload.matchId === 'string'
    && isMatchStatus(payload.status)
  ) {
    return { kind: 'match_status', matchId: payload.matchId, status: payload.status };
  }

  if (
    message.cardKind === 'match_context'
    && typeof payload.matchId === 'string'
    && typeof payload.askTerms === 'string'
    && typeof payload.offerTerms === 'string'
  ) {
    return {
      kind: 'match_context',
      matchId: payload.matchId,
      askTerms: payload.askTerms,
      offerTerms: payload.offerTerms,
      matchType: isMatchType(payload.matchType) ? payload.matchType : 'complementary',
    };
  }

  return null;
}

function statusText(status: AgentMatchStatus): string {
  switch (status) {
    case 'pending': return 'Waiting for your response';
    case 'awaiting_other': return 'Approved · waiting for the other side';
    case 'connected': return 'Connected';
    case 'closed': return 'No longer available';
  }
}

interface AgentNetworkCardProps {
  message: Message;
  onOpenConversation: (conversationId: string) => void;
  onShareDraft?: (draftId: string, initialText: string) => void;
}

export function AgentNetworkCard({ message, onOpenConversation, onShareDraft }: AgentNetworkCardProps) {
  const { scheme } = useTheme();
  const c = getColors(scheme);
  const { matches, respondToAgentMatch } = useChat();
  const payload = parseCard(message);
  const [busyDecision, setBusyDecision] = useState<'approve' | 'decline' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyDraftAction, setBusyDraftAction] = useState<'quiet' | 'private' | null>(null);
  const [draftResolution, setDraftResolution] = useState<'activated' | 'dismissed' | null>(null);

  const respond = async (proposal: MatchProposalPayload, decision: 'approve' | 'decline') => {
    if (busyDecision) return;
    setBusyDecision(decision);
    setError(null);
    try {
      await respondToAgentMatch(proposal.matchId, decision);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update this match.');
    } finally {
      setBusyDecision(null);
    }
  };

  const shellStyle = [styles.shell, { backgroundColor: c.surfaceElevated, borderColor: c.border }];

  if (!payload) {
    return (
      <View style={styles.centered} accessibilityRole="text">
        <View style={[styles.compactShell, { backgroundColor: c.surfaceElevated, borderColor: c.border }]}>
          <Text style={[styles.compactText, { color: c.textSecondary }]}>Update from your agent</Text>
        </View>
      </View>
    );
  }

  if (payload.kind === 'intent_draft') {
    const title = payload.draft.goal || payload.draft.seeks[0] || payload.draft.brings[0] || 'Something to remember';
    const resolution = draftResolution || (payload.draft.state !== 'pending' ? payload.draft.state : null);
    const resolved = resolution !== null;
    const activateQuiet = async () => {
      setBusyDraftAction('quiet');
      setError(null);
      try {
        await api.activateIntentDraft(payload.draft.id, {
          quietSearch: payload.suggestedActivation.quietSearch,
          closeOnConnect: payload.suggestedActivation.closeOnConnect,
        });
        setDraftResolution('activated');
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not start this quiet search.');
      } finally {
        setBusyDraftAction(null);
      }
    };
    const keepPrivate = async () => {
      setBusyDraftAction('private');
      setError(null);
      try {
        await api.updateIntentDraft(payload.draft.id, { state: 'dismissed' });
        setDraftResolution('dismissed');
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not update this private draft.');
      } finally {
        setBusyDraftAction(null);
      }
    };
    return (
      <View style={styles.centered}>
        <View style={shellStyle} accessibilityLabel="Private intention draft from My Agent">
          <Text style={[styles.eyebrow, { color: c.primary }]}>PRIVATE DRAFT</Text>
          <Text style={[styles.title, { color: c.textPrimary }]}>{title}</Text>
          {payload.draft.seeks.length > 0 && <Text style={[styles.terms, { color: c.textSecondary }]}>Looking for · {payload.draft.seeks.join(', ')}</Text>}
          {payload.draft.brings.length > 0 && <Text style={[styles.terms, { color: c.textSecondary }]}>Can bring · {payload.draft.brings.join(', ')}</Text>}
          <View style={[styles.privacyBlock, { backgroundColor: c.surface, borderColor: c.border }]}>
            <Text style={[styles.privacyTitle, { color: c.textPrimary }]}>Still private</Text>
            <Text style={[styles.privacyText, { color: c.textSecondary }]}>No person or outside agent can see this yet. Choose a next step.</Text>
          </View>
          {!resolved && (
            <View style={[styles.approvalPreview, { borderColor: c.border }]}>
              <Text style={[styles.approvalPreviewTitle, { color: c.textPrimary }]}>Quiet-search approval</Text>
              <Text style={[styles.privacyText, { color: c.textSecondary }]}>Audience: {payload.suggestedActivation.audienceLabel}</Text>
              <Text style={[styles.privacyText, { color: c.textSecondary }]}>Expires: {new Date(payload.suggestedActivation.quietSearch.expiresAt).toLocaleDateString()}</Text>
              <Text style={[styles.privacyText, { color: c.textSecondary }]}>Identity: hidden until both people approve an introduction</Text>
            </View>
          )}
          {!resolved ? (
            <View style={styles.draftActions}>
              <TouchableOpacity disabled={busyDraftAction !== null} onPress={() => void activateQuiet()} style={[styles.primaryButton, { backgroundColor: c.primary }, busyDraftAction && styles.disabled]} accessibilityLabel={`Search quietly with ${payload.suggestedActivation.audienceLabel} until ${new Date(payload.suggestedActivation.quietSearch.expiresAt).toLocaleDateString()}; identity stays hidden until both approve`}>
                {busyDraftAction === 'quiet' ? <ActivityIndicator size="small" color="#fff" /> : <Text style={styles.primaryButtonText}>Search quietly</Text>}
              </TouchableOpacity>
              <TouchableOpacity disabled={!onShareDraft || busyDraftAction !== null} onPress={() => onShareDraft?.(payload.draft.id, title)} style={[styles.secondaryButton, { backgroundColor: c.surface, borderColor: c.border }]}>
                <Text style={[styles.secondaryButtonText, { color: c.primary }]}>Share with people…</Text>
              </TouchableOpacity>
              <TouchableOpacity disabled={busyDraftAction !== null} onPress={() => void keepPrivate()} style={styles.keepPrivateButton}>
                {busyDraftAction === 'private' ? <ActivityIndicator size="small" color={c.textMuted} /> : <Text style={{ color: c.textMuted, fontWeight: '700' }}>Keep private</Text>}
              </TouchableOpacity>
            </View>
          ) : <Text style={[styles.stateText, { color: c.textSecondary }]}>{resolution === 'activated' ? 'Approved for quiet search' : 'Kept private'}</Text>}
          {error && <Text accessibilityRole="alert" style={[styles.error, { color: c.danger }]}>{error}</Text>}
        </View>
      </View>
    );
  }

  if (payload.kind === 'match_status') {
    return (
      <View style={styles.centered} accessibilityRole="text">
        <View style={[styles.compactShell, { backgroundColor: c.surfaceElevated, borderColor: c.border }]}>
          <Text style={[styles.compactText, { color: c.textSecondary }]}>Match update · {statusText(payload.status)}</Text>
        </View>
      </View>
    );
  }

  if (payload.kind === 'match_context') {
    const sharedGoal = payload.matchType === 'shared_goal';
    const reciprocal = payload.matchType === 'reciprocal';
    return (
      <View style={styles.centered}>
        <View style={shellStyle} accessibilityLabel={sharedGoal ? 'Your agents found a shared goal' : reciprocal ? 'Your agents found a reciprocal match' : 'Your agents matched an ask and an offer'}>
          <Text style={[styles.title, { color: c.textPrimary }]}>{sharedGoal ? 'Your agents found a shared goal' : reciprocal ? 'Your agents found a reciprocal match' : 'Your agents matched an ask and an offer'}</Text>
          <View style={styles.termBlock}>
            <Text style={[styles.label, { color: c.textMuted }]}>{sharedGoal ? 'ONE SIDE' : reciprocal ? 'ONE SIDE' : 'ASK'}</Text>
            <Text style={[styles.terms, { color: c.textPrimary }]}>{payload.askTerms}</Text>
          </View>
          <View
            style={[styles.dividedTermBlock, { borderTopColor: c.border }]}
          >
            <Text style={[styles.label, { color: c.textMuted }]}>{sharedGoal ? 'SHARED DIRECTION' : reciprocal ? 'COMPLEMENTARY SIDE' : 'OFFER'}</Text>
            <Text style={[styles.terms, { color: c.textPrimary }]}>{payload.offerTerms}</Text>
          </View>
        </View>
      </View>
    );
  }

  const liveMatch = matches.get(payload.matchId);
  const status = liveMatch?.status ?? payload.status;
  const isUnavailable = status === 'closed' || (!!liveMatch?.alreadyResolved && status !== 'connected');
  const matchType = liveMatch?.matchType ?? payload.matchType;
  const sharedGoal = matchType === 'shared_goal';
  const reciprocal = matchType === 'reciprocal';

  return (
    <View style={styles.centered}>
      <View style={shellStyle} accessibilityLabel="Anonymous match proposal">
        <Text style={[styles.eyebrow, { color: c.textMuted }]}>{sharedGoal ? 'SHARED GOAL' : reciprocal ? 'RECIPROCAL MATCH' : 'QUIET MATCH'}</Text>
        <Text style={[styles.title, { color: c.textPrimary }]}>{sharedGoal ? 'You may want to collaborate' : reciprocal ? 'You may complement each other' : 'A possible match'}</Text>

        <View style={[styles.anonymousTerms, { backgroundColor: c.surface, borderColor: c.border }]}>
          <Text style={[styles.label, { color: c.textMuted }]}>{sharedGoal ? 'ANONYMOUS SHARED DIRECTION' : reciprocal ? 'ANONYMOUS COMPLEMENT' : `ANONYMOUS ${payload.otherKind.toUpperCase()}`}</Text>
          <Text style={[styles.terms, { color: c.textPrimary }]}>{payload.otherTerms}</Text>
        </View>

        <View style={styles.ownTerms}>
          <Text style={[styles.ownLabel, { color: c.textSecondary }]}>{sharedGoal ? 'Your goal' : reciprocal ? 'Your side' : `Your ${payload.ownIntent.kind}`}</Text>
          <Text style={[styles.terms, { color: c.textSecondary }]}>{payload.ownIntent.terms}</Text>
        </View>

        {status === 'pending' && !liveMatch?.alreadyResolved && (
          <View style={styles.actions}>
            <TouchableOpacity
              onPress={() => void respond(payload, 'approve')}
              disabled={busyDecision !== null}
              accessibilityRole="button"
              accessibilityLabel="Approve anonymous match"
              style={[styles.primaryButton, { backgroundColor: c.primary }, busyDecision && styles.disabled]}
            >
              {busyDecision === 'approve'
                ? <ActivityIndicator size="small" color="#fff" />
                : <Text style={styles.primaryButtonText}>Approve</Text>}
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => void respond(payload, 'decline')}
              disabled={busyDecision !== null}
              accessibilityRole="button"
              accessibilityLabel="Decline anonymous match"
              style={[styles.secondaryButton, { backgroundColor: c.surface, borderColor: c.border }, busyDecision && styles.disabled]}
            >
              {busyDecision === 'decline'
                ? <ActivityIndicator size="small" color={c.textSecondary} />
                : <Text style={[styles.secondaryButtonText, { color: c.textSecondary }]}>Decline</Text>}
            </TouchableOpacity>
          </View>
        )}

        {status === 'awaiting_other' && !isUnavailable && (
          <Text style={[styles.stateText, { color: c.textSecondary }]}>Approved · waiting for the other side</Text>
        )}
        {status === 'connected' && (
          <View style={styles.connectedRow}>
            <Text style={[styles.stateText, { color: c.textSecondary }]}>You’re connected.</Text>
            {liveMatch?.conversationId && (
              <TouchableOpacity accessibilityRole="button" onPress={() => onOpenConversation(liveMatch.conversationId!)}>
                <Text style={[styles.openLink, { color: c.primary }]}>Open conversation</Text>
              </TouchableOpacity>
            )}
          </View>
        )}
        {isUnavailable && (
          <Text style={[styles.unavailable, { color: c.textMuted }]}>This match is no longer available.</Text>
        )}
        {error && <Text accessibilityRole="alert" style={[styles.error, { color: c.danger }]}>{error}</Text>}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  centered: { width: '100%', alignItems: 'center', paddingVertical: 2 },
  shell: { width: '88%', maxWidth: 520, borderWidth: StyleSheet.hairlineWidth, borderRadius: 18, padding: 16 },
  compactShell: { maxWidth: '88%', borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 8 },
  compactText: { fontSize: 13, textAlign: 'center' },
  eyebrow: { fontSize: 10, fontWeight: '700', letterSpacing: 1.5 },
  title: { marginTop: 3, fontSize: 16, fontWeight: '700' },
  anonymousTerms: { marginTop: 14, padding: 12, borderWidth: StyleSheet.hairlineWidth, borderRadius: 12 },
  termBlock: { marginTop: 14 },
  dividedTermBlock: { marginTop: 12, paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth },
  ownTerms: { marginTop: 12, paddingHorizontal: 2 },
  privacyBlock: { marginTop: 14, borderWidth: StyleSheet.hairlineWidth, borderRadius: 11, padding: 11 },
  privacyTitle: { fontSize: 12, fontWeight: '800' },
  privacyText: { marginTop: 3, fontSize: 12, lineHeight: 17 },
  approvalPreview: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 11, padding: 11, marginTop: 9 },
  approvalPreviewTitle: { fontSize: 12, fontWeight: '800' },
  draftActions: { marginTop: 15, flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  keepPrivateButton: { minHeight: 42, paddingHorizontal: 8, alignItems: 'center', justifyContent: 'center' },
  label: { fontSize: 10, fontWeight: '700', letterSpacing: 0.8 },
  ownLabel: { fontSize: 12, fontWeight: '600', marginBottom: 3 },
  terms: { marginTop: 4, fontSize: 14, lineHeight: 20 },
  actions: { marginTop: 16, flexDirection: 'row', gap: 8 },
  primaryButton: { minWidth: 94, minHeight: 42, paddingHorizontal: 16, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  primaryButtonText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  secondaryButton: { minWidth: 94, minHeight: 42, paddingHorizontal: 16, borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  secondaryButtonText: { fontSize: 14, fontWeight: '700' },
  disabled: { opacity: 0.55 },
  stateText: { marginTop: 16, fontSize: 14, fontWeight: '600' },
  connectedRow: { marginTop: 16, gap: 8, alignItems: 'flex-start' },
  openLink: { fontSize: 14, fontWeight: '700' },
  unavailable: { marginTop: 16, fontSize: 14 },
  error: { marginTop: 10, fontSize: 13 },
});
