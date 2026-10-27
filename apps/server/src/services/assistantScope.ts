/** Server-authorized context for a single turn. Conversation scope denies new tools by default. */
export type AssistantScope = { kind: 'universal' | 'conversation'; conversationId: string };
export const SCOPE_DENIED = { error: "Not available in this chat's context" } as const;
const CHAT_TOOLS = new Set(['get_data_sources', 'search_messages', 'list_conversations', 'read_messages', 'read_context']);
export function toolAvailableInScope(scope: AssistantScope, name: string): boolean {
  return scope.kind === 'universal' || CHAT_TOOLS.has(name);
}
export function scopedToolInput(scope: AssistantScope, name: string, input: Record<string, unknown>): Record<string, unknown> | null {
  if (!toolAvailableInScope(scope, name)) return null;
  if (scope.kind === 'universal') return input;
  if (input.conversationId !== undefined && input.conversationId !== scope.conversationId) return null;
  if (['read_messages', 'read_context'].includes(name)) {
    if (input.person || (input.conversationId !== undefined && input.conversationId !== scope.conversationId)) return null;
    return { ...input, conversationId: scope.conversationId };
  }
  return input;
}
export function scopeForParticipants(conversationId: string, userId: string, assistantId: string, type: unknown, participants: string[], requested?: 'conversation' | 'universal'): AssistantScope | null {
  const members = new Set(participants);
  if (!members.has(userId) || !members.has(assistantId)) return null;
  const universal = type === 'direct' && members.size === 2 && requested !== 'conversation';
  return { kind: universal ? 'universal' : 'conversation', conversationId };
}

export type ReplySource = { id: string; conversationId: string; replyToId?: string | null; senderName: string; content: string };
/** Every lookup is an ACL-filtered same-conversation lookup. No name/ID leaks on failure. */
export async function replyAnnotation(parentId: string | null | undefined, conversationId: string, lookup: (id: string) => Promise<ReplySource | null>): Promise<string> {
  if (!parentId) return '';
  const seen = new Set<string>();
  const parts: string[] = [];
  let id: string | null | undefined = parentId;
  let budget = 3000;
  for (let depth = 0; id && depth < 3 && budget > 0; depth++) {
    if (seen.has(id)) break;
    seen.add(id);
    const row = await lookup(id);
    if (!row || row.conversationId !== conversationId) { parts.push('Replying to an earlier message (unavailable)'); break; }
    const excerpt = row.content.slice(0, Math.min(1000, budget));
    parts.push(`Replying to ${row.senderName.slice(0, 100)}: ${excerpt}`);
    budget -= excerpt.length;
    id = row.replyToId;
  }
  return parts.join('\n');
}
