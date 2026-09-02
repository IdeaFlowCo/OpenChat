/**
 * Thoughts service — thin wrappers over api.* for use in screens.
 * Kept separate so screens don't have to import from api/client directly
 * and to give a single place to add caching in the future. (OpenChat-zi1)
 */

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
}): Promise<Thought> {
  return api.createThought(params);
}

/** Chat-scoped thoughts: pinned + captured-from-this-chat. */
export async function fetchConversationThoughts(conversationId: string): Promise<ConversationThoughts> {
  return api.getConversationThoughts(conversationId);
}

export async function pinThought(id: string, conversationId: string): Promise<Thought> {
  return api.pinThought(id, conversationId);
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
