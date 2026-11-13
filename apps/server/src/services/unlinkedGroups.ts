import { createHash } from 'node:crypto';
import neo4j from 'neo4j-driver';
import { getDriver } from '../db.js';
import { ensureSharedInboxInTransaction } from './unlinkedMessaging.js';
import { acquireContextAclLocks } from './contextAccess.js';

const ISSUER = 'https://id.ideaflow.app/api/auth';
type Member = { issuer: string; subject: string; name: string };
export type UnlinkedGroupSnapshot = { groupId: string; revision: number; name: string; organizer: Member; members: Member[]; deleted: boolean; existingConversationId?: string };
export class UnlinkedGroupError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export function parseGroupSnapshot(input: unknown): UnlinkedGroupSnapshot {
  const v = input as UnlinkedGroupSnapshot;
  const member = (m: Member) => m && typeof m === 'object' && !Array.isArray(m)
    && Object.keys(m).every(k => ['issuer', 'subject', 'name'].includes(k))
    && m.issuer === ISSUER && typeof m.subject === 'string' && /^[^\s\x00-\x1f\x7f]{1,512}$/.test(m.subject)
    && typeof m.name === 'string' && m.name.length <= 160;
  if (!v || typeof v !== 'object' || Array.isArray(v)
    || Object.keys(v).some(k => !['groupId','revision','name','organizer','members','deleted','existingConversationId'].includes(k))
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v.groupId)
    || !Number.isSafeInteger(v.revision) || v.revision < 1 || typeof v.name !== 'string' || !v.name.trim() || v.name.length > 100
    || !member(v.organizer) || !Array.isArray(v.members) || v.members.length > 499 || !v.members.every(member)
    || new Set([v.organizer.subject,...v.members.map(m=>m.subject)]).size !== v.members.length + 1
    || typeof v.deleted !== 'boolean'
    || (v.existingConversationId !== undefined && (typeof v.existingConversationId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(v.existingConversationId)))) {
    throw new UnlinkedGroupError(400, 'invalid_group_snapshot');
  }
  return v;
}

/** Authoritative roster projection. No messages, invitations, or notification pushes. */
export async function syncUnlinkedGroup(input: UnlinkedGroupSnapshot) {
  const v = parseGroupSnapshot(input);
  const ordered = [v.organizer, ...v.members].sort((a,b)=>a.subject.localeCompare(b.subject));
  const fingerprint = createHash('sha256').update(JSON.stringify([v.name,v.organizer.subject,ordered,v.deleted,v.existingConversationId ?? null])).digest('hex');
  const id = v.existingConversationId ?? `uc_${createHash('sha256').update(v.groupId).digest('hex').slice(0,32)}`;
  const session = getDriver().session();
  try {
    return await session.executeWrite(async tx => {
      const people = [];
      for (const m of ordered) people.push({ ...await ensureSharedInboxInTransaction(tx,m,m.name), subject:m.subject });
      const ownerId = people.find(p=>p.subject===v.organizer.subject)!.id;
      const beforeResult = await tx.run('MATCH (u:User)-[:PARTICIPATES_IN]->(:Conversation {id:$id}) RETURN u.id AS id',{id});
      let before = beforeResult.records.map(r=>r.get('id') as string);
      await acquireContextAclLocks(tx,{userIds:[...before,...people.map(p=>p.id)],conversationId:id});
      const result = await tx.run(`MERGE (s:UnlinkedGroupSync {groupId:$groupId})
        ON CREATE SET s.ownerKey=$ownerKey,s.conversationId=$id,s.revision=0
        SET s.lockVersion=coalesce(s.lockVersion,0)+1
        RETURN s.ownerKey AS ownerKey,s.conversationId AS id,s.revision AS revision,s.fingerprint AS fingerprint,s.deleted AS deleted`,
      {groupId:v.groupId,ownerKey:JSON.stringify([v.organizer.issuer,v.organizer.subject]),id});
      const row=result.records[0];
      before=(await tx.run('MATCH(u:User)-[:PARTICIPATES_IN]->(:Conversation {id:$id}) RETURN u.id AS id',{id})).records.map(r=>r.get('id') as string);
      if(row.get('ownerKey')!==JSON.stringify([v.organizer.issuer,v.organizer.subject]) || row.get('id')!==id) throw new UnlinkedGroupError(409,'group_binding_conflict');
      const revision=Number(row.get('revision'));
      if(revision>v.revision || (row.get('deleted') && !v.deleted)) throw new UnlinkedGroupError(409,'stale_group_snapshot');
      if(revision===v.revision) {
        if(row.get('fingerprint')!==fingerprint) throw new UnlinkedGroupError(409,'group_revision_conflict');
        return {conversationId:id,revision:v.revision,added:[] as string[],removed:[] as string[],participants:before};
      }
      const existing=await tx.run('MATCH(c:Conversation {id:$id}) RETURN c.type AS type,c.unlinkedGroupId AS groupId,EXISTS {MATCH(:User {id:$ownerId})-[:PARTICIPATES_IN {role:"owner"}]->(c)} AS owned',{id,ownerId});
      if(existing.records.length && (existing.records[0].get('type')!=='group' || (existing.records[0].get('groupId') ? existing.records[0].get('groupId')!==v.groupId : !v.existingConversationId || !existing.records[0].get('owned')))) throw new UnlinkedGroupError(409,'conversation_binding_conflict');
      await tx.run(`MERGE(c:Conversation {id:$id}) ON CREATE SET c.createdAt=datetime(),c.type='group'
        SET c.title=$name,c.unlinkedGroupId=$groupId,c.updatedAt=datetime()`,{id,name:v.name,groupId:v.groupId});
      const ids=v.deleted?[]:people.map(p=>p.id);
      await tx.run(`MATCH(u:User)-[p:PARTICIPATES_IN]->(c:Conversation {id:$id}) WHERE NOT u.id IN $ids DELETE p`,{id,ids});
      await tx.run(`MATCH(c:Conversation {id:$id}) UNWIND $ids AS userId MATCH(u:User {id:userId})
        MERGE(u)-[p:PARTICIPATES_IN]->(c) ON CREATE SET p.joinedAt=datetime()
        SET p.role=CASE WHEN userId=$ownerId THEN 'owner' ELSE 'member' END`,{id,ids,ownerId});
      // Old invite URLs cannot add people outside the community roster.
      await tx.run(`MATCH(:Conversation {id:$id})-[:HAS_INVITE]->(i:GroupInvite) SET i.revokedAt=coalesce(i.revokedAt,$now)`,{id,now:new Date().toISOString()});
      await tx.run(`MATCH(s:UnlinkedGroupSync {groupId:$groupId}) SET s.revision=$revision,s.fingerprint=$fingerprint,s.deleted=$deleted,s.syncedAt=datetime()`,
        {groupId:v.groupId,revision:neo4j.int(v.revision),fingerprint,deleted:v.deleted});
      return {conversationId:id,revision:v.revision,added:ids.filter(x=>!before.includes(x)),removed:before.filter(x=>!ids.includes(x)),participants:ids};
    });
  } finally { await session.close(); }
}
