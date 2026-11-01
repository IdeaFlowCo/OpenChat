import type { Session } from 'neo4j-driver';

/**
 * @mention resolution shared by the socket and REST send paths (OpenChat-0jy,
 * OpenChat-vwgq.10). Only group conversations parse mentions; DMs notify anyway.
 * Each @Name token resolves to a participant by case-insensitive exact name, else
 * a unique prefix. Ambiguous names never guess which person to notify.
 */
export async function resolveMentionedUserIds(session: Pick<Session, 'run'>, conversationId: string, senderId: string, content: string): Promise<string[]> {
  const mentionedUserIds: string[] = [];
  if (!content) return mentionedUserIds;
  const mentionTokens = [...content.matchAll(/@([\w-]+(?:\s+[\w-]+)?)/g)].map(m => m[1]);
  if (mentionTokens.length === 0) return mentionedUserIds;
  const convCheckResult = await session.run(`
    MATCH (c:Conversation {id: $conversationId})
    RETURN c.type AS convType
  `, { conversationId });
  if (convCheckResult.records[0]?.get('convType') !== 'group') return mentionedUserIds;
  // Names with spaces are intentionally supported (e.g. "@Alice Smith") but
  // single-word tokens (e.g. "@alice") also work.
  const participantsResult = await session.run(`
    MATCH (p:User)-[:PARTICIPATES_IN]->(c:Conversation {id: $conversationId})
    WHERE p.id <> $senderId
    RETURN p.id AS pid, p.name AS pname
  `, { conversationId, senderId });
  const participants = participantsResult.records.map(r => ({
    id: r.get('pid') as string,
    name: (r.get('pname') as string | null) || '',
  }));
  for (const token of mentionTokens) {
    const lower = token.toLowerCase();
    const exact = participants.filter(p => p.name.toLowerCase() === lower);
    const candidates = exact.length > 0
      ? exact
      : participants.filter(p => p.name.toLowerCase().startsWith(lower));
    // Duplicate names are common (especially for neutral fallback names).
    const matched = candidates.length === 1 ? candidates[0] : undefined;
    if (matched && !mentionedUserIds.includes(matched.id)) mentionedUserIds.push(matched.id);
  }
  return mentionedUserIds;
}
