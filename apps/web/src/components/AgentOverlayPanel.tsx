import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type AgentIntent, type AgentIntentKind, type AgentMatch, type AgentMatchStatus } from '../api';
import { useChat } from '../contexts/ChatContext';
import { AppIcon } from './AppIcon';

interface AgentOverlayPanelProps {
  open: boolean;
  onClose: () => void;
}

type PublishDraft = {
  kind: AgentIntentKind;
  terms: string;
  details?: string;
};

const matchOrder: Record<AgentMatchStatus, number> = {
  pending: 0,
  awaiting_other: 1,
  connected: 2,
  closed: 3,
};

function statusLabel(status: AgentMatchStatus): string {
  switch (status) {
    case 'pending': return 'Needs your response';
    case 'awaiting_other': return 'Approved · waiting for the other side';
    case 'connected': return 'Connected';
    case 'closed': return 'Closed';
  }
}

function intentStatusLabel(status: AgentIntent['status']): string {
  switch (status) {
    case 'active': return 'Active';
    case 'withdrawn': return 'Withdrawn';
    case 'connected': return 'Connected';
  }
}

export function AgentOverlayPanel({ open, onClose }: AgentOverlayPanelProps) {
  const {
    matches,
    refreshMatches,
    updateMatch,
    loadConversations,
    setActiveConversation,
  } = useChat();
  const [intents, setIntents] = useState<AgentIntent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyMatch, setBusyMatch] = useState<{ id: string; decision: 'approve' | 'decline' } | null>(null);
  const [withdrawingId, setWithdrawingId] = useState<string | null>(null);
  const [openingConversation, setOpeningConversation] = useState<string | null>(null);
  const [kind, setKind] = useState<AgentIntentKind>('ask');
  const [terms, setTerms] = useState('');
  const [details, setDetails] = useState('');
  const [publishDraft, setPublishDraft] = useState<PublishDraft | null>(null);
  const [publishing, setPublishing] = useState(false);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  const visibleMatches = useMemo(() => (
    Array.from(matches.values())
      .filter(match => match.status !== 'closed')
      .sort((a, b) => matchOrder[a.status] - matchOrder[b.status] || b.updatedAt.localeCompare(a.updatedAt))
  ), [matches]);

  const sortedIntents = useMemo(() => (
    [...intents].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  ), [intents]);

  useEffect(() => {
    if (!open) {
      setPublishDraft(null);
      setError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([refreshMatches(), api.listIntents()])
      .then(([, latestIntents]) => {
        if (!cancelled) setIntents(latestIntents);
      })
      .catch(err => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load your agent network.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    requestAnimationFrame(() => closeButtonRef.current?.focus());
    return () => { cancelled = true; };
  }, [open, refreshMatches]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  const respond = async (match: AgentMatch, decision: 'approve' | 'decline') => {
    if (busyMatch) return;
    setBusyMatch({ id: match.id, decision });
    setError(null);
    try {
      updateMatch(await api.respondToMatch(match.id, decision));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update this match.');
    } finally {
      setBusyMatch(null);
    }
  };

  const withdraw = async (intent: AgentIntent) => {
    if (!window.confirm(`Withdraw this ${intent.kind}? It will stop being discoverable.`)) return;
    setWithdrawingId(intent.id);
    setError(null);
    try {
      const { intent: updated } = await api.withdrawIntent(intent.id);
      setIntents(current => current.map(item => item.id === updated.id ? updated : item));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not withdraw this intent.');
    } finally {
      setWithdrawingId(null);
    }
  };

  const reviewPublish = () => {
    const exactTerms = terms.trim();
    if (!exactTerms) {
      setError('Anonymous terms are required.');
      return;
    }
    const privateDetails = details.trim();
    setTerms(exactTerms);
    setPublishDraft({ kind, terms: exactTerms, details: privateDetails || undefined });
    setError(null);
  };

  const publish = async () => {
    if (!publishDraft || publishing) return;
    setPublishing(true);
    setError(null);
    try {
      const { intent } = await api.publishIntent(publishDraft);
      setIntents(current => [intent, ...current.filter(item => item.id !== intent.id)]);
      setTerms('');
      setDetails('');
      setPublishDraft(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not publish this intent.');
    } finally {
      setPublishing(false);
    }
  };

  const openConversation = async (conversationId: string) => {
    if (openingConversation) return;
    setOpeningConversation(conversationId);
    setError(null);
    try {
      await loadConversations();
      setActiveConversation(conversationId);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open this conversation.');
    } finally {
      setOpeningConversation(null);
    }
  };

  const openAssistant = async () => {
    if (openingConversation) return;
    setOpeningConversation('assistant');
    setError(null);
    try {
      const conversation = await api.ensureAssistant();
      await loadConversations();
      setActiveConversation(conversation.id);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open your agent conversation.');
    } finally {
      setOpeningConversation(null);
    }
  };

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="agent-overlay-title"
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 md:items-center md:p-4"
      onClick={event => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[94vh] w-full flex-col overflow-hidden rounded-t-2xl bg-white shadow-xl dark:bg-slate-900 md:max-h-[90vh] md:max-w-2xl md:rounded-2xl">
        <header className="flex items-center justify-between gap-3 border-b border-gray-200 px-4 py-3 dark:border-slate-800">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-blue-50 text-blue-600 dark:bg-blue-950/60 dark:text-blue-300">
              <AppIcon name="agent" size={20} />
            </span>
            <div className="min-w-0">
              <h2 id="agent-overlay-title" className="truncate text-base font-semibold text-gray-900 dark:text-slate-100">Agent network</h2>
              <p className="truncate text-xs text-gray-500 dark:text-slate-400">Anonymous asks, offers, and quiet matches</p>
            </div>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            aria-label="Close agent network"
            className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full text-gray-500 hover:bg-gray-100 hover:text-gray-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
              <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
            </svg>
          </button>
        </header>

        <div className="flex-1 space-y-7 overflow-y-auto bg-gray-50 p-4 dark:bg-slate-950 md:p-5">
          {loading && (
            <p role="status" className="py-8 text-center text-sm text-gray-500 dark:text-slate-400">Loading your agent network…</p>
          )}

          {!loading && (
            <>
              <section aria-labelledby="agent-matches-heading">
                <div className="flex items-center justify-between gap-3">
                  <h3 id="agent-matches-heading" className="text-xs font-bold uppercase tracking-wide text-gray-500 dark:text-slate-400">Pending matches</h3>
                  {visibleMatches.some(match => match.status === 'pending') && (
                    <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs font-semibold text-blue-700 dark:bg-blue-900/50 dark:text-blue-300">
                      {visibleMatches.filter(match => match.status === 'pending').length} pending
                    </span>
                  )}
                </div>
                <div className="mt-2 space-y-3">
                  {visibleMatches.map(match => (
                    <article key={match.id} className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-900">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-xs font-semibold uppercase tracking-wide text-gray-400 dark:text-slate-500">Anonymous {match.otherKind}</span>
                        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${match.status === 'pending' ? 'bg-blue-50 text-blue-700 dark:bg-blue-950/70 dark:text-blue-300' : 'bg-gray-100 text-gray-600 dark:bg-slate-800 dark:text-slate-300'}`}>
                          {statusLabel(match.status)}
                        </span>
                      </div>
                      <p className="mt-2 whitespace-pre-wrap break-words text-sm text-gray-800 dark:text-slate-200">{match.otherTerms}</p>
                      <div className="mt-3 border-t border-gray-100 pt-3 dark:border-slate-800">
                        <p className="text-xs font-semibold text-gray-500 dark:text-slate-400">Your {match.ownIntent.kind}</p>
                        <p className="mt-1 whitespace-pre-wrap break-words text-sm text-gray-600 dark:text-slate-300">{match.ownIntent.terms}</p>
                      </div>
                      {match.status === 'pending' && (
                        <div className="mt-4 flex gap-2">
                          <button
                            type="button"
                            onClick={() => void respond(match, 'approve')}
                            disabled={busyMatch !== null}
                            className="min-h-[40px] rounded-lg bg-blue-600 px-4 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
                          >
                            {busyMatch?.id === match.id && busyMatch.decision === 'approve' ? 'Approving…' : 'Approve'}
                          </button>
                          <button
                            type="button"
                            onClick={() => void respond(match, 'decline')}
                            disabled={busyMatch !== null}
                            className="min-h-[40px] rounded-lg border border-gray-300 bg-white px-4 text-sm font-semibold text-gray-700 hover:bg-gray-100 disabled:opacity-50 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800"
                          >
                            {busyMatch?.id === match.id && busyMatch.decision === 'decline' ? 'Declining…' : 'Decline'}
                          </button>
                        </div>
                      )}
                      {match.status === 'awaiting_other' && (
                        <p className="mt-4 text-sm text-gray-500 dark:text-slate-400">You approved this match. Waiting for the other side.</p>
                      )}
                      {match.status === 'connected' && match.conversationId && (
                        <button
                          type="button"
                          onClick={() => void openConversation(match.conversationId!)}
                          disabled={openingConversation !== null}
                          className="mt-4 min-h-[40px] rounded-lg bg-blue-600 px-4 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
                        >
                          {openingConversation === match.conversationId ? 'Opening…' : 'Open conversation'}
                        </button>
                      )}
                    </article>
                  ))}
                  {visibleMatches.length === 0 && (
                    <div className="rounded-xl border border-dashed border-gray-300 bg-white px-4 py-6 text-center text-sm text-gray-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400">
                      No matches waiting right now.
                    </div>
                  )}
                </div>
              </section>

              <section aria-labelledby="agent-intents-heading">
                <h3 id="agent-intents-heading" className="text-xs font-bold uppercase tracking-wide text-gray-500 dark:text-slate-400">Your asks &amp; offers</h3>
                <div className="mt-2 overflow-hidden rounded-xl border border-gray-200 bg-white dark:border-slate-700 dark:bg-slate-900">
                  {sortedIntents.map((intent, index) => (
                    <article key={intent.id} className={`${index > 0 ? 'border-t border-gray-100 dark:border-slate-800' : ''} p-4`}>
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-xs font-bold uppercase tracking-wide text-blue-600 dark:text-blue-400">{intent.kind}</span>
                        <span className="text-xs font-medium text-gray-500 dark:text-slate-400">{intentStatusLabel(intent.status)}</span>
                      </div>
                      <p className="mt-1 whitespace-pre-wrap break-words text-sm text-gray-800 dark:text-slate-200">{intent.terms}</p>
                      {intent.status === 'active' && (
                        <button
                          type="button"
                          onClick={() => void withdraw(intent)}
                          disabled={withdrawingId !== null}
                          className="mt-2 text-xs font-semibold text-red-600 hover:underline disabled:opacity-50 dark:text-red-400"
                        >
                          {withdrawingId === intent.id ? 'Withdrawing…' : 'Withdraw'}
                        </button>
                      )}
                    </article>
                  ))}
                  {sortedIntents.length === 0 && (
                    <p className="px-4 py-6 text-center text-sm text-gray-500 dark:text-slate-400">You haven’t published an ask or offer yet.</p>
                  )}
                </div>
              </section>

              <section aria-labelledby="agent-new-intent-heading" className="rounded-xl border border-gray-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
                <h3 id="agent-new-intent-heading" className="font-semibold text-gray-900 dark:text-slate-100">New ask or offer</h3>
                {!publishDraft ? (
                  <form className="mt-4 space-y-4" onSubmit={event => { event.preventDefault(); reviewPublish(); }}>
                    <div>
                      <span className="text-sm font-medium text-gray-700 dark:text-slate-300">Kind</span>
                      <div className="mt-1 grid grid-cols-2 gap-2" role="radiogroup" aria-label="Intent kind">
                        {(['ask', 'offer'] as AgentIntentKind[]).map(option => (
                          <button
                            key={option}
                            type="button"
                            role="radio"
                            aria-checked={kind === option}
                            onClick={() => setKind(option)}
                            className={`min-h-[40px] rounded-lg border text-sm font-semibold capitalize ${kind === option ? 'border-blue-600 bg-blue-50 text-blue-700 dark:border-blue-400 dark:bg-blue-950/50 dark:text-blue-300' : 'border-gray-300 text-gray-600 hover:bg-gray-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800'}`}
                          >
                            {option}
                          </button>
                        ))}
                      </div>
                    </div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-slate-300">
                      Anonymous terms
                      <textarea
                        value={terms}
                        onChange={event => setTerms(event.target.value)}
                        maxLength={500}
                        rows={3}
                        required
                        placeholder={kind === 'ask' ? 'What are you looking for?' : 'What can you offer?'}
                        className="mt-1 w-full resize-none rounded-lg border border-gray-300 bg-white px-3 py-2 text-base font-normal text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 dark:placeholder:text-slate-500"
                      />
                      <span className="mt-1 block text-right text-xs font-normal text-gray-400 dark:text-slate-500">{terms.length}/500</span>
                    </label>
                    <label className="block text-sm font-medium text-gray-700 dark:text-slate-300">
                      Private details <span className="font-normal text-gray-400 dark:text-slate-500">(optional)</span>
                      <textarea
                        value={details}
                        onChange={event => setDetails(event.target.value)}
                        maxLength={2000}
                        rows={4}
                        placeholder="Context your agent can use"
                        className="mt-1 w-full resize-none rounded-lg border border-gray-300 bg-white px-3 py-2 text-base font-normal text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 dark:placeholder:text-slate-500"
                      />
                      <span className="mt-1 flex items-center justify-between gap-3 text-xs font-normal text-gray-500 dark:text-slate-400">
                        <span>Only you and your agent see this</span>
                        <span>{details.length}/2000</span>
                      </span>
                    </label>
                    <button
                      type="submit"
                      disabled={!terms.trim()}
                      className="min-h-[44px] w-full rounded-lg bg-blue-600 px-4 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
                    >
                      Review before publishing
                    </button>
                  </form>
                ) : (
                  <div className="mt-4">
                    <p className="text-sm font-semibold text-gray-900 dark:text-slate-100">Confirm anonymous {publishDraft.kind}</p>
                    <div className="mt-3 rounded-lg border border-blue-200 bg-blue-50 p-3 dark:border-blue-900 dark:bg-blue-950/40">
                      <p className="whitespace-pre-wrap break-words text-sm text-gray-900 dark:text-slate-100">{publishDraft.terms}</p>
                    </div>
                    <p className="mt-3 text-sm font-medium text-gray-700 dark:text-slate-300">This exact text becomes anonymously discoverable to other people&apos;s agents.</p>
                    <div className="mt-4 flex gap-2">
                      <button
                        type="button"
                        onClick={() => void publish()}
                        disabled={publishing}
                        className="min-h-[44px] flex-1 rounded-lg bg-blue-600 px-4 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
                      >
                        {publishing ? 'Publishing…' : 'Publish'}
                      </button>
                      <button
                        type="button"
                        onClick={() => setPublishDraft(null)}
                        disabled={publishing}
                        className="min-h-[44px] flex-1 rounded-lg border border-gray-300 px-4 text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                      >
                        Edit
                      </button>
                    </div>
                  </div>
                )}
              </section>
            </>
          )}

          {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        </div>

        <footer className="border-t border-gray-200 bg-white px-4 pb-safe pt-3 dark:border-slate-800 dark:bg-slate-900">
          <button
            type="button"
            onClick={() => void openAssistant()}
            disabled={openingConversation !== null}
            className="flex min-h-[44px] w-full items-center justify-center gap-2 rounded-lg text-sm font-semibold text-blue-600 hover:bg-blue-50 disabled:opacity-50 dark:text-blue-400 dark:hover:bg-slate-800"
          >
            <AppIcon name="agent" size={18} />
            {openingConversation === 'assistant' ? 'Opening…' : 'Chat with your agent'}
          </button>
        </footer>
      </div>
    </div>
  );
}
