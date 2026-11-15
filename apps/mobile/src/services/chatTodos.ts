/**
 * Network half of private chat to-dos (see utils/chatTodos.ts for the model).
 *
 * Everything here goes through the owner-only `/api/private/asks` routes. A
 * to-do is never posted to the conversation: placing an ask in a chat records
 * where it came up and shows it to no one.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type Message, type OverlayAsk, type OverlayAskPlacementInput } from '../api/client';
import { ApiError } from '../api/errors';
import { askConversationIds, isTodoAsk, toChatTodo, todosForConversation, type ChatTodo, TODO_TEXT_MAX } from '../utils/chatTodos';
import { announceTodosChanged, onTodosChanged } from './conversationPanel';

/** One page is the server's maximum. Open asks sort first, so a long history trims done items, not open ones. */
const PAGE = 200;
/** Several to-dos can come from one message; the receipt index tells them apart. */
const MAX_ITEMS_PER_MESSAGE = 8;

export interface ChatTodoList { open: ChatTodo[]; done: ChatTodo[]; truncated: boolean }

export async function listChatTodos(conversationId: string): Promise<ChatTodoList> {
  const page = await api.listAsks({ direction: 'for_me', status: 'all', limit: PAGE });
  return { ...todosForConversation(page.asks, conversationId), truncated: page.truncated };
}

function placementInputs(ask: OverlayAsk, addConversationId: string): OverlayAskPlacementInput[] {
  const kept = ask.placements.flatMap((place): OverlayAskPlacementInput[] => {
    if (place.kind === 'self') return ['self'];
    if (place.kind === 'conversation') return [{ kind: 'conversation', id: place.conversationId }];
    if (place.kind === 'user') return [{ kind: 'user', id: place.id }];
    // Saved people, companies, projects and ideas are all addressed as things; opaque refs cannot be re-sent.
    return place.kind === 'ref' || place.kind === 'ask' ? [] : [{ kind: 'thing', id: place.id }];
  });
  return [...kept, { kind: 'conversation', id: addConversationId }];
}

/** Make sure an existing ask reads as an open to-do in this chat. Leaves an ask that is not the owner's own alone. */
async function adoptAsTodo(ask: OverlayAsk, conversationId: string): Promise<OverlayAsk> {
  if (!ask.fromMe) return ask;
  const patch: Parameters<typeof api.updateAsk>[1] = {};
  if (ask.carrier?.kind !== 'self') patch.carrier = 'self';
  if (ask.status !== 'open') patch.status = 'open';
  // A placement that cannot be re-sent (another app's ref) would be dropped by a replace, so such asks keep their placements.
  const replaceable = ask.placements.every(place => place.kind !== 'ref' && place.kind !== 'ask');
  if (!askConversationIds(ask).includes(conversationId) && replaceable) patch.placements = placementInputs(ask, conversationId);
  return Object.keys(patch).length ? (await api.updateAsk(ask.id, patch)).ask : ask;
}

function conflictAskId(error: unknown): string | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  try { const body = JSON.parse(error.body) as { askId?: unknown }; return typeof body.askId === 'string' ? body.askId : null; } catch { return null; }
}

/**
 * Add a private to-do in a chat, optionally from one of its messages.
 * `created` is false when the same to-do already existed; it is then reopened
 * and placed here rather than duplicated.
 */
export async function addChatTodo(input: { conversationId: string; text: string; message?: Pick<Message, 'id' | 'content' | 'createdAt' | 'conversationId'> | null }): Promise<{ todo: ChatTodo; created: boolean }> {
  const text = input.text.replace(/\s+/g, ' ').trim().slice(0, TODO_TEXT_MAX);
  if (!text) throw new Error('Write what you want to do.');
  const base = { author: 'self' as const, carrier: 'self' as const, text, horizon: 'short' as const, placements: [{ kind: 'conversation' as const, id: input.conversationId }] };
  const message = input.message && !input.message.id.startsWith('local-') ? input.message : null;
  const excerpt = (message?.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 500);

  let saved: { ask: OverlayAsk; created: boolean } | null = null;
  if (message && excerpt) {
    for (let itemIndex = 0; itemIndex < MAX_ITEMS_PER_MESSAGE && !saved; itemIndex++) {
      try {
        saved = await api.saveAsk({ ...base, sourceReceipt: { app: 'openchat', conversationId: input.conversationId, messageId: message.id, sourceMessageId: message.id, itemIndex, excerpt, assertion: 'stated', audienceIntent: null, sourceCreatedAt: message.createdAt || null } });
      } catch (error) {
        // This message already produced an ask at this index. If it is this same to-do, use it; otherwise try the next index.
        const existingId = conflictAskId(error);
        if (!existingId) throw error;
        const existing = await api.getAsk(existingId).then(result => result.ask).catch(() => null);
        if (existing && existing.text.trim().toLowerCase() === text.toLowerCase()) saved = { ask: existing, created: false };
      }
    }
  }
  // No message, an attachment-only message, or every index taken: the to-do still gets saved, without the link back.
  if (!saved) saved = await api.saveAsk(base);

  const ask = saved.created ? saved.ask : await adoptAsTodo(saved.ask, input.conversationId);
  announceTodosChanged(input.conversationId);
  return { todo: toChatTodo(ask), created: saved.created };
}

export async function setChatTodoDone(conversationId: string, id: string, done: boolean): Promise<ChatTodo> {
  const { ask } = await api.updateAsk(id, { status: done ? 'fulfilled' : 'open' });
  announceTodosChanged(conversationId);
  return toChatTodo(ask);
}

export async function renameChatTodo(conversationId: string, id: string, text: string): Promise<ChatTodo> {
  const { ask } = await api.updateAsk(id, { text: text.replace(/\s+/g, ' ').trim().slice(0, TODO_TEXT_MAX) });
  announceTodosChanged(conversationId);
  return toChatTodo(ask);
}

export async function deleteChatTodo(conversationId: string, id: string): Promise<void> {
  await api.deleteAsk(id);
  announceTodosChanged(conversationId);
}

/**
 * This chat's to-dos for the signed-in account. State is per mount and keyed
 * by account, so nothing private outlives a sign-out or an account switch.
 */
export function useChatTodos(accountId: string | undefined, conversationId: string, enabled = true) {
  const [list, setList] = useState<ChatTodoList>({ open: [], done: [], truncated: false });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sequence = useRef(0);

  const reload = useCallback(async () => {
    if (!accountId || !conversationId || !enabled) return;
    const request = ++sequence.current;
    setLoading(true);
    try {
      const next = await listChatTodos(conversationId);
      if (request !== sequence.current) return;
      setList(next);
      setError(null);
    } catch (err) {
      if (request !== sequence.current) return;
      setError(err instanceof Error ? err.message : 'Could not load your to-dos.');
    } finally {
      if (request === sequence.current) setLoading(false);
    }
  }, [accountId, conversationId, enabled]);

  useEffect(() => {
    sequence.current++;
    setList({ open: [], done: [], truncated: false });
    setError(null);
    void reload();
    return () => { sequence.current++; };
  }, [reload]);

  useEffect(() => onTodosChanged(changed => { if (changed === conversationId) void reload(); }), [conversationId, reload]);

  return { ...list, loading, error, reload };
}

export { isTodoAsk };
