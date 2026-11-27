import { createHash, randomBytes } from 'node:crypto';
import { nanoid } from 'nanoid';
import type { ManagedTransaction } from 'neo4j-driver';
import type { Server } from 'socket.io';
import { getDriver } from '../db.js';
import { acquireContextAclLocks } from './contextAccess.js';
import { leaveUserSocketsFromConversation } from '../websocket/chatHandler.js';

export class CommunityError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
type Tx = Pick<ManagedTransaction, 'run'>;
type Role = 'owner' | 'admin' | 'member';
type Community = { id: string; name: string; description: string; announcementsId: string; role: Role; memberCount: number; state:'active'|'archived' };
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const integer = (n: unknown) => Number(n ?? 0);
const effects = new WeakMap<object, Array<() => void>>();
function afterCommit(tx: Tx, effect: () => void) {
  const pending=effects.get(tx);
  if (!pending) throw new Error('Community event outside transaction');
  pending.push(effect);
}
async function committed<T>(action: (tx: ManagedTransaction) => Promise<T>): Promise<T> {
  const session=getDriver().session();
  try {
    const result=await session.executeWrite(async tx => {
      const pending: Array<() => void>=[];effects.set(tx,pending);
      try { return {value:await action(tx),pending}; } finally { effects.delete(tx); }
    });
    for (const effect of result.pending) effect();
    return result.value;
  } finally { await session.close(); }
}

export function communityText(value: unknown, field: string, max: number, optional = false): string {
  if (optional && value === undefined) return '';
  if (typeof value !== 'string' || (!optional && !value.trim()) || value.trim().length > max) {
    throw new CommunityError(400, `${field} must be ${optional ? 'at most' : 'between 1 and'} ${max} characters`);
  }
  return value.trim();
}

async function summary(tx: Tx, userId: string, communityId: string): Promise<Community> {
  const result = await tx.run(`MATCH (:User {id:$userId})-[mine:IN_OPENCHAT_COMMUNITY]->(co:OpenChatCommunity {id:$communityId})
    OPTIONAL MATCH (:User)-[member:IN_OPENCHAT_COMMUNITY]->(co)
    RETURN co.id AS id,co.name AS name,co.description AS description,co.announcementsId AS announcementsId,
      mine.role AS role,coalesce(co.state,'active') AS state,count(member) AS memberCount`, { userId, communityId });
  const row = result.records[0];
  if (!row) throw new CommunityError(404, 'Community not found');
  return { id: row.get('id'), name: row.get('name'), description: row.get('description') ?? '',
    announcementsId: row.get('announcementsId'), role: row.get('role'),state:row.get('state'), memberCount: integer(row.get('memberCount')) };
}
function admin(role: Role): void {
  if (role !== 'owner' && role !== 'admin') throw new CommunityError(403, 'Only community admins can do this');
}
function activeCommunity(co:Community){if(co.state==='archived')throw new CommunityError(409,'This community is archived. Existing groups keep their own memberships.');}

/** Every community membership/role mutation locks its announcement conversation.
 * Message writers lock that same conversation, so demotion/leave and posting have
 * one ordering. Child membership never follows automatically from this relation.
 * Lock order: sorted acting/target users, community, announcement conversation,
 * optional child conversation. Ordinary chat paths never lock a community.
 */
async function locked<T>(communityId: string, action: (tx: ManagedTransaction, announcementsId: string) => Promise<T>, userIds: string|string[]=[]): Promise<T> {
  return committed(async tx => {
      // A person joining multiple communities concurrently shares the same
      // capacity lock as creation. User -> community -> conversations.
      await acquireContextAclLocks(tx, {userIds:typeof userIds==='string'?[userIds]:userIds});
      const co = await tx.run(`MATCH (co:OpenChatCommunity {id:$communityId})
        SET co.aclRevision=coalesce(co.aclRevision,0)+1 RETURN co.announcementsId AS id`, { communityId });
      if (!co.records.length) throw new CommunityError(404, 'Community not found');
      const announcementsId = co.records[0]!.get('id') as string;
      await acquireContextAclLocks(tx, { conversationId: announcementsId });
      return action(tx, announcementsId);
    });
}

/** Invalidation contains no names/content. Select current recipients while the
 * community lock is held, rather than trusting possibly stale socket rooms. */
async function changed(tx: Tx, io: Server | undefined, communityId: string, announcementsId: string, extraUser?: string): Promise<void> {
  if (!io) return;
  const members = await tx.run(`MATCH (u:User)-[:IN_OPENCHAT_COMMUNITY]->(:OpenChatCommunity {id:$communityId}) RETURN u.id AS id`, { communityId });
  const ids = new Set<string>(members.records.map(r => r.get('id') as string));
  if (extraUser) ids.add(extraUser);
  afterCommit(tx,() => { for (const id of ids) {
    io.to(`user:${id}`).emit('community:changed', { communityId });
    // No personalized conversation payload is broadcast. Clients refetch their own projection.
    io.to(`user:${id}`).emit('conversation:updated', { conversationId: announcementsId });
  } });
}

async function groupChanged(tx: Tx, io: Server | undefined, conversationId: string): Promise<void> {
  if (!io) return;
  const r=await tx.run(`MATCH (u:User)-[:PARTICIPATES_IN]->(:Conversation {id:$conversationId}) RETURN DISTINCT u.id AS id`,{conversationId});
  const rooms=r.records.map(row=>`user:${row.get('id')}`);
  // Existing subgroup members need a roster refresh even if they never joined
  // the community. No roster/content is carried across a post-commit race.
  afterCommit(tx,()=>{ if(rooms.length) io.to(rooms).emit('conversation:updated',{conversationId}); });
}

async function capacity(tx: Tx, userId: string): Promise<void> {
  const r = await tx.run(`MATCH (:User {id:$userId})-[r:IN_OPENCHAT_COMMUNITY]->() RETURN count(r) AS n`, { userId });
  if (integer(r.records[0]?.get('n')) >= 100) throw new CommunityError(409, 'You can belong to up to 100 communities');
}

export async function listCommunities(userId: string): Promise<Community[]> {
  const s = getDriver().session();
  try {
    const r = await s.run(`MATCH (:User {id:$userId})-[mine:IN_OPENCHAT_COMMUNITY]->(co:OpenChatCommunity)
      OPTIONAL MATCH (:User)-[member:IN_OPENCHAT_COMMUNITY]->(co)
      RETURN co.id AS id,co.name AS name,co.description AS description,co.announcementsId AS announcementsId,
        mine.role AS role,coalesce(co.state,'active') AS state,count(member) AS memberCount ORDER BY toLower(co.name),co.id`, { userId });
    return r.records.map(row => ({ id: row.get('id'),name: row.get('name'),description: row.get('description') ?? '',
      announcementsId: row.get('announcementsId'),role: row.get('role'),state:row.get('state'),memberCount: integer(row.get('memberCount')) }));
  } finally { await s.close(); }
}

export async function createCommunity(userId: string, body: Record<string, unknown>, io?: Server): Promise<Community> {
  const name = communityText(body.name,'Name',100), description = communityText(body.description,'Description',1000,true);
  const communityId = nanoid(), announcementsId = nanoid();
  return committed(async tx => {
      // Serialize capacity checks for the creator; existing shared User data is untouched apart from its ACL revision.
      await acquireContextAclLocks(tx, { userIds: [userId] });
      await capacity(tx,userId);
      const r = await tx.run(`MATCH (u:User {id:$userId})
        CREATE (co:OpenChatCommunity {id:$communityId,name:$name,description:$description,announcementsId:$announcementsId,state:'active',createdAt:datetime()})
        CREATE (u)-[:IN_OPENCHAT_COMMUNITY {role:'owner',joinedAt:datetime()}]->(co)
        CREATE (a:Conversation {id:$announcementsId,type:'group',title:$name+' · Announcements',communityId:$communityId,
          communityKind:'announcements',createdAt:datetime(),updatedAt:datetime()})
        CREATE (u)-[:PARTICIPATES_IN {role:'owner',joinedAt:datetime()}]->(a)
        RETURN co.id AS id`, { userId,communityId,announcementsId,name,description });
      if (!r.records.length) throw new CommunityError(404,'User not found');
      const result = await summary(tx,userId,communityId);
      await changed(tx,io,communityId,announcementsId);
      return result;
    });

}

export async function getCommunity(userId: string, communityId: string) {
  return locked(communityId,async tx => {
    const co = await summary(tx,userId,communityId);
    // Directory fields only: no previews, messages, or child rosters before joining.
    const groups = await tx.run(`MATCH (co:OpenChatCommunity {id:$communityId})-[:HAS_OPENCHAT_GROUP]->(c:Conversation)
      RETURN c.id AS id,c.title AS title,EXISTS { MATCH (:User {id:$userId})-[:PARTICIPATES_IN]->(c) } AS joined
      ORDER BY toLower(c.title),c.id`, { communityId,userId });
    const members = await tx.run(`MATCH (u:User)-[r:IN_OPENCHAT_COMMUNITY]->(:OpenChatCommunity {id:$communityId})
      RETURN u.id AS id,u.name AS name,r.role AS role ORDER BY CASE r.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,u.name,u.id`, { communityId });
    return { ...co,groups: groups.records.map(r => ({ id:r.get('id'),title:r.get('title'),joined:r.get('joined') === true })),
      members: members.records.map(r => ({id:r.get('id'),name:r.get('name') ?? 'Member',role:r.get('role')})) };
  },[userId]);
}

export async function updateCommunity(userId: string, communityId: string, body: Record<string, unknown>, io?: Server) {
  const name = communityText(body.name,'Name',100), description = communityText(body.description,'Description',1000,true);
  return locked(communityId,async (tx,announcementsId) => {
    admin((await summary(tx,userId,communityId)).role);
    await tx.run(`MATCH (co:OpenChatCommunity {id:$communityId}),(a:Conversation {id:$announcementsId})
      SET co.name=$name,co.description=$description,a.title=$name+' · Announcements'`, { communityId,announcementsId,name,description });
    const result = await summary(tx,userId,communityId);
    await changed(tx,io,communityId,announcementsId); return result;
  },[userId]);
}

export async function addCommunityGroup(userId: string, communityId: string, body: Record<string, unknown>, existing: boolean, io?: Server) {
  const conversationId = existing ? communityText(body.conversationId,'Group',200) : nanoid();
  const title = existing ? '' : communityText(body.title,'Group name',100);
  if (existing && body.allowCommunityJoin !== true) throw new CommunityError(400,'Confirm that community members can see the group name and choose to join its history');
  return locked(communityId,async (tx,announcementsId) => {
    admin((await summary(tx,userId,communityId)).role);
    const count = await tx.run(`MATCH (:OpenChatCommunity {id:$communityId})-[r:HAS_OPENCHAT_GROUP]->() RETURN count(r) AS n`, { communityId });
    if (integer(count.records[0]?.get('n')) >= 100) throw new CommunityError(409,'A community can have up to 100 groups');
    if (existing) {
      await acquireContextAclLocks(tx, { conversationId });
      const check = await tx.run(`MATCH (:User {id:$userId})-[r:PARTICIPATES_IN]->(c:Conversation {id:$conversationId})
        RETURN c.type AS type,r.role AS role,c.unlinkedGroupId AS managedGroupId,c.communityKind AS communityKind,
          EXISTS { MATCH (:OpenChatCommunity)-[:HAS_OPENCHAT_GROUP]->(c) } AS linked`, { userId,conversationId });
      const row = check.records[0];
      if (!row) throw new CommunityError(404,'Group not found');
      if (row.get('role') !== 'owner') throw new CommunityError(403,'Only the existing group owner can link it');
      if (row.get('type') !== 'group' || row.get('communityKind') || row.get('managedGroupId') || row.get('linked')) {
        throw new CommunityError(409,'Choose an independent OpenChat group; managed and already linked groups keep their own controls');
      }
    } else {
      await tx.run(`MATCH (u:User {id:$userId}) CREATE (c:Conversation {id:$conversationId,type:'group',title:$title,createdAt:datetime(),updatedAt:datetime()})
        CREATE (u)-[:PARTICIPATES_IN {role:'owner',joinedAt:datetime()}]->(c)`, { userId,conversationId,title });
    }
    await tx.run(`MATCH (co:OpenChatCommunity {id:$communityId}),(c:Conversation {id:$conversationId}) CREATE (co)-[:HAS_OPENCHAT_GROUP]->(c)`, { communityId,conversationId });
    await groupChanged(tx,io,conversationId);
    await changed(tx,io,communityId,announcementsId);
    return { conversationId };
  },[userId]);
}

export async function unlinkCommunityGroup(userId: string, communityId: string, conversationId: string, io?: Server) {
  return locked(communityId,async (tx,announcementsId) => {
    admin((await summary(tx,userId,communityId)).role);
    await acquireContextAclLocks(tx, { conversationId });
    await tx.run(`MATCH (:OpenChatCommunity {id:$communityId})-[r:HAS_OPENCHAT_GROUP]->(:Conversation {id:$conversationId}) DELETE r`, { communityId,conversationId });
    await changed(tx,io,communityId,announcementsId);
  },[userId]);
}

export async function joinCommunityGroup(userId: string, communityId: string, conversationId: string, io?: Server) {
  return locked(communityId,async (tx,announcementsId) => {
    activeCommunity(await summary(tx,userId,communityId));
    await acquireContextAclLocks(tx, { conversationId });
    const r = await tx.run(`MATCH (co:OpenChatCommunity {id:$communityId})-[:HAS_OPENCHAT_GROUP]->(c:Conversation {id:$conversationId}), (u:User {id:$userId})
      WHERE c.unlinkedGroupId IS NULL AND c.communityKind IS NULL
        AND NOT EXISTS { MATCH (other:User)-[:PARTICIPATES_IN]->(c) WHERE (u)-[:BLOCKED]->(other) OR (other)-[:BLOCKED]->(u) }
      MERGE (u)-[r:PARTICIPATES_IN]->(c) ON CREATE SET r.role='member',r.joinedAt=datetime()
      RETURN c.id AS id`, { communityId,conversationId,userId });
    if (!r.records.length) throw new CommunityError(404,'Group not available');
    await groupChanged(tx,io,conversationId);
    await changed(tx,io,communityId,announcementsId);
    afterCommit(tx,() => {io?.to(`user:${userId}`).emit('conversation:created', { conversationId });});
    return { conversationId };
  },[userId]);
}

export async function setCommunityRole(userId: string, communityId: string, targetId: string, role: unknown, io?: Server) {
  if (!['owner','admin','member'].includes(role as string)) throw new CommunityError(400,'Choose owner, admin or member');
  return locked(communityId,async (tx,announcementsId) => {
    const mine = await summary(tx,userId,communityId);
    if (mine.role !== 'owner') throw new CommunityError(403,'Only the community owner can change roles');
    if (targetId === userId) throw new CommunityError(400,'Choose another member');
    await summary(tx,targetId,communityId);
    await tx.run(`MATCH (u:User {id:$targetId})-[r:IN_OPENCHAT_COMMUNITY]->(co:OpenChatCommunity {id:$communityId}) SET r.role=$role`, { targetId,communityId,role });
    if (role === 'owner') {
      await tx.run(`MATCH (:User {id:$userId})-[r:IN_OPENCHAT_COMMUNITY]->(:OpenChatCommunity {id:$communityId}) SET r.role='admin'`, { userId,communityId });
    }
    await changed(tx,io,communityId,announcementsId);
  },[userId,targetId]);
}

export async function removeCommunityMember(userId: string, communityId: string, targetId: string, io?: Server) {
  return locked(communityId,async (tx,announcementsId) => {
    const mine = await summary(tx,userId,communityId), target = await summary(tx,targetId,communityId);
    if (target.role === 'owner') throw new CommunityError(409,'Transfer ownership before leaving');
    if (userId !== targetId) {
      admin(mine.role);
      if (target.role === 'admin' && mine.role !== 'owner') throw new CommunityError(403,'Only the owner can remove another admin');
    }
    await tx.run(`MATCH (:User {id:$targetId})-[r:IN_OPENCHAT_COMMUNITY]->(co:OpenChatCommunity {id:$communityId}) DELETE r
      WITH co MATCH (:User {id:$targetId})-[p:PARTICIPATES_IN]->(:Conversation {id:$announcementsId}) DELETE p`, { targetId,communityId,announcementsId });
    // Removing someone invalidates outstanding community invites so a removed
    // person cannot immediately reuse a link. Self-leave keeps other invites intact.
    if (targetId !== userId) await tx.run(`MATCH (:OpenChatCommunity {id:$communityId})-[:HAS_OPENCHAT_INVITE]->(i:OpenChatCommunityInvite) SET i.revokedAt=datetime()`, { communityId });
    afterCommit(tx,() => {
      if (io) leaveUserSocketsFromConversation(io,targetId,announcementsId);
      io?.to(`user:${targetId}`).emit('participant:removed', { conversationId:announcementsId,userId:targetId });
    });
    await changed(tx,io,communityId,announcementsId,targetId);
  },[userId,targetId]);
}

export async function createCommunityInvite(userId: string, communityId: string, io?: Server) {
  return locked(communityId,async (tx,announcementsId) => {
    admin((await summary(tx,userId,communityId)).role);
    // One active token avoids unbounded accumulation; only its hash is persisted.
    await tx.run(`MATCH (:OpenChatCommunity {id:$communityId})-[:HAS_OPENCHAT_INVITE]->(old:OpenChatCommunityInvite) DETACH DELETE old`, { communityId });
    const token = randomBytes(32).toString('base64url');
    await tx.run(`MATCH (co:OpenChatCommunity {id:$communityId}) CREATE (co)-[:HAS_OPENCHAT_INVITE]->(:OpenChatCommunityInvite {tokenHash:$tokenHash,expiresAt:datetime()+duration('P7D')})`, { communityId,tokenHash:hash(token) });
    await changed(tx,io,communityId,announcementsId);
    return { token };
  },[userId]);
}

export async function revokeCommunityInvites(userId: string, communityId: string, io?: Server) {
  return locked(communityId,async (tx,announcementsId) => {
    admin((await summary(tx,userId,communityId)).role);
    await tx.run(`MATCH (:OpenChatCommunity {id:$communityId})-[:HAS_OPENCHAT_INVITE]->(i:OpenChatCommunityInvite) SET i.revokedAt=datetime()`, { communityId });
    await changed(tx,io,communityId,announcementsId);
  },[userId]);
}

export async function joinCommunity(userId: string, token: unknown, io?: Server) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new CommunityError(404,'Invite not available');
  const tokenHash = hash(token), s = getDriver().session();
  try {
    const match = await s.run(`MATCH (co:OpenChatCommunity)-[:HAS_OPENCHAT_INVITE]->(:OpenChatCommunityInvite {tokenHash:$tokenHash}) RETURN co.id AS id`, { tokenHash });
    if (!match.records.length) throw new CommunityError(404,'Invite not available');
    const communityId = match.records[0]!.get('id') as string;
    return await locked(communityId,async (tx,announcementsId) => {
      const valid = await tx.run(`MATCH (co:OpenChatCommunity {id:$communityId})-[:HAS_OPENCHAT_INVITE]->(i:OpenChatCommunityInvite {tokenHash:$tokenHash}), (u:User {id:$userId})
        WHERE i.revokedAt IS NULL AND i.expiresAt > datetime() AND coalesce(co.state,'active')='active'
          AND NOT EXISTS { MATCH (other:User)-[:IN_OPENCHAT_COMMUNITY]->(co) WHERE (u)-[:BLOCKED]->(other) OR (other)-[:BLOCKED]->(u) }
        RETURN EXISTS { MATCH (u)-[:IN_OPENCHAT_COMMUNITY]->(co) } AS joined`, { communityId,tokenHash,userId });
      if (!valid.records.length) throw new CommunityError(404,'Invite not available');
      if (valid.records[0]!.get('joined') !== true) {
        // Community lock serializes member cap with other joins/removals.
        const size = await tx.run(`MATCH (:User)-[r:IN_OPENCHAT_COMMUNITY]->(:OpenChatCommunity {id:$communityId}) RETURN count(r) AS n`, { communityId });
        if (integer(size.records[0]?.get('n')) >= 500) throw new CommunityError(409,'This community is full');
        await capacity(tx,userId);
        await tx.run(`MATCH (co:OpenChatCommunity {id:$communityId}),(u:User {id:$userId}),(a:Conversation {id:$announcementsId})
          MERGE (u)-[r:IN_OPENCHAT_COMMUNITY]->(co) ON CREATE SET r.role='member',r.joinedAt=datetime()
          MERGE (u)-[p:PARTICIPATES_IN]->(a) ON CREATE SET p.role='member',p.joinedAt=datetime()`, { communityId,userId,announcementsId });
      }
      const result = await summary(tx,userId,communityId);
      await changed(tx,io,communityId,announcementsId);
      afterCommit(tx,() => {io?.to(`user:${userId}`).emit('conversation:created', { conversationId:announcementsId });});
      return result;
    },userId);
  } finally { await s.close(); }
}

/** Called under the announcement conversation ACL lock by every message writer.
 * Normal chats keep their existing send policy. This adds no provider/key scopes.
 */
export async function assertCommunityPosting(tx: Tx, userId: string, conversationId: string): Promise<void> {
  const r = await tx.run(`MATCH (c:Conversation {id:$conversationId})
    RETURN c.communityKind='announcements' AS announcements,
      EXISTS { MATCH (:User {id:$userId})-[r:IN_OPENCHAT_COMMUNITY]->(:OpenChatCommunity {id:c.communityId}) WHERE r.role IN ['owner','admin'] } AS admin`, { userId,conversationId });
  if (r.records[0]?.get('announcements') === true && r.records[0]?.get('admin') !== true) {
    throw new CommunityError(403,'Only community admins can post announcements');
  }
}

/** Runs at the start of the existing account-deletion transaction, before
 * message/relationship redaction. User -> all communities -> sorted announcement
 * conversations is consistent with community and shared-Thought mutation locks.
 * An existing admin succeeds the owner; ordinary members gain no new authority.
 * Without an admin the community archives, its invites close, and child/history
 * data stays in place. The account route itself remains the authorized erase.
 */
export async function prepareCommunityAccountDeletion(tx:ManagedTransaction,userId:string){
  await acquireContextAclLocks(tx,{userIds:[userId]});
  const memberships=await tx.run(`MATCH(:User {id:$userId})-[:IN_OPENCHAT_COMMUNITY]->(co:OpenChatCommunity)
    RETURN co.id AS id ORDER BY id`,{userId});
  const communities:Array<{id:string;announcementsId:string}>=[];
  for(const row of memberships.records){
    const id=row.get('id') as string;
    const locked=await tx.run(`MATCH(co:OpenChatCommunity {id:$id}) SET co.aclRevision=coalesce(co.aclRevision,0)+1 RETURN co.announcementsId AS announcementsId`,{id});
    if(locked.records.length)communities.push({id,announcementsId:locked.records[0]!.get('announcementsId') as string});
  }
  for(const announcementsId of [...new Set(communities.map(c=>c.announcementsId))].sort())await acquireContextAclLocks(tx,{conversationId:announcementsId});
  const updates:Array<{communityId:string;announcementsId:string;memberIds:string[]}>=[];
  for(const co of communities){
    const role=await tx.run(`MATCH(:User {id:$userId})-[r:IN_OPENCHAT_COMMUNITY]->(:OpenChatCommunity {id:$id}) RETURN r.role AS role`,{userId,id:co.id});
    if(role.records[0]?.get('role')==='owner'){
      await tx.run(`MATCH(:OpenChatCommunity {id:$id})-[:HAS_OPENCHAT_INVITE]->(i:OpenChatCommunityInvite) SET i.revokedAt=datetime()`,{id:co.id});
      const successor=await tx.run(`MATCH(u:User)-[r:IN_OPENCHAT_COMMUNITY]->(:OpenChatCommunity {id:$id})
        WHERE u.id<>$userId AND r.role='admin' RETURN u.id AS id ORDER BY r.joinedAt,u.id LIMIT 1`,{id:co.id,userId});
      if(successor.records.length){
        const next=successor.records[0]!.get('id') as string;
        await tx.run(`MATCH(:User {id:$next})-[r:IN_OPENCHAT_COMMUNITY]->(:OpenChatCommunity {id:$id}) SET r.role='owner'
          WITH r OPTIONAL MATCH(:User {id:$next})-[p:PARTICIPATES_IN]->(:Conversation {id:$announcementsId}) SET p.role='owner'`,{next,id:co.id,announcementsId:co.announcementsId});
      }else await tx.run(`MATCH(co:OpenChatCommunity {id:$id}) SET co.state='archived',co.archivedAt=datetime(),co.archiveReason='owner_account_deleted'`,{id:co.id});
    }
    const members=await tx.run(`MATCH(u:User)-[:IN_OPENCHAT_COMMUNITY]->(:OpenChatCommunity {id:$id}) WHERE u.id<>$userId RETURN u.id AS id`,{id:co.id,userId});
    updates.push({communityId:co.id,announcementsId:co.announcementsId,memberIds:members.records.map(r=>r.get('id') as string)});
  }
  return updates;
}
