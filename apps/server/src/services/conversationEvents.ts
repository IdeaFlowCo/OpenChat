import type { Server } from 'socket.io';
import { withConversationLock } from './conversationLock.js';

export async function publishConversationEvent(io: Server | undefined, conversationId: string, event: string, payload: unknown): Promise<void> {
  if (!io) return;
  await withConversationLock(conversationId, async tx => {
    const result = await tx.run(`MATCH (u:User)-[:PARTICIPATES_IN]->(:Conversation {id:$conversationId}) RETURN DISTINCT u.id AS id`, { conversationId });
    const rooms = result.records.map(row => `user:${row.get('id')}`);
    if (rooms.length) io.to(rooms).emit(event, payload);
  });
}
