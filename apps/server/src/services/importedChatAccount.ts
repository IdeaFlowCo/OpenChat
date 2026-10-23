import type { ManagedTransaction } from 'neo4j-driver';

// These records are deliberately outside live conversations and need explicit
// account lifecycle handling. Keep every query scoped to its archive owner.
const COLLECTIONS = {
  chats: 'OpenChatImportedChat',
  participants: 'OpenChatImportedParticipant',
  messages: 'OpenChatImportedMessage',
  facts: 'OpenChatImportedFact',
  asks: 'OpenChatImportedAsk',
} as const;

export async function exportImportedChatsForUser(tx: ManagedTransaction, ownerUserId: string) {
  const data: Record<string, unknown[]> = {};
  for (const [collection, label] of Object.entries(COLLECTIONS)) {
    const result = await tx.run(`MATCH (n:${label} {ownerUserId: $ownerUserId}) RETURN n { .* } AS data ORDER BY n.id`, { ownerUserId });
    data[collection] = result.records.map(record => record.get('data'));
  }
  // Keep cited messages with their facts/asks even when the live-chat export
  // has a date range. Declare that scope instead of silently breaking citations.
  return { scope: 'all_time', ...data };
}

export async function deleteImportedChatsForUser(tx: ManagedTransaction, ownerUserId: string): Promise<void> {
  // Share the importer's owner lock BEFORE scanning archive records. Locking
  // only when User is deleted later would let a concurrent import slip between
  // this scan and account deletion, leaving an orphan archive.
  await tx.run('MATCH (u:User {id: $ownerUserId}) SET u.importedChatsRevision = coalesce(u.importedChatsRevision, 0) + 1', { ownerUserId });
  for (const label of Object.values(COLLECTIONS)) {
    await tx.run(`MATCH (n:${label} {ownerUserId: $ownerUserId}) DETACH DELETE n`, { ownerUserId });
  }
  // Other owners retain their source archive; remove only the assertion that
  // one of their imported participants points to this deleted account.
  await tx.run(`MATCH (p:OpenChatImportedParticipant {linkedUserId: $ownerUserId}) REMOVE p.linkedUserId, p.linkedAt`, { ownerUserId });
}
