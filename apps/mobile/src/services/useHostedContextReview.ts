import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import type { HostedContextPreferences, HostedContextRequest } from '../types/contextHosted';
import type { DraftAction, DraftActionInput } from '../components/ContextDraftCard';

/** Mount once per account. Drafts stay in memory and never enter chat/persistent caches. */
export function useHostedContextReview(accountId: string) {
  const [preferences, setPreferences] = useState<HostedContextPreferences | null>(null);
  const [requests, setRequests] = useState<HostedContextRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [blocked, setBlocked] = useState<Record<string, boolean>>({});
  const [message, setMessage] = useState('');
  const alive = useRef(true);
  const operation = useRef(false);
  const sequence = useRef(0);
  const requestsRef = useRef(requests);
  requestsRef.current = requests;
  const account = useRef(accountId);
  account.current = accountId;
  useEffect(() => { alive.current = true; return () => { alive.current = false; sequence.current++; }; }, []);
  const current = useCallback(() => alive.current && account.current === accountId, [accountId]);
  const load = useCallback(async () => {
    if (operation.current) return;
    const revision = ++sequence.current;
    setError(''); setLoading(true);
    try {
      const [prefs, inbox] = await Promise.all([api.getHostedContextPreferences(), api.getHostedContextRequests()]);
      if (!current() || revision !== sequence.current) return;
      setPreferences(prefs); setRequests(inbox.requests);
    } catch (e) {
      if (!current() || revision !== sequence.current) return;
      // Never leave approval actions live when current access cannot be checked.
      setBlocked(previous => Object.fromEntries([...Object.keys(previous), ...requestsRef.current.map(r => r.id)].map(id => [id, true])));
      if ([401, 403].includes((e as { status?: number }).status || 0)) { setRequests([]); setPreferences(null); }
      setError(e instanceof Error ? e.message : 'Could not load your private drafts.');
    } finally { if (current() && revision === sequence.current) setLoading(false); }
  }, [current]);
  const toggle = async () => {
    if (operation.current || !preferences) return;
    operation.current = true; ++sequence.current; setBusy('preferences'); setError(''); setMessage('');
    try {
      const prefs = await api.setHostedContextPreferences(!preferences.enabled);
      if (!current()) return;
      setPreferences(prefs);
      if (!prefs.enabled) { setRequests([]); setErrors({}); setBlocked({}); setMessage('Hosted agent turned off. Pending requests and unpublished drafts were cancelled.'); }
      else setMessage('Hosted agent enabled. Ask agents on a Context post to request a private draft.');
    } catch (e) { if (current()) setError(e instanceof Error ? e.message : 'Could not change hosted agent preference.'); }
    finally { operation.current = false; if (current()) { setBusy(null); setLoading(false); } }
  };
  const act = async (request: HostedContextRequest, action: DraftAction, input?: DraftActionInput): Promise<boolean> => {
    if (operation.current || !current()) return false;
    if (action === 'publish' && (blocked[request.id] || !preferences?.enabled || request.status !== 'review' || !request.draft)) return false;
    operation.current = true; ++sequence.current; setBusy(request.id); setMessage('');
    setErrors(previous => ({ ...previous, [request.id]: '' }));
    try {
      let updated: HostedContextRequest;
      switch (action) {
        case 'publish': updated = await api.publishHostedContextRequest(request.id, { draftId: request.draft!.id, approvalDigest: request.draft!.approvalDigest, text: request.draft!.text }); break;
        case 'revise': updated = await api.reviseHostedContextRequest(request.id, input || {}); break;
        case 'decline': updated = await api.declineHostedContextRequest(request.id); break;
        case 'cancel': updated = await api.cancelHostedContextRequest(request.id); break;
        case 'reload': updated = await api.getHostedContextRequest(request.id); break;
      }
      if (!current()) return false;
      setRequests(previous => previous.map(item => item.id === request.id ? updated : item));
      setBlocked(previous => ({ ...previous, [request.id]: false }));
      if (action === 'publish') setMessage('Published the reviewed reply to Context. No chat message or notification was sent.');
      if (action === 'decline') setMessage('Draft declined. Nothing was shared.');
      if (action === 'cancel') setMessage('Request cancelled. Nothing was shared.');
      return true;
    } catch (e) {
      if (!current()) return false;
      const status = (e as { status?: number }).status;
      if (status === 401 || status === 403 || status === 404 || status === 409 || status === 410) setBlocked(previous => ({ ...previous, [request.id]: true }));
      if (status === 401 || status === 403 || status === 404 || status === 410) setRequests(previous => previous.map(item => item.id === request.id ? { ...item, status: 'unavailable', draft: undefined, privateText: undefined, privateInputIncluded: false, source: { text: '', author: { id: '', name: 'Unavailable' } }, audience: [] } : item));
      setErrors(previous => ({ ...previous, [request.id]: e instanceof Error ? e.message : 'Could not update this draft. Retry when ready.' }));
      return false;
    } finally { operation.current = false; if (current()) { setBusy(null); setLoading(false); } }
  };
  return { preferences, requests, loading, busy, error, errors, blocked, message, load, toggle, act };
}
