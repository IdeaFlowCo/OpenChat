/**
 * Who can read a shared Stream item, in words, from the conversation's own
 * membership. Never guessed: without the conversation it says "Shared with this chat".
 */
import { getUserDisplayName } from './conversationDisplay';

interface ScopeConversation {
  type?: string | null;
  title?: string | null;
  participants?: Array<{ user?: { id?: string; name?: string | null; email?: string | null; isBot?: boolean } | null } | null> | null;
}

export function sharedScopeLabel(conversation: ScopeConversation | null | undefined, myId: string | undefined): string {
  const others = (conversation?.participants ?? []).flatMap(p => p?.user && p.user.id !== myId ? [p.user] : []);
  if (!conversation || !myId || !others.length) return 'Shared with this chat';
  if (conversation.type === 'direct' && others.length === 1) {
    // Only a real name is used: a placeholder would name someone who is not in the chat.
    const name = others[0]!.name?.trim();
    if (!name) return 'Shared with this chat';
    return `You and ${name.length <= 22 ? name : name.split(/\s+/)[0]}`;
  }
  const title = conversation.title?.trim();
  // The count is everyone else in the chat, so "You and 3 others" is four readers.
  return title ? `Shared with ${title}` : `You and ${others.length} ${others.length === 1 ? 'other' : 'others'}`;
}

/**
 * Paragraphs of a note: a run of blank lines becomes one break, so a card is
 * not mostly air. Only the blank lines go; indentation and every other
 * character of each paragraph stay.
 */
export function paragraphs(text: string): string[] {
  const kept = text.replace(/\r\n?/g, '\n').split(/\n(?:[^\S\n]*\n)+/).filter(part => part.trim());
  return kept.length ? kept : [text];
}
