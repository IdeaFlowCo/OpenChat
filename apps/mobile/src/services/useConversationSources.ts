/**
 * The chats shared into a conversation, loaded beside it (OpenChat-c8to.4).
 *
 * Additive by design: most conversations have none, and any failure here
 * leaves the chat exactly as it was. Results are kept per account and
 * conversation for the session so reopening a chat does not flicker.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { api, type ConversationSource } from '../api/client';
import { mirroredEntries, type MirroredEntry, type SourceMode } from '../utils/unifiedTimeline';

export interface ConversationSourcesState { sources: ConversationSource[]; resourcesEnabled: boolean; mirrored: MirroredEntry[]; cursors: Record<string, string | null>; loaded: boolean }
const EMPTY: ConversationSourcesState = { sources: [], resourcesEnabled: false, mirrored: [], cursors: {}, loaded: false };
const cache = new Map<string, ConversationSourcesState>();
const modes = new Map<string, SourceMode>();
const PAGE = 200;
/** Automatically load the newest five pages per source. */
const MAX_PAGES = 5;
const REFRESH_MS = 60_000;

export function clearConversationSourcesCache(): void { cache.clear(); modes.clear(); }

async function loadSources(conversationId: string, userId: string): Promise<ConversationSourcesState> {
  const { sources, resourcesEnabled } = await api.listConversationSources(conversationId);
  const mirrored: MirroredEntry[] = [];
  const cursors: Record<string, string | null> = {};
  for (const source of sources) {
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = await api.listSourceMessages(conversationId, source.id, cursor, PAGE);
      mirrored.push(...mirroredEntries(source, result.messages, userId));
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    cursors[source.id] = cursor;
  }
  return { sources, resourcesEnabled, mirrored, cursors, loaded: true };
}

export function useConversationSources(conversationId: string | undefined, userId: string | undefined) {
  const cacheKey = conversationId && userId ? `${userId}:${conversationId}` : null;
  const [state, setState] = useState<ConversationSourcesState>(() => (cacheKey && cache.get(cacheKey)) || EMPTY);
  const [mode, setModeState] = useState<SourceMode>(() => (cacheKey && modes.get(cacheKey)) || 'unified');
  const generation = useRef(0);
  const current = useRef(cacheKey);
  current.current = cacheKey;

  const refresh = useCallback(async () => {
    if (!cacheKey || !conversationId || !userId) return;
    const run = ++generation.current;
    try {
      const next = await loadSources(conversationId, userId);
      if (run !== generation.current || current.current !== cacheKey) return;
      const previous = cache.get(cacheKey);
      if (previous) {
        const unchanged = new Set(next.sources.filter(source => {
          const old = previous.sources.find(item => item.id === source.id);
          return old && old.coverage.asOf === source.coverage.asOf && old.coverage.latestMessageAt === source.coverage.latestMessageAt && old.messageCount === source.messageCount;
        }).map(source => source.id));
        const seen = new Set(next.mirrored.map(entry => entry.key));
        const older = previous.mirrored.filter(entry => unchanged.has(entry.sourceId) && !seen.has(entry.key));
        next.mirrored.push(...older);
        for (const source of next.sources) if (older.some(entry => entry.sourceId === source.id)) next.cursors[source.id] = previous.cursors[source.id]!;
      }
      cache.set(cacheKey, next);
      if (current.current === cacheKey) setState(next);
    } catch (error) {
      if ((error as { status?: unknown })?.status === 404) {
        generation.current += 1; cache.delete(cacheKey); modes.delete(cacheKey);
        if (current.current === cacheKey) { setState({ ...EMPTY, loaded: true }); setModeState('unified'); }
      } else if (run === generation.current && current.current === cacheKey && !cache.has(cacheKey)) setState({ ...EMPTY, loaded: true });
    }
  }, [cacheKey, conversationId, userId]);

  useEffect(() => {
    setState((cacheKey && cache.get(cacheKey)) || EMPTY);
    setModeState((cacheKey && modes.get(cacheKey)) || 'unified');
    void refresh();
  }, [cacheKey, refresh]);

  // Keep a mirror current while its chat is open; conversations without one do no further work.
  const hasSources = state.sources.length > 0;
  useEffect(() => {
    if (!hasSources) return;
    const tick = () => { if (AppState.currentState === 'active') void refresh(); };
    const timer = setInterval(tick, REFRESH_MS);
    const subscription = AppState.addEventListener('change', status => { if (status === 'active') void refresh(); });
    return () => { clearInterval(timer); subscription.remove(); };
  }, [hasSources, refresh]);

  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const busy = useRef(false);
  const loadEarlier = useCallback(async () => {
    if (!cacheKey || !conversationId || !userId || busy.current) return;
    const currentState = cache.get(cacheKey);
    if (!currentState) return;
    const run = generation.current;
    busy.current = true; setLoadingEarlier(true);
    try {
      const pages = await Promise.all(currentState.sources.filter(source => currentState.cursors[source.id]).map(async source => ({ source, page: await api.listSourceMessages(conversationId, source.id, currentState.cursors[source.id], PAGE) })));
      if (run !== generation.current || current.current !== cacheKey) return;
      const latest = cache.get(cacheKey);
      if (!latest) return;
      const seen = new Set(latest.mirrored.map(entry => entry.key));
      const additions = pages.flatMap(({ source, page }) => mirroredEntries(source, page.messages, userId)).filter(entry => !seen.has(entry.key));
      const cursors = { ...latest.cursors };
      for (const { source, page } of pages) cursors[source.id] = page.nextCursor;
      const next = { ...latest, mirrored: [...latest.mirrored, ...additions], cursors };
      cache.set(cacheKey, next);
      if (current.current === cacheKey) setState(next);
    } catch (error) {
      if ((error as { status?: unknown })?.status === 404) {
        generation.current += 1; cache.delete(cacheKey); modes.delete(cacheKey);
        if (current.current === cacheKey) { setState({ ...EMPTY, loaded: true }); setModeState('unified'); }
      }
    }
    finally { busy.current = false; if (current.current === cacheKey) setLoadingEarlier(false); }
  }, [cacheKey, conversationId, userId]);

  const setMode = useCallback((next: SourceMode) => { if (cacheKey) modes.set(cacheKey, next); setModeState(next); }, [cacheKey]);
  return { ...state, mode: hasSources ? mode : 'openchat' as SourceMode, setMode, refresh, hasMore: Object.values(state.cursors).some(Boolean), loadEarlier, loadingEarlier };
}
