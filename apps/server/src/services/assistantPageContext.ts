/** Resolve the current page on the server, under the signed-in owner's scope. */
import { getDriver } from '../db.js';
import { getPersonOverlay, getThing, PrivateGraphError } from './privateGraph.js';
import { listNoteReviews } from './privateNoteReview.js';
import { assistantTextForMessage } from './assistantContext.js';

export interface AssistantPageContext {
  kind: 'person' | 'thing' | 'conversation' | 'page';
  id?: string;
  label: string;
  includePrivate?: boolean;
}

export function parsePageContext(value: unknown): AssistantPageContext {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PrivateGraphError(400, 'Choose a page context');
  const input = value as Record<string, unknown>;
  if (!['person', 'thing', 'conversation', 'page'].includes(String(input.kind))) throw new PrivateGraphError(400, 'Unknown page context');
  if (typeof input.label !== 'string' || !input.label.trim() || input.label.length > 160) throw new PrivateGraphError(400, 'Page label is required');
  if (input.kind !== 'page' && (typeof input.id !== 'string' || !input.id || input.id.length > 200)) throw new PrivateGraphError(400, 'Choose a person or conversation');
  if (input.includePrivate !== undefined && typeof input.includePrivate !== 'boolean') throw new PrivateGraphError(400, 'Invalid privacy choice');
  return { kind: input.kind as AssistantPageContext['kind'], label: input.label.trim(), ...(typeof input.id === 'string' ? { id: input.id } : {}), includePrivate: input.includePrivate === true };
}

export async function resolvePageContext(ownerId: string, context: AssistantPageContext): Promise<Record<string, unknown>> {
  if (context.kind === 'page') return { page: context.label, privateContextIncluded: false };
  if (context.kind === 'person' || context.kind === 'thing') {
    // Lookup still checks ownership/availability when private context is excluded.
    const item = context.kind === 'person' ? await getPersonOverlay(ownerId, context.id!) : await getThing(ownerId, context.id!);
    const name = 'person' in item ? item.person.name : item.name;
    const asks = context.includePrivate ? (await listNoteReviews(ownerId, { kind: context.kind === 'person' ? 'user' : 'thing', id: context.id! })).asks : [];
    return {
      page: context.kind === 'person' ? 'Person profile' : 'Saved item',
      subject: { kind: context.kind, id: context.id, name },
      privateContextIncluded: context.includePrivate === true,
      ...(context.includePrivate ? {
        asks: asks.slice(0, 30),
        notes: item.notes.slice(0, 10).map(note => ({ id: note.id, text: note.text.slice(0, 2000), recordedAt: note.createdAt })),
        connections: item.links.slice(0, 30).map(link => ({ relation: link.relation, direction: link.direction, target: link.other })),
        ...('card' in item ? { catchUp: item.card } : {}),
      } : {}),
    };
  }
  const session = getDriver().session();
  try {
    const result = await session.run(`
      MATCH (:User {id: $ownerId})-[:PARTICIPATES_IN]->(c:Conversation {id: $conversationId})
      OPTIONAL MATCH (m:Message {conversationId: c.id}) WHERE m.deletedAt IS NULL
      WITH c, m ORDER BY m.createdAt DESC LIMIT 12
      RETURN c.title AS title, collect(m { .id, .senderId, .content, .transcript, .attachments, .createdAt }) AS messages
    `, { ownerId, conversationId: context.id });
    const record = result.records[0];
    if (!record) throw new PrivateGraphError(404, 'Conversation unavailable');
    const messages = (record.get('messages') as Array<{ id: string; senderId: string; content?: string; transcript?: string; attachments?: unknown; createdAt: string }>).filter(m => m.id);
    return { page: 'Conversation', id: context.id, title: record.get('title') || 'Conversation', privateContextIncluded: context.includePrivate === true,
      ...(context.includePrivate ? { messages: messages.reverse().map(m => ({ id: m.id, senderId: m.senderId, text: assistantTextForMessage(m).slice(0, 4000), createdAt: m.createdAt })) } : {}) };
  } finally { await session.close(); }
}

