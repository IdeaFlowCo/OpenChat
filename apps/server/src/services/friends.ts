import { getDriver } from '../db.js';
import { acquireContextAclLocks } from './contextAccess.js';
import { DEFAULT_PUBLIC_DISPLAY_NAME } from '../privacy/profilePrivacy.js';

export type FriendState = 'none' | 'incoming' | 'outgoing' | 'friends';
export type FriendAction = 'request' | 'accept' | 'decline' | 'cancel' | 'remove';
export interface FriendStatus { userId: string; state: FriendState; updatedAt: string | null }
export interface FriendRow extends FriendStatus { user: { id: string; name: string; avatarUrl: string | null } }

export class FriendError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

type Connection = {
  state: 'pending' | 'accepted' | 'declined' | 'cancelled' | 'removed';
  requestedBy: string | null;
  requestedTo: string | null;
  updatedAt: string | null;
};

const DECLINE_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

export function publicFriendState(connection: Connection | null, actorId: string): FriendState {
  if (!connection) return 'none';
  if (connection.state === 'accepted') return 'friends';
  if (connection.state === 'pending') return connection.requestedTo === actorId ? 'incoming' : 'outgoing';
  return 'none';
}

/** Validate each transition before any write. A crossed request stays incoming. */
export function nextFriendConnection(
  current: Connection | null,
  action: FriendAction,
  actorId: string,
  targetId: string,
  now: string,
): Connection | null {
  if (action === 'request') {
    if (current?.state === 'accepted' || current?.state === 'pending') return current;
    if (current?.state === 'declined' && current.requestedBy === actorId
      && current.updatedAt && Date.parse(now) - Date.parse(current.updatedAt) < DECLINE_COOLDOWN_MS) {
      throw new FriendError(429, 'Please wait before sending another request');
    }
    return { state: 'pending', requestedBy: actorId, requestedTo: targetId, updatedAt: now };
  }
  if (action === 'accept' || action === 'decline') {
    if (current?.requestedTo === actorId
      && current.state === (action === 'accept' ? 'accepted' : 'declined')) return current;
    if (current?.state !== 'pending' || current.requestedTo !== actorId) {
      throw new FriendError(409, 'No incoming request to respond to');
    }
    return { ...current, state: action === 'accept' ? 'accepted' : 'declined', updatedAt: now };
  }
  if (action === 'cancel') {
    if (current?.state === 'cancelled' && current.requestedBy === actorId) return current;
    if (current?.state !== 'pending' || current.requestedBy !== actorId) {
      throw new FriendError(409, 'No outgoing request to cancel');
    }
    return { ...current, state: 'cancelled', updatedAt: now };
  }
  if (current?.state === 'removed') return current;
  if (current?.state !== 'accepted') throw new FriendError(409, 'No friendship to remove');
  return { ...current, state: 'removed', updatedAt: now };
}

const pair = (a: string, b: string) => [a, b].sort();
const pairKey = (a: string, b: string) => JSON.stringify(pair(a, b));

const visibilityQuery = `
  MATCH (actor:User {id: $actorId}), (target:User {id: $targetId})
  RETURN coalesce(target.isBot, false) AS isBot,
    ((actor)-[:BLOCKED]->(target) OR (target)-[:BLOCKED]->(actor)) AS blocked,
    (coalesce(target.discoveryMode, 'name') = 'name'
      OR EXISTS { MATCH (actor)-[:PARTICIPATES_IN]->(:Conversation)<-[:PARTICIPATES_IN]-(target) }
      OR EXISTS { MATCH (existing:OpenChatConnection {pairKey: $pairKey}) WHERE existing.state IN ['pending', 'accepted'] }
      OR $cardAuthorized) AS visible
`;

function assertTarget(record: { get: (key: string) => unknown } | undefined): void {
  if (!record || record.get('blocked') === true || record.get('isBot') === true || record.get('visible') !== true) {
    throw new FriendError(404, 'Person unavailable');
  }
}

export async function getFriendStatus(actorId: string, targetId: string, cardAuthorized = false): Promise<FriendStatus> {
  if (actorId === targetId) throw new FriendError(400, 'Cannot add yourself');
  const session = getDriver().session();
  try {
    const visible = await session.run(visibilityQuery, { actorId, targetId, cardAuthorized, pairKey: pairKey(actorId, targetId) });
    assertTarget(visible.records[0]);
    const result = await session.run('OPTIONAL MATCH (connection:OpenChatConnection {pairKey: $pairKey}) RETURN connection { .state, .requestedBy, .requestedTo, updatedAt: toString(connection.updatedAt) } AS connection', { pairKey: pairKey(actorId, targetId) });
    const connection = result.records[0]?.get('connection') as Connection | null;
    return { userId: targetId, state: publicFriendState(connection, actorId), updatedAt: connection?.updatedAt ?? null };
  } finally { await session.close(); }
}

export async function changeFriend(
  actorId: string,
  targetId: string,
  action: FriendAction,
  source: 'card' | 'profile' | 'people' = 'profile',
  cardAuthorized = false,
  cardToken?: string,
): Promise<FriendStatus> {
  if (actorId === targetId) throw new FriendError(400, 'Cannot add yourself');
  const session = getDriver().session();
  try {
    return await session.executeWrite(async tx => {
      // Block and all relationship transitions use these same ordered user locks.
      await acquireContextAclLocks(tx, { userIds: [actorId, targetId] });
      if (source === 'card') {
        const card = await tx.run(`
          MATCH (:User {id: $targetId})-[:HAS_ADDME_CARD]->(card:AddMeCard {token: $cardToken})
          WHERE card.revokedAt IS NULL
          RETURN card.token AS token
        `, { targetId, cardToken });
        if (card.records.length === 0) throw new FriendError(404, 'Card not found');
      }
      const visible = await tx.run(visibilityQuery, { actorId, targetId, cardAuthorized, pairKey: pairKey(actorId, targetId) });
      assertTarget(visible.records[0]);
      const key = pairKey(actorId, targetId);
      const currentResult = await tx.run('OPTIONAL MATCH (connection:OpenChatConnection {pairKey: $pairKey}) RETURN connection { .state, .requestedBy, .requestedTo, updatedAt: toString(connection.updatedAt) } AS connection', { pairKey: key });
      const current = currentResult.records[0]?.get('connection') as Connection | null;
      const now = new Date().toISOString();
      const next = nextFriendConnection(current, action, actorId, targetId, now);
      if (next && next !== current) {
        const [firstId, secondId] = pair(actorId, targetId);
        await tx.run(`
          MERGE (connection:OpenChatConnection {pairKey: $pairKey})
          ON CREATE SET connection.createdAt = datetime($now)
          SET connection.firstId = $firstId, connection.secondId = $secondId,
              connection.state = $state, connection.requestedBy = $requestedBy,
              connection.requestedTo = $requestedTo, connection.updatedAt = datetime($now),
              connection.source = CASE WHEN $action = 'request' THEN $source ELSE connection.source END
        `, { pairKey: key, firstId, secondId, ...next, now, source, action });
      }
      return { userId: targetId, state: publicFriendState(next, actorId), updatedAt: next?.updatedAt ?? null };
    });
  } finally { await session.close(); }
}

export async function listFriends(actorId: string): Promise<{ friends: FriendRow[]; incoming: FriendRow[]; outgoing: FriendRow[] }> {
  const session = getDriver().session();
  try {
    const result = await session.run(`
      MATCH (actor:User {id: $actorId}), (connection:OpenChatConnection)
      WHERE (connection.firstId = $actorId OR connection.secondId = $actorId)
        AND connection.state IN ['pending', 'accepted']
      MATCH (other:User)
      WHERE other.id = CASE WHEN connection.firstId = $actorId THEN connection.secondId ELSE connection.firstId END
        AND NOT (actor)-[:BLOCKED]->(other) AND NOT (other)-[:BLOCKED]->(actor)
      RETURN other { .id, name: CASE WHEN other.name IS NULL OR trim(other.name) = '' OR other.name CONTAINS '@' THEN $fallbackName ELSE other.name END, .avatarUrl } AS user,
        connection.state AS state, connection.requestedTo AS requestedTo,
        toString(connection.updatedAt) AS updatedAt
      ORDER BY connection.updatedAt DESC
    `, { actorId, fallbackName: DEFAULT_PUBLIC_DISPLAY_NAME });
    const output: { friends: FriendRow[]; incoming: FriendRow[]; outgoing: FriendRow[] } = { friends: [], incoming: [], outgoing: [] };
    for (const record of result.records) {
      const user = record.get('user') as FriendRow['user'];
      const state: FriendState = record.get('state') === 'accepted' ? 'friends' : record.get('requestedTo') === actorId ? 'incoming' : 'outgoing';
      const row = { userId: user.id, user, state, updatedAt: record.get('updatedAt') as string | null };
      output[state === 'friends' ? 'friends' : state].push(row);
    }
    return output;
  } finally { await session.close(); }
}
