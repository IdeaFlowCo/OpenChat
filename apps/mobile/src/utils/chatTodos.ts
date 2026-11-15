/**
 * Private to-dos kept beside a chat.
 *
 * A to-do is not a new kind of record. It is one of the owner's asks in the
 * Noos people overlay where the owner both cares (`author` is self) and acts
 * (`carrier` is self), placed in the conversation it came up in. That keeps
 * to-dos in the same store as every other ask, visible on the Asks tab and
 * to the owner's agents, and visible to nobody else: asks are owner-only and
 * a placement grants no access.
 *
 * This module is the pure half (no network, no React Native) so the rules
 * that keep a to-do out of the conversation can be tested directly.
 */
import type { OverlayAsk } from '../api/client';

export const TODO_TITLE_MAX = 140;
/** Asks cap their text at 1000 characters. */
export const TODO_TEXT_MAX = 1000;

export interface ChatTodo {
  id: string;
  text: string;
  done: boolean;
  createdAt: string;
  closedAt: string | null;
  needsRecheck: boolean;
  /** Messages in OpenChat this to-do was made from, newest last. */
  sources: { conversationId: string; messageId: string; excerpt: string }[];
  conversationIds: string[];
}

/** The owner cares and the owner acts: that is a to-do. */
export function isTodoAsk(ask: Pick<OverlayAsk, 'fromMe' | 'carrier' | 'exposure' | 'publication'>): boolean {
  return ask.fromMe && ask.carrier?.kind === 'self' && ask.exposure === 'only_me' && !ask.publication;
}

export function askConversationIds(ask: Pick<OverlayAsk, 'placements'>): string[] {
  return ask.placements.flatMap(place => place.kind === 'conversation' ? [place.conversationId] : []);
}

export function toChatTodo(ask: OverlayAsk): ChatTodo {
  return {
    id: ask.id,
    text: ask.text,
    done: ask.status === 'fulfilled' || ask.status === 'withdrawn',
    createdAt: ask.createdAt,
    closedAt: ask.closedAt,
    needsRecheck: ask.needsRecheck,
    sources: (ask.sources ?? []).filter(source => source.app === 'openchat')
      .map(source => ({ conversationId: source.conversationId, messageId: source.sourceMessageId ?? source.messageId, excerpt: source.excerpt })),
    conversationIds: askConversationIds(ask),
  };
}

/** This chat's to-dos from a page of the owner's asks: open ones oldest first (the order they were noted), done ones most recently closed first. */
export function todosForConversation(asks: OverlayAsk[], conversationId: string): { open: ChatTodo[]; done: ChatTodo[] } {
  const mine = asks.filter(ask => isTodoAsk(ask) && askConversationIds(ask).includes(conversationId)).map(toChatTodo);
  return {
    open: mine.filter(todo => !todo.done).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    done: mine.filter(todo => todo.done).sort((a, b) => (b.closedAt ?? b.createdAt).localeCompare(a.closedAt ?? a.createdAt)),
  };
}

/** Message id → the open to-do made from it, for the marker beside a bubble. */
export function todosByMessage(todos: ChatTodo[], conversationId: string): Map<string, ChatTodo> {
  const map = new Map<string, ChatTodo>();
  for (const todo of todos) for (const source of todo.sources) if (source.conversationId === conversationId && !map.has(source.messageId)) map.set(source.messageId, todo);
  return map;
}

/** A one-line title from a message: its first non-empty line, cut at a word. */
export function todoTitleFromMessage(content: string | null | undefined): string {
  const line = (content ?? '').split(/\r?\n/).map(part => part.trim()).find(Boolean) ?? '';
  const flat = line.replace(/\s+/g, ' ');
  if (flat.length <= TODO_TITLE_MAX) return flat;
  const cut = flat.slice(0, TODO_TITLE_MAX - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > TODO_TITLE_MAX * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * The composer command. A line that starts with `/todo` is never a chat
 * message, including the bare command and near-misses like `/todo:` — the
 * caller must not send it whatever `text` comes back.
 */
export function parseTodoCommand(input: string): { isCommand: false } | { isCommand: true; text: string } {
  const match = /^\s*\/todo(?![a-z0-9_-])[:\s]*([\s\S]*)$/i.exec(input);
  if (!match) return { isCommand: false };
  return { isCommand: true, text: match[1].replace(/\s+/g, ' ').trim().slice(0, TODO_TEXT_MAX) };
}
