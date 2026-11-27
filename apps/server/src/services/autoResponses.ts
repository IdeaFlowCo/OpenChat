/**
 * Owner auto-response rules (v1).
 *
 * An owner writes rules: when I'm away / for these people / about these
 * topics → reply with fixed text, or let my OpenChat agent draft a reply.
 * DRAFT for the owner's approval is the default; auto-send is an explicit
 * per-rule opt-in. Anything sent automatically is labelled for the other side.
 *
 * Applies to direct chats in v1 (like Secretary). Never fires on bots, on the
 * owner's own messages, or on any automatic message (loop guard). Agent drafts
 * use the same shared-only context and the same per-owner monthly cap as
 * "Ask {name}'s agent".
 */
import { nanoid } from 'nanoid';
import type { Driver, Session } from 'neo4j-driver';
import type { Server as IOServer } from 'socket.io';
import { normalizePublicDisplayName } from '../privacy/profilePrivacy.js';
import { acquireContextAclLocks } from './contextAccess.js';
import { generateMeteredReply, postAutomaticMessage, safeName, type ProfileAgentGenerator, ProfileAgentError } from './profileAgent.js';
import { dispatchMessageEvent } from './webhookDispatch.js';

export type RuleAction = 'reply' | 'agent';
export type RuleDelivery = 'draft' | 'send';
export interface AutoResponseRule {
  id: string;
  enabled: boolean;
  whenAway: boolean;
  fromUserIds: string[];
  topics: string[];
  action: RuleAction;
  replyText: string | null;
  delivery: RuleDelivery;
  createdAt: string;
  updatedAt: string;
}
export interface AutoResponseDraft {
  id: string; conversationId: string; sourceMessageId: string; ruleId: string; text: string; action: RuleAction;
  senderName: string; sourceText: string; createdAt: string; expiresAt: string;
}

export const MAX_RULES = 10;
export const COOLDOWN_MS = 6 * 3600_000;
const SENDING_LEASE_MS = 2 * 60_000;
const FAILURE_BACKOFF_MS = 15 * 60_000;
const DRAFT_TTL_MS = 24 * 3600_000;
const AWAY_STATUSES = new Set(['away', 'busy', 'invisible', 'offline']);

export class AutoResponseError extends Error { constructor(public statusCode: number, message: string) { super(message); } }

/** Validates owner input. Delivery defaults to draft; send must be chosen explicitly. */
export function normalizeRuleInput(input: unknown, existing?: Partial<AutoResponseRule>): Omit<AutoResponseRule, 'id' | 'createdAt' | 'updatedAt'> {
  if (!input || typeof input !== 'object') throw new AutoResponseError(400, 'Rule must be an object');
  const v = input as Record<string, unknown>;
  const pick = <T>(key: string, fallback: T): unknown => (key in v ? v[key] : fallback);
  const enabled = pick('enabled', existing?.enabled ?? true);
  const whenAway = pick('whenAway', existing?.whenAway ?? false);
  if (typeof enabled !== 'boolean' || typeof whenAway !== 'boolean') throw new AutoResponseError(400, 'enabled and whenAway must be booleans');
  const strings = (value: unknown, label: string, max: number, maxLen: number) => {
    if (!Array.isArray(value) || value.length > max || value.some(item => typeof item !== 'string' || !item.trim() || item.length > maxLen)) {
      throw new AutoResponseError(400, `${label} must be up to ${max} non-empty strings of at most ${maxLen} characters`);
    }
    return [...new Set((value as string[]).map(item => item.trim()))];
  };
  const fromUserIds = strings(pick('fromUserIds', existing?.fromUserIds ?? []), 'fromUserIds', 50, 200);
  const topics = strings(pick('topics', existing?.topics ?? []), 'topics', 10, 40);
  const action = pick('action', existing?.action ?? 'reply');
  if (action !== 'reply' && action !== 'agent') throw new AutoResponseError(400, 'action must be reply or agent');
  const delivery = pick('delivery', existing?.delivery ?? 'draft');
  if (delivery !== 'draft' && delivery !== 'send') throw new AutoResponseError(400, 'delivery must be draft or send');
  const rawText = pick('replyText', existing?.replyText ?? null);
  if (rawText !== null && (typeof rawText !== 'string' || rawText.length > 1000)) throw new AutoResponseError(400, 'replyText must be at most 1000 characters');
  const replyText = typeof rawText === 'string' && rawText.trim() ? rawText.trim() : null;
  if (action === 'reply' && !replyText) throw new AutoResponseError(400, 'A fixed reply needs replyText');
  if (!whenAway && !fromUserIds.length && !topics.length) {
    throw new AutoResponseError(400, 'Choose at least one condition: when away, from these people, or about these topics');
  }
  return { enabled, whenAway, fromUserIds, topics, action, replyText, delivery };
}

/** First enabled rule whose every set condition holds. */
export function matchRule(rules: AutoResponseRule[], input: { senderId: string; content: string; ownerAway: boolean }): AutoResponseRule | null {
  const text = input.content.toLowerCase();
  return [...rules].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).find(rule =>
    rule.enabled
    && (!rule.whenAway || input.ownerAway)
    && (!rule.fromUserIds.length || rule.fromUserIds.includes(input.senderId))
    && (!rule.topics.length || rule.topics.some(topic => text.includes(topic.toLowerCase()))),
  ) ?? null;
}

export const automaticLabel = (ownerName: string) => { const n = safeName(ownerName); return `🤖 Automatic reply · ${n}'s OpenChat agent, not ${n}`; };
/** Approved drafts: an agent-written draft says so; the owner's own fixed text is an approved auto-reply. */
export const approvedDraftLabel = (ownerName: string, action: RuleAction = 'agent') => {
  const n = safeName(ownerName);
  return action === 'agent' ? `🤖 Drafted by ${n}'s OpenChat agent · approved by ${n}` : `🤖 Auto-reply · approved by ${n}`;
};

const fromNode = (p: Record<string, any>): AutoResponseRule => ({
  id: p.id, enabled: p.enabled !== false, whenAway: p.whenAway === true, fromUserIds: p.fromUserIds ?? [], topics: p.topics ?? [],
  action: p.action === 'agent' ? 'agent' : 'reply', replyText: p.replyText ?? null, delivery: p.delivery === 'send' ? 'send' : 'draft',
  createdAt: String(p.createdAt), updatedAt: String(p.updatedAt),
});

// ── Owner settings and rules ────────────────────────────────────────────────
export async function listRules(session: Session, ownerId: string): Promise<AutoResponseRule[]> {
  const r = await session.run(`MATCH (:User {id:$ownerId})-[:OWNS_AUTO_RESPONSE_RULE]->(rule:AutoResponseRule) RETURN properties(rule) AS rule ORDER BY rule.createdAt`, { ownerId });
  return r.records.map(row => fromNode(row.get('rule')));
}
export async function createRule(session: Session, ownerId: string, input: unknown) {
  const rule = normalizeRuleInput(input);
  const now = new Date().toISOString();
  return session.executeWrite(async tx => {
    await acquireContextAclLocks(tx, { userIds: [ownerId] });
    const count = await tx.run(`MATCH (:User {id:$ownerId})-[:OWNS_AUTO_RESPONSE_RULE]->(r) RETURN count(r) AS n`, { ownerId });
    if (Number(count.records[0]?.get('n')?.toNumber?.() ?? 0) >= MAX_RULES) throw new AutoResponseError(400, `At most ${MAX_RULES} rules`);
    const r = await tx.run(`MATCH (u:User {id:$ownerId})
      CREATE (u)-[:OWNS_AUTO_RESPONSE_RULE]->(rule:AutoResponseRule {id:$id, ownerId:$ownerId, createdAt:$now, updatedAt:$now})
      SET rule += $rule RETURN properties(rule) AS rule`, { ownerId, id: nanoid(), now, rule });
    if (!r.records.length) throw new AutoResponseError(404, 'Account not found');
    return fromNode(r.records[0]!.get('rule'));
  });
}
export async function updateRule(session: Session, ownerId: string, id: string, input: unknown) {
  return session.executeWrite(async tx => {
    const found = await tx.run(`MATCH (:User {id:$ownerId})-[:OWNS_AUTO_RESPONSE_RULE]->(rule:AutoResponseRule {id:$id}) RETURN properties(rule) AS rule`, { ownerId, id });
    if (!found.records.length) throw new AutoResponseError(404, 'Rule not found');
    const rule = normalizeRuleInput(input, fromNode(found.records[0]!.get('rule')));
    const r = await tx.run(`MATCH (:User {id:$ownerId})-[:OWNS_AUTO_RESPONSE_RULE]->(rule:AutoResponseRule {id:$id})
      SET rule += $rule, rule.updatedAt=$now RETURN properties(rule) AS rule`, { ownerId, id, rule, now: new Date().toISOString() });
    return fromNode(r.records[0]!.get('rule'));
  });
}
export async function deleteRule(session: Session, ownerId: string, id: string) {
  const r = await session.run(`MATCH (:User {id:$ownerId})-[:OWNS_AUTO_RESPONSE_RULE]->(rule:AutoResponseRule {id:$id}) DETACH DELETE rule RETURN count(*) AS n`, { ownerId, id });
  if (!Number(r.records[0]?.get('n')?.toNumber?.() ?? 0)) throw new AutoResponseError(404, 'Rule not found');
}
export async function setProfileAgentEnabled(session: Session, ownerId: string, enabled: unknown) {
  if (typeof enabled !== 'boolean') throw new AutoResponseError(400, 'enabled must be a boolean');
  const r = await session.run(`MATCH (u:User {id:$ownerId}) SET u.profileAgentEnabled=$enabled RETURN u.profileAgentEnabled AS enabled`, { ownerId, enabled });
  if (!r.records.length) throw new AutoResponseError(404, 'Account not found');
  return { enabled: r.records[0]!.get('enabled') === true };
}

// ── Drafts ──────────────────────────────────────────────────────────────────
export async function listDrafts(session: Session, ownerId: string, conversationId?: string): Promise<AutoResponseDraft[]> {
  const r = await session.run(`
    MATCH (d:AutoResponseDraft {ownerId:$ownerId}) WHERE (d.status='pending' OR (d.status='sending' AND coalesce(d.sendingAt,'') < $stale)) AND d.expiresAt > $now AND ($conversationId IS NULL OR d.conversationId=$conversationId)
    MATCH (:User {id:$ownerId})-[:PARTICIPATES_IN]->(:Conversation {id:d.conversationId})
    MATCH (source:Message {id:d.sourceMessageId}) WHERE source.deletedAt IS NULL
    OPTIONAL MATCH (sender:User {id:source.senderId})
    RETURN d { .id,.conversationId,.sourceMessageId,.ruleId,.text,.action,.createdAt,.expiresAt } AS draft,
      sender.name AS senderName, left(source.content,300) AS sourceText
    ORDER BY d.createdAt DESC LIMIT 50`, { ownerId, conversationId: conversationId ?? null, now: new Date().toISOString(), stale: new Date(Date.now() - SENDING_LEASE_MS).toISOString() });
  return r.records.map(row => ({ ...row.get('draft'), senderName: normalizePublicDisplayName(row.get('senderName')), sourceText: row.get('sourceText') ?? '' }));
}

export async function discardDraft(session: Session, ownerId: string, id: string) {
  const r = await session.run(`MATCH (d:AutoResponseDraft {id:$id, ownerId:$ownerId, status:'pending'}) SET d.status='discarded' RETURN d.id AS id`, { ownerId, id });
  if (!r.records.length) throw new AutoResponseError(404, 'Draft not found');
}

/** The owner approves exact (optionally edited) text; the recipient sees an approved-draft label. */
export async function sendDraft(driver: Driver, ownerId: string, id: string, text: unknown, broadcast?: (conversationId: string, message: unknown) => Promise<void>) {
  if (typeof text !== 'string' || !text.trim() || text.length > 2000) throw new AutoResponseError(400, 'Text must contain 1–2000 characters');
  const session = driver.session();
  let draft: { conversationId: string; sourceMessageId: string; action: RuleAction; ownerName: string } | undefined;
  try {
    draft = await session.executeWrite(async tx => {
      // A send interrupted mid-way (crash, lock timeout) becomes claimable again after a short lease.
      const r = await tx.run(`MATCH (d:AutoResponseDraft {id:$id, ownerId:$ownerId})
        WHERE d.expiresAt > $now AND (d.status='pending' OR (d.status='sending' AND coalesce(d.sendingAt,'') < $stale))
        MATCH (u:User {id:$ownerId}) SET d.status='sending', d.sendingAt=$now RETURN d.conversationId AS c, d.sourceMessageId AS s, d.action AS a, u.name AS n`,
        { id, ownerId, now: new Date().toISOString(), stale: new Date(Date.now() - SENDING_LEASE_MS).toISOString() });
      if (!r.records.length) return undefined;
      const row = r.records[0]!;
      return { conversationId: row.get('c'), sourceMessageId: row.get('s'), action: row.get('a'), ownerName: normalizePublicDisplayName(row.get('n')) };
    });
  } finally { await session.close(); }
  if (!draft) throw new AutoResponseError(404, 'Draft not found or already handled');
  let posted: Awaited<ReturnType<typeof postAutomaticMessage>> = null;
  let alreadySent = false;
  try {
    posted = await postAutomaticMessage(driver, {
      ownerId, conversationId: draft.conversationId, replyToId: draft.sourceMessageId,
      content: `${approvedDraftLabel(draft.ownerName, draft.action)}\n\n${text.trim()}`,
      idempotencyKey: `auto-draft:${id}`,
      props: { viaAutoResponse: true, autoResponseApproved: true, autoResponseDraftId: id, autoResponseAction: draft.action },
    });
    if (!posted) {
      const check = driver.session();
      try { alreadySent = (await check.run(`MATCH (m:Message {automaticKey:$key}) RETURN m.id LIMIT 1`, { key: `auto-draft:${id}` })).records.length > 0; }
      finally { await check.close(); }
    }
  } finally {
    // Whatever happened, the draft never stays stuck in "sending".
    const done = driver.session();
    try { await done.run(`MATCH (d:AutoResponseDraft {id:$id}) SET d.status=$status`, { id, status: posted || alreadySent ? 'sent' : 'pending' }); }
    finally { await done.close(); }
  }
  if (!posted) throw new AutoResponseError(409, alreadySent ? 'This draft was already sent' : 'The chat or message changed; the draft was not sent');
  if (broadcast) await broadcast(draft.conversationId, posted.message);
  dispatchMessageEvent(posted.message, posted.participantIds);
  return posted.message;
}

// ── Trigger on incoming messages ────────────────────────────────────────────
export interface TriggerInput {
  driver: Driver; senderId: string; conversationId: string; sourceMessageId: string; content: string; io?: IOServer;
  isOnline: (userId: string) => boolean;
  broadcast: (io: IOServer, conversationId: string, message: unknown) => Promise<void>;
  generate?: ProfileAgentGenerator;
}

/** Returns what happened, for logs and tests. Never throws. */
export async function runAutoResponses(input: TriggerInput): Promise<'none' | 'sent' | 'drafted' | 'skipped'> {
  if (!input.content.trim()) return 'none';
  const session = input.driver.session();
  let claimKey: string | null = null;
  let finished = false;
  try {
    const found = await session.run(`
      MATCH (sender:User {id:$senderId})-[:PARTICIPATES_IN]->(c:Conversation {id:$conversationId, type:'direct'})
      MATCH (source:Message {id:$sourceMessageId, conversationId:c.id}) WHERE source.deletedAt IS NULL AND source.senderId = $senderId
        AND NOT coalesce(source.viaProfileAgent,false) AND NOT coalesce(source.viaAutoResponse,false) AND NOT coalesce(source.viaSecretary,false)
        AND NOT coalesce(sender.isBot,false)
      MATCH (owner:User)-[:PARTICIPATES_IN]->(c)
      WHERE owner.id <> $senderId AND NOT coalesce(owner.isBot,false) AND NOT EXISTS { MATCH (owner)-[:BLOCKED]-(sender) }
        // Prior contact: the owner has written here themselves, so strangers cannot trigger
        // paid drafts or learn whether the owner is away.
        AND EXISTS { MATCH (prior:Message {conversationId:c.id, senderId:owner.id}) WHERE prior.deletedAt IS NULL
          AND NOT coalesce(prior.viaAutoResponse,false) AND NOT coalesce(prior.viaProfileAgent,false) AND NOT coalesce(prior.viaSecretary,false) }
      MATCH (owner)-[:OWNS_AUTO_RESPONSE_RULE]->(rule:AutoResponseRule {enabled:true})
      RETURN owner.id AS ownerId, owner.name AS ownerName, owner.presenceStatus AS presence, collect(properties(rule)) AS rules LIMIT 1
    `, { senderId: input.senderId, conversationId: input.conversationId, sourceMessageId: input.sourceMessageId });
    const row = found.records[0];
    if (!row) return 'none';
    const ownerId = row.get('ownerId') as string;
    const ownerAway = !input.isOnline(ownerId) || AWAY_STATUSES.has(String(row.get('presence') ?? ''));
    const rule = matchRule((row.get('rules') as Record<string, unknown>[]).map(fromNode), { senderId: input.senderId, content: input.content, ownerAway });
    if (!rule) return 'none';
    const ownerName = safeName(row.get('ownerName'));

    // Claim this owner+chat for the cooldown window (re-creating a rule does not reset it).
    const now = new Date();
    const key = `${ownerId}:${input.sourceMessageId}`;
    const claimed = await session.executeWrite(async tx => {
      await acquireContextAclLocks(tx, { userIds: [ownerId] });
      const recent = await tx.run(`MATCH (e:AutoResponseEvent {ownerId:$ownerId, conversationId:$conversationId}) WHERE e.createdAt > $since RETURN count(e) AS n`,
        { ownerId, conversationId: input.conversationId, since: new Date(now.getTime() - COOLDOWN_MS).toISOString() });
      if (Number(recent.records[0]?.get('n')?.toNumber?.() ?? 0) > 0) return false;
      // Only a draft the owner can still act on (source not deleted) holds back new ones.
      const pending = await tx.run(`MATCH (d:AutoResponseDraft {ownerId:$ownerId, conversationId:$conversationId, status:'pending'}) WHERE d.expiresAt > $now
        AND EXISTS { MATCH (source:Message {id:d.sourceMessageId}) WHERE source.deletedAt IS NULL } RETURN count(d) AS n`,
        { ownerId, conversationId: input.conversationId, now: now.toISOString() });
      if (Number(pending.records[0]?.get('n')?.toNumber?.() ?? 0) > 0) return false;
      const created = await tx.run(`MERGE (e:AutoResponseEvent {key:$key}) ON CREATE SET e.ruleId=$ruleId, e.conversationId=$conversationId, e.ownerId=$ownerId, e.createdAt=$now, e.fresh=true
        ON MATCH SET e.fresh=false RETURN e.fresh AS fresh`, { key, ruleId: rule.id, conversationId: input.conversationId, ownerId, now: now.toISOString() });
      return created.records[0]?.get('fresh') === true;
    });
    if (!claimed) return 'skipped';
    claimKey = key;

    let text = rule.replyText ?? '';
    if (rule.action === 'agent') {
      try {
        const reply = await generateMeteredReply({
          driver: input.driver, askerId: input.senderId, ownerId, conversationId: input.conversationId,
          messageId: input.sourceMessageId, purpose: 'auto-draft', rateLimited: false, generate: input.generate,
        });
        text = reply.text;
      } catch (error) {
        if (!(error instanceof ProfileAgentError)) throw error;
        return 'skipped';
      }
    }
    if (!text) return 'skipped';

    if (rule.delivery === 'send') {
      const posted = await postAutomaticMessage(input.driver, {
        ownerId, conversationId: input.conversationId, replyToId: input.sourceMessageId,
        content: `${automaticLabel(ownerName)}\n\n${text}`,
        idempotencyKey: `auto-response:${ownerId}:${input.sourceMessageId}`,
        props: { viaAutoResponse: true, autoResponseRuleId: rule.id, autoResponseAction: rule.action },
      });
      if (!posted) return 'skipped';
      finished = true;
      if (input.io) await input.broadcast(input.io, input.conversationId, posted.message);
      dispatchMessageEvent(posted.message, posted.participantIds);
      return 'sent';
    }
    const draftId = nanoid();
    await session.run(`CREATE (:AutoResponseDraft {id:$id, ownerId:$ownerId, conversationId:$conversationId, sourceMessageId:$sourceMessageId,
      ruleId:$ruleId, text:$text, action:$action, status:'pending', createdAt:$now, expiresAt:$expiresAt})`, {
      id: draftId, ownerId, conversationId: input.conversationId, sourceMessageId: input.sourceMessageId, ruleId: rule.id, text,
      action: rule.action, now: now.toISOString(), expiresAt: new Date(now.getTime() + DRAFT_TTL_MS).toISOString(),
    });
    finished = true;
    input.io?.to(`user:${ownerId}`).emit('auto-response:draft', { draftId, conversationId: input.conversationId });
    return 'drafted';
  } catch (error) {
    console.warn('[auto-responses] failed:', error instanceof Error ? error.message : 'unknown');
    return 'skipped';
  } finally {
    // A claim that produced nothing (model failure, cap, chat changed) must not burn the 6-hour cooldown,
    // but backs off for 15 minutes so a failing model is not retried on every message.
    if (claimKey && !finished) {
      const backoff = new Date(Date.now() - COOLDOWN_MS + FAILURE_BACKOFF_MS).toISOString();
      await session.run('MATCH (e:AutoResponseEvent {key:$key}) SET e.createdAt=$backoff, e.failed=true', { key: claimKey, backoff }).catch(() => undefined);
    }
    await session.close();
  }
}

/** Additive indexes only; no data migration. */
export async function ensureProfileAgentIndexes(driver: Driver) {
  const s = driver.session();
  try {
    await s.run('CREATE CONSTRAINT auto_response_event_key IF NOT EXISTS FOR (e:AutoResponseEvent) REQUIRE e.key IS UNIQUE');
    await s.run('CREATE INDEX auto_response_event_rule IF NOT EXISTS FOR (e:AutoResponseEvent) ON (e.ruleId, e.conversationId)');
    await s.run('CREATE INDEX auto_response_draft_owner IF NOT EXISTS FOR (d:AutoResponseDraft) ON (d.ownerId, d.status)');
    await s.run('CREATE INDEX profile_agent_run_asker IF NOT EXISTS FOR (r:ProfileAgentRun) ON (r.askerId)');
    await s.run('CREATE INDEX profile_agent_run_owner IF NOT EXISTS FOR (r:ProfileAgentRun) ON (r.ownerId)');
    // Per-chat hourly bound for @agent (threadAgent.ts).
    await s.run('CREATE INDEX profile_agent_run_conversation IF NOT EXISTS FOR (r:ProfileAgentRun) ON (r.conversationId)');
    await s.run('CREATE INDEX auto_response_event_owner IF NOT EXISTS FOR (e:AutoResponseEvent) ON (e.ownerId, e.conversationId)');
    // Idempotency lookups for agent and automatic posts.
    await s.run('CREATE INDEX message_automatic_key IF NOT EXISTS FOR (m:Message) ON (m.automaticKey)');
    await s.run('CREATE CONSTRAINT profile_agent_budget_id IF NOT EXISTS FOR (g:ProfileAgentBudget) REQUIRE g.id IS UNIQUE');
  } finally { await s.close(); }
}

/** Account deletion: remove the owner's rules, drafts, events and agent runs that name them. */
export async function deleteProfileAgentDataForUser(tx: import('neo4j-driver').ManagedTransaction, userId: string) {
  await tx.run(`MATCH (:User {id:$userId})-[:OWNS_AUTO_RESPONSE_RULE]->(r:AutoResponseRule) DETACH DELETE r`, { userId });
  await tx.run(`MATCH (n) WHERE (n:AutoResponseDraft OR n:AutoResponseEvent) AND n.ownerId = $userId DETACH DELETE n`, { userId });
  await tx.run(`MATCH (r:ProfileAgentRun) WHERE r.ownerId = $userId OR r.askerId = $userId DETACH DELETE r`, { userId });
}
