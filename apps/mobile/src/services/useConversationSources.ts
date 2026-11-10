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

export interface ConversationSourcesState { sources: ConversationSource[]; resourcesEnabled: boolean; mirrored: MirroredEntry[]; loaded: boolean }
const EMPTY: ConversationSourcesState = { sources: [], resourcesEnabled: false, mirrored: [], loaded: false };
const cache = new Map<string, ConversationSourcesState>();
const modes = new Map<string, SourceMode>();
const PAGE = 200;
/** Newest 1,000 mirrored messages per source; older history stays in the owner's Imported chats. */
const MAX_PAGES = 5;
const REFRESH_MS = 60_000;

export function clearConversationSourcesCache(): void { cache.clear(); modes.clear(); }

async function loadSources(conversationId: string, userId: string): Promise<ConversationSourcesState> {
  const { sources, resourcesEnabled } = await api.listConversationSources(conversationId);
  const mirrored: MirroredEntry[] = [];
  for (const source of sources) {
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = await api.listSourceMessages(conversationId, source.id, cursor, PAGE);
      mirrored.push(...mirroredEntries(source, result.messages, userId));
      cursor = result.nextCursor;
      if (!cursor) break;
    }
  }
  return { sources, resourcesEnabled, mirrored, loaded: true };
}

export function useConversationSources(conversationId: string | undefined, userId: string | undefined) {
  const cacheKey = conversationId && userId ? `${userId}:${conversationId}` : null;
  const [state, setState] = useState<ConversationSourcesState>(() => (cacheKey && cache.get(cacheKey)) || EMPTY);
  const [mode, setModeState] = useState<SourceMode>(() => (cacheKey && modes.get(cacheKey)) || 'unified');
  const current = useRef(cacheKey);
  current.current = cacheKey;

  const refresh = useCallback(async () => {
    if (!cacheKey || !conversationId || !userId) return;
    try {
      const next = await loadSources(conversationId, userId);
      cache.set(cacheKey, next);
      if (current.current === cacheKey) setState(next);
    } catch {
      // Leave what is shown; a conversation without sources must never look broken because this failed.
      if (current.current === cacheKey && !cache.has(cacheKey)) setState({ ...EMPTY, loaded: true });
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

  const setMode = useCallback((next: SourceMode) => { if (cacheKey) modes.set(cacheKey, next); setModeState(next); }, [cacheKey]);
  return { ...state, mode: hasSources ? mode : 'openchat' as SourceMode, setMode, refresh };
}
