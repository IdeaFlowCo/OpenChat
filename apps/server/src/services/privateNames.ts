import { classifyContactDiscoveryQuery } from '../privacy/contactDiscovery.js';
import { getDriver } from '../db.js';
import { normalizePublicDisplayName } from '../privacy/profilePrivacy.js';
import { acquireContextAclLocks } from './contextAccess.js';

export class PrivateNameError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function normalizePrivateName(value: unknown): string {
  if (typeof value !== 'string') throw new PrivateNameError(400, 'Private name must be text');
  const name = value.trim();
  if (!name || name.length > 100 || [...name].some(char => { const code = char.charCodeAt(0); return code < 32 || code === 127 || code === 0x2028 || code === 0x2029; })) {
    throw new PrivateNameError(400, 'Use a private name of 1–100 characters on one line');
  }
  return name;
}

// A private name never grants visibility. Use the existing friend/profile
// visibility boundary; canonical User IDs exclude device-only contacts.
const visibleTarget = `
  MATCH (owner:User {id: $ownerId}), (target:User {id: $targetId})
  WHERE owner <> target AND NOT coalesce(target.isBot, false)
    AND NOT (owner)-[:BLOCKED]->(target) AND NOT (target)-[:BLOCKED]->(owner)
    AND (coalesce(target.discoveryMode, 'name') = 'name'
      OR (target.discoveryMode = 'email_only' AND $exactEmail <> '' AND toLower(target.email) = $exactEmail)
      OR EXISTS { MATCH (owner)-[:PARTICIPATES_IN]->(:Conversation)<-[:PARTICIPATES_IN]-(target) }
      OR EXISTS { MATCH (connection:OpenChatConnection {pairKey: $pairKey}) WHERE connection.state IN ['pending', 'accepted'] })
`;
const paramsFor = (ownerId: string, targetId: string, proof?: unknown) => {
  const discovery = classifyContactDiscoveryQuery(proof);
  return { ownerId, targetId, pairKey: JSON.stringify([ownerId, targetId].sort()),
    exactEmail: discovery.kind === 'email' ? discovery.normalized : '',
  };
};

export async function getPrivateName(ownerId: string, targetId: string, proof?: unknown): Promise<{ name: string | null }> {
  const session = getDriver().session();
  try {
    const result = await session.run(`${visibleTarget}
      OPTIONAL MATCH (owner)-[privateName:OPENCHAT_PRIVATE_NAME]->(target)
      RETURN privateName.name AS name`, paramsFor(ownerId, targetId, proof));
    if (!result.records.length) throw new PrivateNameError(404, 'Person unavailable');
    return { name: result.records[0].get('name') as string | null };
  } finally { await session.close(); }
}

export async function setPrivateName(ownerId: string, targetId: string, value: unknown, proof?: unknown): Promise<{ name: string }> {
  const name = normalizePrivateName(value);
  const session = getDriver().session();
  try {
    return await session.executeWrite(async tx => {
      // Same ordered locks as block/friend changes: check visibility and write
      // together so blocking cannot race an alias mutation or duplicate MERGE.
      await acquireContextAclLocks(tx, { userIds: [ownerId, targetId] });
      const result = await tx.run(`${visibleTarget}
        MERGE (owner)-[privateName:OPENCHAT_PRIVATE_NAME]->(target)
        SET privateName.name = $name
        RETURN privateName.name AS name`, { ...paramsFor(ownerId, targetId, proof), name });
      if (!result.records.length) throw new PrivateNameError(404, 'Person unavailable');
      return { name };
    });
  } finally { await session.close(); }
}

export async function clearPrivateName(ownerId: string, targetId: string): Promise<{ name: null }> {
  const session = getDriver().session();
  try {
    // Owners may clear their own metadata even after a block, deletion or
    // visibility change. Do not inspect/return the target's profile here.
    await session.executeWrite(async tx => {
      await acquireContextAclLocks(tx, { userIds: [ownerId, targetId] });
      await tx.run(`MATCH (:User {id: $ownerId})-[privateName:OPENCHAT_PRIVATE_NAME]->(:User {id: $targetId})
        DELETE privateName`, { ownerId, targetId });
    });
    return { name: null };
  } finally { await session.close(); }
}


/** Minimal official profile for the authenticated viewer, independent of DMs.
 * The same visibility gate applies as aliases; no email/phone/private label is
 * projected into this identity response.
 */
export async function getContactProfile(ownerId: string, targetId: string, proof?: unknown): Promise<{ id: string; name: string; avatarUrl: string | null; isBot: boolean }> {
  const session = getDriver().session();
  try {
    const result = await session.run(`${visibleTarget}
      RETURN target { .id, .name, .avatarUrl, .isBot } AS user`, paramsFor(ownerId, targetId, proof));
    if (!result.records.length) throw new PrivateNameError(404, 'Person unavailable');
    const user = result.records[0].get('user') as { id: string; name?: unknown; avatarUrl?: string | null; isBot?: boolean };
    return { id: user.id, name: normalizePublicDisplayName(user.name), avatarUrl: user.avatarUrl || null, isBot: user.isBot === true };
  } finally { await session.close(); }
}
