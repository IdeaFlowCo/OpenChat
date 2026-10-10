import { nanoid } from 'nanoid';
import type { ManagedTransaction, Session } from 'neo4j-driver';
import { acquireContextAclLocks } from './contextAccess.js';
import { ContextLaneError } from './contextLane.js';
import { reconcileIntentionLifecycle } from './contextIntentions.js';

export type ProfileVisibility = 'private' | 'selected' | 'public';
export interface ProfileAskInput {
  text: string; visibility: ProfileVisibility; expiresAt: string;
  userIds: string[]; conversationIds: string[];
}
export interface ProfileAsk {
  id: string; text: string; expiresAt: string; kind: 'ask';
  revision?: number; visibility?: ProfileVisibility; status?: string;
  userIds?: string[]; conversationIds?: string[];
}
export const ASK_ID = /^[A-Za-z0-9_-]{1,80}$/;
const numeric = (value: any) => Number(value?.toNumber?.() ?? value ?? 0);
const date = (value: any) => value?.toString() ?? '';
export function parseProfileAskInput(input: any): ProfileAskInput {
  if (!input || Array.isArray(input) || Object.keys(input).some(k => !['text','visibility','expiresAt','userIds','conversationIds','expectedRevision'].includes(k))) throw new ContextLaneError(400, 'Unsupported ask fields');
  if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 2000 || !['private','selected','public'].includes(input.visibility)) throw new ContextLaneError(400, 'Write an ask and choose its visibility');
  if (typeof input.expiresAt !== 'string' || !Number.isFinite(Date.parse(input.expiresAt)) || Date.parse(input.expiresAt) <= Date.now() || Date.parse(input.expiresAt) > Date.now() + 366 * 86400000) throw new ContextLaneError(400, 'Choose an expiry within the next year');
  const ids = (v: unknown) => Array.isArray(v) && v.length <= 100 && v.every(id => typeof id === 'string' && ASK_ID.test(id)) && new Set(v).size === v.length;
  if (!ids(input.userIds) || !ids(input.conversationIds)) throw new ContextLaneError(400, 'Invalid audience');
  if (input.visibility === 'selected' && !input.userIds.length && !input.conversationIds.length) throw new ContextLaneError(400, 'Select at least one person or group');
  if (input.visibility !== 'selected' && (input.userIds.length || input.conversationIds.length)) throw new ContextLaneError(400, 'Only selected visibility accepts an audience');
  return { text: input.text.trim(), visibility: input.visibility, expiresAt: new Date(input.expiresAt).toISOString(), userIds: input.userIds, conversationIds: input.conversationIds };
}
function projection(s: any, owner: boolean): ProfileAsk {
  const ask: ProfileAsk = { id: s.id, kind: 'ask', text: s.text, expiresAt: date(s.storyExpiresAt) };
  return owner ? { ...ask, revision: numeric(s.profileRevision), visibility: s.profileVisibility ?? 'selected', status: s.status,
    userIds: s.audienceUserIds ?? [], conversationIds: s.audienceConversationIds ?? [] } : ask;
}
// Kept in the same Story permission boundary as OpenChat's feed. An empty DM
// is not a friendship grant; selected conversations require BOTH live members.
export const PROFILE_STORY_VISIBILITY = `
  NOT EXISTS { MATCH (owner)-[:BLOCKED]-(:User {id:$viewerId}) }
  AND (owner.id = $viewerId
    OR (story.showOnProfile = true AND story.profileVisibility = 'public')
    OR (coalesce(story.profileVisibility,'selected') <> 'private' AND (
      $viewerId IN coalesce(story.audienceUserIds, [])
      OR EXISTS { MATCH (owner)-[:PARTICIPATES_IN]->(room:Conversation)<-[:PARTICIPATES_IN]-(:User {id:$viewerId})
        WHERE room.id IN coalesce(story.audienceConversationIds, []) }
    )))`;
export async function listProfileAsks(session: Session, ownerId: string, viewerId: string | null, askId: string | null = null) {
  if (askId !== null && (typeof askId !== 'string' || !ASK_ID.test(askId))) throw new ContextLaneError(400, 'Invalid ask');
  return session.executeRead(async tx => {
    const owner = ownerId === viewerId;
    const active = "story.status='active' AND story.storyExpiresAt>datetime($now) AND coalesce(intent.lifecycleState,CASE WHEN intent.status='withdrawn' THEN 'withdrawn' ELSE 'open' END)='open'";
    const query = `MATCH (owner:User {id:$ownerId})-[:OWNS_STORY]->(story:OpenChatStory)-[:ACTIVATES]->(intent:AgentIntent {kind:'ask'})
      WHERE story.showOnProfile=true AND story.humanVisible=true AND story.profileRemovedAt IS NULL
        AND ($askId IS NULL OR story.id=$askId)
        AND (${PROFILE_STORY_VISIBILITY})`;
    const params = { ownerId, viewerId, askId, now: new Date().toISOString() };
    const rows = await tx.run(`${query} AND (${active}) RETURN story ORDER BY story.createdAt DESC,story.id DESC${owner ? '' : ' LIMIT 50'}`, params);
    const history = owner ? await tx.run(`${query} AND NOT coalesce((${active}),false) RETURN story ORDER BY story.createdAt DESC,story.id DESC LIMIT 50`, params) : null;
    return [...rows.records, ...(history?.records ?? [])].map(r => projection(r.get('story').properties, owner));
  });
}
export async function profileAskAudience(session: Session, userId: string) {
  return session.executeRead(async tx => {
    const people = await tx.run(`MATCH (owner:User {id:$userId}),(connection:OpenChatConnection {state:'accepted'})
      WHERE connection.firstId=$userId OR connection.secondId=$userId
      MATCH (u:User) WHERE u.id=CASE WHEN connection.firstId=$userId THEN connection.secondId ELSE connection.firstId END
        AND NOT EXISTS { MATCH (owner)-[:BLOCKED]-(u) } RETURN DISTINCT u.id AS id,u.name AS name ORDER BY name LIMIT 100`, { userId });
    const groups = await tx.run(`MATCH (owner:User {id:$userId})-[:PARTICIPATES_IN]->(c:Conversation)
      WHERE c.type='group' RETURN c.id AS id,coalesce(c.name,c.title,'Group') AS name ORDER BY name LIMIT 100`, { userId });
    const dto = (rows: any) => rows.records.map((r: any) => ({ id: r.get('id'), name: r.get('name') || 'Unnamed' }));
    return { people: dto(people), groups: dto(groups) };
  });
}
async function validateAudience(tx: ManagedTransaction, userId: string, input: ProfileAskInput) {
  for (const conversationId of [...input.conversationIds].sort()) await acquireContextAclLocks(tx, { conversationId });
  const result = await tx.run(`MATCH (owner:User {id:$userId})
    OPTIONAL MATCH (u:User) WHERE u.id IN $userIds AND NOT EXISTS { MATCH (owner)-[:BLOCKED]-(u) }
    WITH owner,collect(DISTINCT u.id) AS users
    OPTIONAL MATCH (owner)-[:PARTICIPATES_IN]->(c:Conversation) WHERE c.id IN $conversationIds
    RETURN size(users) AS users,count(DISTINCT c) AS rooms`, { userId, userIds: input.userIds, conversationIds: input.conversationIds });
  if (result.records.length !== 1 || numeric(result.records[0].get('users')) !== input.userIds.length || numeric(result.records[0].get('rooms')) !== input.conversationIds.length) throw new ContextLaneError(400, 'Audience is no longer available');
}
// Callers hold the canonical owner ACL lock before checking an activation.
export async function profileAskActiveCount(tx: ManagedTransaction, userId: string, excludingId: string | null = null, now = new Date().toISOString()) {
  const quota = await tx.run(`MATCH (:User {id:$userId})-[:OWNS_STORY]->(s:OpenChatStory)
    WHERE s.showOnProfile=true AND s.profileRemovedAt IS NULL AND s.status='active' AND s.storyExpiresAt>datetime($now)
      AND ($excludingId IS NULL OR s.id<>$excludingId) RETURN count(s) AS count`, { userId, excludingId, now });
  return numeric(quota.records[0].get('count'));
}
export async function publishProfileAsk(session: Session, userId: string, raw: unknown) {
  const input = parseProfileAskInput(raw);
  return session.executeWrite(async tx => {
    await acquireContextAclLocks(tx, { userIds: [userId, ...input.userIds] });
    await validateAudience(tx, userId, input);
    if (await profileAskActiveCount(tx, userId) >= 50) throw new ContextLaneError(429, 'Close an ask before adding another');
    const id = nanoid(), intentId = nanoid(), now = new Date().toISOString();
    const rows = await tx.run(`MATCH (owner:User {id:$userId})
      CREATE (intent:AgentIntent {id:$intentId,ownerUserId:$userId,kind:'ask',terms:$text,goal:$text,seeks:[$text],brings:[],
        status:'paused',contextOnly:true,lifecycleState:'open',lifecycleRevision:0,audienceRestricted:true,audienceUserIds:[],audienceConversationIds:[],
        expiresAt:datetime($expiresAt),createdAt:datetime($now),updatedAt:datetime($now)})
      CREATE (story:OpenChatStory {id:$id,ownerUserId:$userId,intentId:$intentId,text:$text,goal:$text,seeks:[$text],brings:[],
        matchingMode:'fulfillment',openToCollaborators:false,humanVisible:true,agentSearchEnabled:false,explicitQuietSearch:false,
        showOnProfile:true,profileCreated:true,profileVisibility:$visibility,profileRevision:1,status:'active',audienceUserIds:$userIds,audienceConversationIds:$conversationIds,
        storyExpiresAt:datetime($expiresAt),searchExpiresAt:datetime($expiresAt),createdAt:datetime($now),updatedAt:datetime($now)})
      CREATE (owner)-[:OWNS_STORY]->(story) CREATE (owner)-[:OWNS_INTENT]->(intent) CREATE (story)-[:ACTIVATES]->(intent) RETURN story`,
      { ...input, userId, id, intentId, now });
    if (!rows.records.length) throw new ContextLaneError(404, 'Owner unavailable');
    return projection(rows.records[0].get('story').properties, true);
  });
}
export async function mutateProfileAsk(session: Session, userId: string, id: string, operation: 'edit'|'close'|'remove', raw: any) {
  if (typeof id !== 'string' || !ASK_ID.test(id) || !raw || !Number.isSafeInteger(raw.expectedRevision) || raw.expectedRevision < 0) throw new ContextLaneError(400, 'Reload before updating this ask');
  const input = operation === 'edit' ? parseProfileAskInput(raw) : null;
  if (!input && Object.keys(raw).some(k => k !== 'expectedRevision')) throw new ContextLaneError(400, 'Unsupported lifecycle fields');
  return session.executeWrite(async tx => {
    await acquireContextAclLocks(tx, { userIds: [userId, ...(input?.userIds ?? [])] });
    const rows = await tx.run(`MATCH (:User {id:$userId})-[:OWNS_STORY]->(s:OpenChatStory {id:$id})-[:ACTIVATES]->(i:AgentIntent {kind:'ask'})
      WHERE s.showOnProfile=true AND s.profileRemovedAt IS NULL
      SET s.profileLock=coalesce(s.profileLock,0)+1 RETURN s,i`, { userId, id });
    if (!rows.records.length) throw new ContextLaneError(404, 'Ask not found');
    const s = rows.records[0].get('s').properties, i = rows.records[0].get('i').properties;
    if (numeric(s.profileRevision) !== raw.expectedRevision) throw new ContextLaneError(409, 'This ask changed. Reload before saving');
    const now = new Date().toISOString();
    if (input) {
      if (s.status !== 'active' || (i.lifecycleState && i.lifecycleState !== 'open') || i.status === 'withdrawn') throw new ContextLaneError(409, 'Closed asks cannot be republished');
      await validateAudience(tx, userId, input);
      if (await profileAskActiveCount(tx, userId, id, now) >= 50) throw new ContextLaneError(429, 'Close an ask before activating another');
      // Only explicitly approved text changes. Profile-created canonical terms follow
      // the edit; existing private matching terms and Context excerpts stay separate.
      await tx.run(`MATCH (s:OpenChatStory {id:$id}) SET s.text=$text,s.profileVisibility=$visibility,s.audienceUserIds=$userIds,
        s.audienceConversationIds=$conversationIds,s.storyExpiresAt=datetime($expiresAt),s.profileRevision=coalesce(s.profileRevision,0)+1,s.updatedAt=datetime($now)
        WITH s MATCH (s)-[:ACTIVATES]->(i:AgentIntent)
        FOREACH (_ IN CASE WHEN s.profileCreated=true THEN [1] ELSE [] END | SET s.goal=$text,s.seeks=[$text],i.goal=$text,i.terms=$text,i.seeks=[$text],i.updatedAt=datetime($now),i.lifecycleRevision=coalesce(i.lifecycleRevision,0)+1)
        WITH i OPTIONAL MATCH (p:Thought)-[:REPRESENTS_INTENT]->(i)
        FOREACH (_ IN CASE WHEN p IS NULL THEN [] ELSE [1] END | SET p.intentionSourceChanged=true,p.intentionRevision=i.lifecycleRevision)`, { ...input, id, now });
    } else {
      await reconcileIntentionLifecycle(tx, i.id, operation === 'close' ? 'fulfilled' : 'withdrawn', now);
      await tx.run(`MATCH (s:OpenChatStory {id:$id}) SET s.profileRemovedAt=CASE WHEN $removed THEN datetime($now) ELSE s.profileRemovedAt END,s.updatedAt=datetime($now)`, { id, removed: operation === 'remove', now });
    }
    const updated = await tx.run('MATCH (s:OpenChatStory {id:$id}) RETURN s', { id });
    return projection(updated.records[0].get('s').properties, true);
  });
}
