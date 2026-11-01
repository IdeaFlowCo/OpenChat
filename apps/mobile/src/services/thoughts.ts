/**
 * Thoughts service — thin wrappers over api.* for use in screens.
 * Kept separate so screens don't have to import from api/client directly
 * and to give a single place to add caching in the future. (OpenChat-zi1)
 */

import {
  decodeVisionSearchResponse,
  VISION_SEARCH_TIMEOUT_MS,
  type VisionChip,
  type VisionSearchResult,
} from '../utils/visionSearch';
import { api, ConversationThoughts, Thought, ThoughtKind, ThoughtStatus } from '../api/client';

export type { ConversationThoughts, Thought, ThoughtKind, ThoughtStatus };

export async function fetchThoughts(opts?: { limit?: number; before?: string; q?: string }): Promise<Thought[]> {
  return api.getThoughts(opts);
}

export async function createThought(params: {
  text: string;
  kind?: ThoughtKind;
  status?: ThoughtStatus;
  sourceMessageId?: string;
  pinToConversationId?: string;
  scopeConversationId?: string;
}): Promise<Thought> {
  return api.createThought(params);
}

/** Chat-scoped thoughts, including the caller's private scoped entries. */
export async function fetchConversationThoughts(
  conversationId: string,
  opts?: { q?: string }
): Promise<ConversationThoughts> {
  return api.getConversationThoughts(conversationId, opts);
}

export async function pinThought(id: string, conversationId: string, expectedText: string): Promise<Thought> {
  return api.pinThought(id, conversationId, expectedText);
}

export async function unpinThought(id: string, conversationId: string): Promise<void> {
  return api.unpinThought(id, conversationId);
}

export async function updateThought(
  id: string,
  fields: { text?: string; kind?: ThoughtKind; status?: ThoughtStatus }
): Promise<Thought> {
  return api.updateThought(id, fields);
}

export async function deleteThought(id: string): Promise<void> {
  return api.deleteThought(id);
}

/**
 * Search Vision notes. Never throws for Vision problems: a timeout (client
 * backstop of 3 s) or any network/server error resolves to an `unavailable`
 * result so the caller can fall back to local search. Resolves `null` only when
 * the caller aborted `signal` (stale request).
 */
export async function searchVision(
  params: { q: string; chip: VisionChip; cursor?: string },
  signal?: AbortSignal,
  timeoutMs: number = VISION_SEARCH_TIMEOUT_MS
): Promise<VisionSearchResult | null> {
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort();
  if (signal?.aborted) return null;
  signal?.addEventListener('abort', onAbort);
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    return decodeVisionSearchResponse(await api.visionSearchThoughts(params, controller.signal));
  } catch (e) {
    if (signal?.aborted) return null;
    if (timedOut) return { status: 'unavailable', code: 'timeout', reason: 'Vision search timed out' };
    return { status: 'unavailable', code: 'source_unavailable', reason: e instanceof Error ? e.message : 'Vision search failed' };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}
