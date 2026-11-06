import { askPublicationReviewMatches, clearAskPublicationReview, completeAskPublicationReview, rememberAskPublicationReview } from './askPublicationReviews.js';
import { getAskPublication, publishAsk, revokeAskPublication } from './askPublications.js';
/** Canonical personal asks. All authority and source IDs come from the server turn. */
import type Anthropic from '@anthropic-ai/sdk';
import { getDriver } from '../db.js';
import { assistantTextForMessage } from './assistantContext.js';
import { getAsk, listAsks, saveAsk, updateAsk } from './privateGraph.js';
import type { MessageBoundary } from './messageBoundary.js';

export const ASK_TOOLS: Anthropic.Tool[] = [
  { name: 'publish_ask', description: 'Prepare or commit durable public or selected-account profile visibility for an already saved OWN ask. First confirm:false returns exact text, audience names and approvalGrant; show that review and wait for explicit approval, then repeat identical payload with confirm:true and grant. Never grants matching, sends or notifies. Names/emails are not ACL targets; resolve exact account/profile IDs first. Private sources remain private.', input_schema: { type: 'object', properties: { askId: { type: 'string' }, requestId: { type: 'string' }, expectedAskRevision: { type: 'integer' }, expectedPublicationRevision: { type: ['integer','null'] }, text: { type: 'string' }, audience: { type: 'object', properties: { kind: { type: 'string', enum: ['public','people'] }, targets: { type: 'array', maxItems: 20, items: { type: 'object', properties: { kind: { type: 'string', enum: ['openchat_user','unlinked_profile'] }, id: { type: 'string' } }, required: ['kind','id'] } } }, required: ['kind'] }, confirm: { type: 'boolean' }, approvalGrant: { type: 'string' } }, required: ['askId','requestId','expectedAskRevision','expectedPublicationRevision','text','audience','confirm'] } },
  { name: 'get_ask_publication', description: 'Read the authenticated owner’s current ask publication and compare it with the private source revision. Does not publish.', input_schema: { type: 'object', properties: { askId: { type: 'string' } }, required: ['askId'] } },
  { name: 'revoke_ask_publication', description: 'Revoke a durable ask publication without deleting the private ask. Narrows access immediately on subsequent reads. Does not retract previously read/downloaded text.', input_schema: { type: 'object', properties: { askId: { type: 'string' }, expectedPublicationRevision: { type: 'integer' } }, required: ['askId','expectedPublicationRevision'] } },
  { name: 'save_ask', description: 'Save an explicitly requested personal need immediately in the canonical owner inventory (Profile → All asks). Saving is private; audienceIntent preserves Public or a named person without publishing, sending, assigning a carrier, or activating matching. itemIndex is the stable zero-based position of the distinct ask within its ORIGINAL ask-bearing source message, never its order in the latest follow-up; reuse on retries. Return the saved ID and actual access. Existing author/text returns unchanged; use update_ask explicitly for edits.', input_schema: { type: 'object', properties: {
    text: { type: 'string', maxLength: 1000 }, itemIndex: { type: 'integer', minimum: 0, maximum: 99 },
    excerpt: { type: 'string', description: 'Short exact excerpt containing the ask from this user’s current or earlier message in this conversation.' },
    sourceMessageId: { type: 'string', description: 'Optional exact source ID from prior tool evidence; never invent. Otherwise the server resolves a unique matching owner-authored excerpt before/current turn.' },
    audienceIntent: { type: 'string', description: 'Audience the user requested, e.g. Public, Only Vlad, or Only me. This grants no access.' },
    exposure: { type: 'string', enum: ['only_me', 'friends', 'public'] },
    horizon: { type: 'string', enum: ['event', 'short', 'medium', 'evergreen'] }, recheckAfter: { type: 'string', description: 'ISO instant or date; resolve relative dates against the source message date.' },
  }, required: ['text', 'itemIndex', 'excerpt', 'audienceIntent'] } },
  { name: 'list_asks', description: 'Read the authenticated owner’s canonical asks, including fulfilled/withdrawn with status all. An audience intent is not publication. truncated means this is a partial inventory; narrow filters to find more.', input_schema: { type: 'object', properties: { status: { type: 'string' }, direction: { type: 'string', enum: ['from_me', 'for_me', 'from_others'] }, q: { type: 'string' }, limit: { type: 'integer', maximum: 200 } } } },
  { name: 'get_ask', description: 'Read one of the authenticated owner’s canonical asks with source receipts and current lifecycle.', input_schema: { type: 'object', properties: { askId: { type: 'string' } }, required: ['askId'] } },
  { name: 'update_ask', description: 'Explicitly edit a canonical ask or mark fulfilled/withdrawn/stale/open. Saving a retry never reopens it. Exposure is audience intent only and does not publish. Original source receipts remain intact.', input_schema: { type: 'object', properties: { askId: { type: 'string' }, text: { type: 'string' }, status: { type: 'string', enum: ['open', 'stale', 'fulfilled', 'withdrawn'] }, exposure: { type: 'string', enum: ['only_me', 'friends', 'public'] }, recheckedNow: { type: 'boolean' } }, required: ['askId'] } },
];
const publicationAccess = (ask: Awaited<ReturnType<typeof getAsk>>) => ask.publication?.state === 'active' ? ask.publication.audienceKind === 'public' ? 'public' : 'selected_people' : 'owner_only';
const by = { author: 'agent:OpenChat', source: 'app', assertion: 'stated' } as const;
export async function executeAskTool(ownerId: string, name: string, input: Record<string, unknown>, boundary?: MessageBoundary): Promise<unknown> {
  if (name === 'get_ask_publication') return getAskPublication(ownerId, String(input.askId ?? ''));
  if (name === 'publish_ask') {
    if (!boundary) return { error:'An authenticated user turn is required for publication review' };
    const db=getDriver().session();
    try {
      const origin=await db.run(`MATCH (:User {id:$ownerId})-[:PARTICIPATES_IN]->(c:Conversation {id:$conversationId})
        MATCH (m:Message {id:$messageId,conversationId:c.id,senderId:$ownerId})
        WHERE m.deletedAt IS NULL AND (m.assistantScope IS NULL OR m.assistantScope='universal') RETURN m.id AS id`,{ownerId,...boundary});
      if(!origin.records[0])return {error:'Originating publication request is unavailable'};
    } finally {await db.close();}
    if(input.confirm===true&&!askPublicationReviewMatches(ownerId,boundary.conversationId,boundary.messageId,input))return {error:'Publication needs its exact pending review and explicit approval on a later user turn. Prepare a fresh review if it expired or changed.'};
    const {askId,...payload}=input;
    const result=await publishAsk(ownerId,`${ownerId}:assistant`,String(askId??''),payload);
    if('approvalGrant' in result&&typeof result.approvalGrant==='string')rememberAskPublicationReview(ownerId,boundary.conversationId,boundary.messageId,input,result.approvalGrant,result.preview);
    if('publication' in result)completeAskPublicationReview(ownerId,boundary.conversationId,askId);
    return result;
  }
  if (name === 'revoke_ask_publication') {
    const result=await revokeAskPublication(ownerId,String(input.askId??''),input.expectedPublicationRevision);
    if(boundary)clearAskPublicationReview(ownerId,boundary.conversationId,input.askId);
    return result;
  }
  if (name === 'list_asks') return listAsks(ownerId, { status: input.status ?? 'all', direction: input.direction, q: input.q, limit: input.limit });
  if (name === 'get_ask') return { ask: await getAsk(ownerId, String(input.askId ?? '')) };
  if (name === 'update_ask') {
    const { askId, text, status, exposure, recheckedNow } = input;
    const patch = Object.fromEntries(Object.entries({ text, status, exposure, recheckedNow }).filter(([, value]) => value !== undefined));
    const ask = await updateAsk(ownerId, String(askId ?? ''), patch, by);
    return { ask, publication: publicationAccess(ask), privateWriteOnly: true };
  }
  if (name !== 'save_ask' || !boundary) return { error: 'An authenticated originating message is required to save an ask' };
  if (typeof input.excerpt !== 'string' || !input.excerpt.trim()) return { error: 'An exact source excerpt is required' };
  const db = getDriver().session();
  let sourceText = '';
  let sourceMessageId: string | null = null;
  let sourceCreatedAt: string | null = null;
  try {
    const result = await db.run(`MATCH (:User {id:$ownerId})-[:PARTICIPATES_IN]->(c:Conversation {id:$conversationId})
      MATCH (origin:Message {id:$messageId, conversationId:c.id, senderId:$ownerId})
      WHERE origin.deletedAt IS NULL AND (origin.assistantScope IS NULL OR origin.assistantScope = 'universal')
      MATCH (m:Message {conversationId:c.id, senderId:$ownerId})
      WHERE m.deletedAt IS NULL AND (m.id = origin.id OR m.createdAt < origin.createdAt)
      WITH m ORDER BY m.createdAt DESC LIMIT 30
      WITH m WHERE ($sourceMessageId IS NULL OR m.id = $sourceMessageId)
        AND (coalesce(m.content, '') CONTAINS $excerpt OR coalesce(m.transcript, '') CONTAINS $excerpt)
      RETURN m.id AS id, m.content AS content, m.transcript AS transcript, m.attachments AS attachments, m.createdAt AS createdAt
      ORDER BY m.createdAt DESC LIMIT 2`, { ownerId, ...boundary, sourceMessageId: typeof input.sourceMessageId === 'string' ? input.sourceMessageId : null, excerpt: input.excerpt });
    const row = result.records[0];
    if (!row) return { error: 'Source excerpt is unavailable in this user’s authorized messages before this turn' };
    if (result.records.length > 1) return { error: 'The excerpt matches multiple messages. Use a longer exact excerpt or a verified sourceMessageId.' };
    sourceMessageId = String(row.get('id'));
    sourceCreatedAt = row.get('createdAt') == null ? null : String(row.get('createdAt'));
    sourceText = assistantTextForMessage({ content: row.get('content'), transcript: row.get('transcript'), attachments: row.get('attachments') });
  } finally { await db.close(); }
  if (typeof input.excerpt !== 'string' || !input.excerpt.trim() || !sourceText.includes(input.excerpt)) return { error: 'excerpt must be an exact part of the originating message' };
  const result = await saveAsk(ownerId, {
    author: 'self', text: input.text,
    ...(input.exposure !== undefined ? { exposure: input.exposure } : {}),
    ...(input.horizon !== undefined ? { horizon: input.horizon } : {}),
    ...(input.recheckAfter !== undefined ? { recheckAfter: input.recheckAfter } : {}),
    sourceReceipt: { app: 'openchat', ...boundary, sourceMessageId, sourceCreatedAt, itemIndex: input.itemIndex, excerpt: input.excerpt, assertion: 'stated', audienceIntent: input.audienceIntent },
  }, by);
  return { ...result, publication: publicationAccess(result.ask), delivery: 'none', matching: 'inactive', ...(result.created ? {} : { notice: 'Existing ask returned; fields are unchanged. New source evidence is appended. Use update_ask for an explicit edit.' }) };
}
