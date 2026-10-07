import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type ConversationContentItem, type ConversationContentFilter } from '../api/client';
/** Mount per account/conversation. Private rows never enter shared Context caches. */
export function useConversationContent(accountId: string, conversationId: string) {
  const [items, setItems] = useState<ConversationContentItem[]>([]);
  const [filter, setFilter] = useState<ConversationContentFilter>('all');
  const [search, setSearch] = useState('');
  const [contextAvailable, setContextAvailable] = useState<boolean>();
  const [cursor, setCursor] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const alive = useRef(true), sequence = useRef(0), pending = useRef(false);
  const state = useRef({ cursor, filter, search }); state.current = { cursor, filter, search };
  useEffect(() => { alive.current = true; return () => { alive.current = false; sequence.current++; }; }, [accountId, conversationId]);
  const load = useCallback(async (more = false) => {
    if (!alive.current) return;
    const query = state.current;
    if (more && (pending.current || !query.cursor)) return;
    const revision = ++sequence.current; pending.current = true; setLoading(true); setError('');
    try {
      const page = await api.getConversationContent(conversationId, { filter: query.filter, search: query.search.trim(), ...(more ? { cursor: query.cursor } : {}) });
      if (!alive.current || revision !== sequence.current) return;
      setItems(previous => more ? [...new Map([...previous, ...page.items].map(item => [item.id, item])).values()] : page.items);
      setCursor(page.nextCursor);
      setContextAvailable(page.contextAvailable !== false);
    } catch (e) {
      if (!alive.current || revision !== sequence.current) return;
      if ([401, 403, 404].includes((e as { status?: number }).status || 0)) { setItems([]); setCursor(undefined); }
      setError(e instanceof Error ? e.message : 'Could not refresh conversation content.');
    } finally { if (alive.current && revision === sequence.current) { pending.current = false; setLoading(false); } }
  }, [accountId, conversationId]);
  const chooseFilter = (value: ConversationContentFilter) => { if (value === state.current.filter) return; sequence.current++; setItems([]); setCursor(undefined); setFilter(value); };
  const chooseSearch = (value: string) => { if (value === state.current.search) return; sequence.current++; setItems([]); setCursor(undefined); setSearch(value); };
  useEffect(() => { const timer = setTimeout(() => void load(), search ? 250 : 0); return () => clearTimeout(timer); }, [filter, search, load]);
  return { items, contextAvailable, filter, search, loading, error, hasMore: !!cursor, load, chooseFilter, chooseSearch };
}
