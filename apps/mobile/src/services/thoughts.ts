/**
 * Thoughts service — thin wrappers over api.* for use in screens.
 * Kept separate so screens don't have to import from api/client directly
 * and to give a single place to add caching in the future. (OpenChat-zi1)
 */

import { api, Thought, ThoughtKind, ThoughtStatus } from '../api/client';

export type { Thought, ThoughtKind, ThoughtStatus };

export async function fetchThoughts(opts?: { limit?: number; before?: string; q?: string }): Promise<Thought[]> {
  return api.getThoughts(opts);
}

export async function createThought(params: {
  text: string;
  kind?: ThoughtKind;
  status?: ThoughtStatus;
}): Promise<Thought> {
  return api.createThought(params);
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
