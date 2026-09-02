import React, { useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { api, type AgentIntentKind, type AgentMatch, type AgentMatchStatus, type Message } from '../api/client';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';

type CardPayload = MatchProposalPayload | MatchStatusPayload | MatchContextPayload;

interface MatchProposalPayload {
  kind: 'match_proposal';
  matchId: string;
  ownIntent: { id: string; kind: AgentIntentKind; terms: string };
  otherTerms: string;
  otherKind: AgentIntentKind;
  status: AgentMatchStatus;
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

function parseCard(message: Message): CardPayload | null {
  if (typeof message.cardPayload !== 'string') return null;

  let payload: unknown;
  try {
    payload = JSON.parse(message.cardPayload);
  } catch {
    return null;
  }
  if (!isRecord(payload)) return null;

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
}

export function AgentNetworkCard({ message, onOpenConversation }: AgentNetworkCardProps) {
  const { scheme } = useTheme();
  const c = getColors(scheme);
  const payload = parseCard(message);
  const [response, setResponse] = useState<AgentMatch | null>(null);
  const [busyDecision, setBusyDecision] = useState<'approve' | 'decline' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const respond = async (proposal: MatchProposalPayload, decision: 'approve' | 'decline') => {
    if (busyDecision) return;
    setBusyDecision(decision);
    setError(null);
    try {
      setResponse(await api.respondToMatch(proposal.matchId, decision));
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
    return (
      <View style={styles.centered}>
        <View style={shellStyle} accessibilityLabel="Your agents matched an ask and an offer">
          <Text style={[styles.title, { color: c.textPrimary }]}>Your agents matched an ask and an offer</Text>
          <View style={styles.termBlock}>
            <Text style={[styles.label, { color: c.textMuted }]}>ASK</Text>
            <Text style={[styles.terms, { color: c.textPrimary }]}>{payload.askTerms}</Text>
          </View>
          <View style={[styles.dividedTermBlock, { borderTopColor: c.border }]}>
            <Text style={[styles.label, { color: c.textMuted }]}>OFFER</Text>
            <Text style={[styles.terms, { color: c.textPrimary }]}>{payload.offerTerms}</Text>
          </View>
        </View>
      </View>
    );
  }

  const status = response?.status ?? payload.status;
  const isUnavailable = status === 'closed' || (!!response?.alreadyResolved && status !== 'connected');

  return (
    <View style={styles.centered}>
      <View style={shellStyle} accessibilityLabel="Anonymous match proposal">
        <Text style={[styles.eyebrow, { color: c.textMuted }]}>QUIET MATCH</Text>
        <Text style={[styles.title, { color: c.textPrimary }]}>A possible match</Text>

        <View style={[styles.anonymousTerms, { backgroundColor: c.surface, borderColor: c.border }]}>
          <Text style={[styles.label, { color: c.textMuted }]}>ANONYMOUS {payload.otherKind.toUpperCase()}</Text>
          <Text style={[styles.terms, { color: c.textPrimary }]}>{payload.otherTerms}</Text>
        </View>

        <View style={styles.ownTerms}>
          <Text style={[styles.ownLabel, { color: c.textSecondary }]}>Your {payload.ownIntent.kind}</Text>
          <Text style={[styles.terms, { color: c.textSecondary }]}>{payload.ownIntent.terms}</Text>
        </View>

        {status === 'pending' && !response?.alreadyResolved && (
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
            {response?.conversationId && (
              <TouchableOpacity accessibilityRole="button" onPress={() => onOpenConversation(response.conversationId!)}>
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
