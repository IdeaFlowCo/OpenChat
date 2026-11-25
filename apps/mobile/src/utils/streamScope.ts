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
    // In a two-person chat the scope is exactly two people; the first name keeps it short.
    const name = getUserDisplayName(others[0] as { name: string; email: string }).trim().split(/\s+/)[0];
    return name ? `You and ${name}` : 'Shared with this chat';
  }
  const title = conversation.title?.trim();
  return `Shared with ${title || `${others.length} ${others.length === 1 ? 'person' : 'people'}`}`;
}

/** Paragraphs of a note: runs of blank lines become one break, so a card is not mostly air. */
export function paragraphs(text: string): string[] {
  const parts = text.replace(/\r\n?/g, '\n').split(/\n[^\S\n]*(?:\n[^\S\n]*)+/).map(part => part.replace(/^\n+|\n+$/g, ''));
  const kept = parts.filter(part => part.trim());
  return kept.length ? kept : [text];
}
