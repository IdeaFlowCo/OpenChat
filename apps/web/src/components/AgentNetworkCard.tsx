import { useState } from 'react';
import { api, type AgentIntentKind, type AgentMatch, type AgentMatchStatus, type Message } from '../api';
import { useChat } from '../contexts/ChatContext';

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
  const payload = parseCard(message);
  const { matches, updateMatch } = useChat();
  const [response, setResponse] = useState<AgentMatch | null>(null);
  const [busyDecision, setBusyDecision] = useState<'approve' | 'decline' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const respond = async (proposal: MatchProposalPayload, decision: 'approve' | 'decline') => {
    if (busyDecision) return;
    setBusyDecision(decision);
    setError(null);
    try {
      const updated = await api.respondToMatch(proposal.matchId, decision);
      setResponse(updated);
      updateMatch(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update this match.');
    } finally {
      setBusyDecision(null);
    }
  };

  if (!payload) {
    return (
      <div className="flex justify-center" role="status">
        <div className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-2 text-sm text-gray-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400">
          Update from your agent
        </div>
      </div>
    );
  }

  if (payload.kind === 'match_status') {
    return (
      <div className="flex justify-center" role="status">
        <div className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-2 text-sm text-gray-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400">
          Match update · {statusText(payload.status)}
        </div>
      </div>
    );
  }

  if (payload.kind === 'match_context') {
    return (
      <div className="flex justify-center">
        <section aria-label="Match context" className="w-full max-w-lg rounded-2xl border border-gray-200 bg-gray-50 px-5 py-4 text-gray-700 shadow-sm dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Your agents matched an ask and an offer</h3>
          <dl className="mt-3 grid gap-3 text-sm">
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wide text-gray-400 dark:text-slate-500">Ask</dt>
              <dd className="mt-1 whitespace-pre-wrap break-words">{payload.askTerms}</dd>
            </div>
            <div className="border-t border-gray-200 pt-3 dark:border-slate-700">
              <dt className="text-xs font-semibold uppercase tracking-wide text-gray-400 dark:text-slate-500">Offer</dt>
              <dd className="mt-1 whitespace-pre-wrap break-words">{payload.offerTerms}</dd>
            </div>
          </dl>
        </section>
      </div>
    );
  }

  const liveMatch = matches.get(payload.matchId);
  const currentMatch = liveMatch ?? response;
  const status = currentMatch?.status ?? payload.status;
  const isUnavailable = status === 'closed' || (!!response?.alreadyResolved && status !== 'connected');

  return (
    <div className="flex justify-center">
      <section aria-label="Anonymous match proposal" className="w-full max-w-lg rounded-2xl border border-gray-200 bg-gray-50 px-5 py-4 text-gray-700 shadow-sm dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200">
        <div className="text-xs font-semibold uppercase tracking-[0.16em] text-gray-400 dark:text-slate-500">Quiet match</div>
        <h3 className="mt-1 text-base font-semibold text-gray-900 dark:text-white">A possible match</h3>

        <div className="mt-4 rounded-xl border border-gray-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-800">
          <div className="text-xs font-semibold uppercase tracking-wide text-gray-400 dark:text-slate-500">Anonymous {payload.otherKind}</div>
          <p className="mt-1 whitespace-pre-wrap break-words text-sm">{payload.otherTerms}</p>
        </div>

        <div className="mt-3 px-1">
          <div className="text-xs font-semibold text-gray-500 dark:text-slate-400">Your {payload.ownIntent.kind}</div>
          <p className="mt-1 whitespace-pre-wrap break-words text-sm text-gray-600 dark:text-slate-300">{payload.ownIntent.terms}</p>
        </div>

        {status === 'pending' && !response?.alreadyResolved && (
          <div className="mt-4 flex gap-2">
            <button
              type="button"
              onClick={() => void respond(payload, 'approve')}
              disabled={busyDecision !== null}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-50 dark:focus:ring-offset-slate-900"
            >
              {busyDecision === 'approve' ? 'Approving…' : 'Approve'}
            </button>
            <button
              type="button"
              onClick={() => void respond(payload, 'decline')}
              disabled={busyDecision !== null}
              className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-gray-600 hover:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-gray-400 focus:ring-offset-2 disabled:opacity-50 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700 dark:focus:ring-offset-slate-900"
            >
              {busyDecision === 'decline' ? 'Declining…' : 'Decline'}
            </button>
          </div>
        )}

        {status === 'awaiting_other' && !isUnavailable && (
          <p className="mt-4 text-sm font-medium text-gray-500 dark:text-slate-400">Approved · waiting for the other side</p>
        )}
        {status === 'connected' && (
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <span className="text-sm font-medium text-gray-600 dark:text-slate-300">You’re connected.</span>
            {currentMatch?.conversationId && (
              <button type="button" onClick={() => onOpenConversation(currentMatch.conversationId!)} className="text-sm font-semibold text-blue-600 hover:text-blue-700 hover:underline dark:text-blue-400">
                Open conversation
              </button>
            )}
          </div>
        )}
        {isUnavailable && (
          <p className="mt-4 text-sm text-gray-400 dark:text-slate-500">This match is no longer available.</p>
        )}
        {error && <p role="alert" className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}
      </section>
    </div>
  );
}
