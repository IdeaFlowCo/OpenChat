/**
 * In-app Assistant bot (openchat-bfn.3).
 *
 * A singleton bot User {id:'assistant'} can participate in direct
 * conversations flagged containsBot=true. When a human sends a message into
 * such a conversation, the send paths (REST + socket) fire runAssistantTurn()
 * asynchronously. That runs an agentic Anthropic tool-use loop: it loads the
 * recent conversation, lets the model call read/act tools (all scoped to the
 * HUMAN who owns the DM, never the bot), and finally writes the model's text
 * reply back into the conversation as a Message FROM the assistant — reusing
 * the exact message-create Cypher so it persists + emits over the socket and
 * shows live.
 *
 * Loop guard: never trigger when the sender is the assistant itself (the
 * trigger sites check this) and never let the assistant's own writes re-arm
 * the trigger (persistAssistantMessage writes as senderId='assistant', which
 * the trigger ignores).
 */

import type { Server as IOServer } from 'socket.io';
import type AnthropicType from '@anthropic-ai/sdk';
import { nanoid } from 'nanoid';
import neo4j from 'neo4j-driver';
import { getDriver } from '../db.js';
import { broadcastMessageToParticipants } from '../websocket/chatHandler.js';
import { processLinkPreviews } from '../services/linkPreview.js';
import { embedAndStoreMessage, semanticSearchMessages, embeddingsEnabled } from './embeddings.js';

export const ASSISTANT_USER_ID = 'assistant';
export const ASSISTANT_NAME = 'Assistant';
export const ASSISTANT_EMAIL = 'assistant@openchat.local';

const MAX_ITERATIONS = 6;
const CONTEXT_MESSAGE_LIMIT = 30;

// ─── Neo4j → JS coercion (mirrors chat.ts toJS) ──────────────────────────────
function toJS(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'object' && 'toNumber' in (value as object)) {
    return (value as { toNumber: () => number }).toNumber();
  }
  if (typeof value === 'object' && 'toString' in (value as object) && 'year' in (value as object)) {
    return (value as { toString: () => string }).toString();
  }
  if (Array.isArray(value)) return value.map(toJS);
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as object)) {
      result[k] = toJS(v);
    }
    return result;
  }
  return value;
}

// ─── Anthropic client (lazy, graceful-degradation) ───────────────────────────
let _anthropicPromise: Promise<AnthropicType | null> | null = null;
function getAnthropicClient(): Promise<AnthropicType | null> {
  if (_anthropicPromise) return _anthropicPromise;
  _anthropicPromise = (async () => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return null;
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    return new Anthropic({ apiKey });
  })();
  return _anthropicPromise;
}

/**
 * Idempotently create the singleton Assistant bot User. Called once on boot.
 */
export async function ensureAssistantUser(): Promise<void> {
  const s = getDriver().session();
  try {
    await s.run(
      `MERGE (u:User {id: $id})
       ON CREATE SET u.name = $name, u.email = $email, u.isBot = true,
                     u.createdAt = datetime($now)
       SET u.isBot = true, u.name = coalesce(u.name, $name), u.email = coalesce(u.email, $email)`,
      { id: ASSISTANT_USER_ID, name: ASSISTANT_NAME, email: ASSISTANT_EMAIL, now: new Date().toISOString() }
    );
  } finally {
    await s.close();
  }
}

/**
 * Persist a message into a conversation reusing the same create + broadcast
 * path as the REST/socket handlers, sending AS `senderId`. Used both for the
 * assistant's own replies (senderId='assistant') and the send_message tool
 * (senderId = the human user). Returns the persisted message + participantIds.
 *
 * Caller is responsible for any participation check; this function trusts
 * `senderId` (assistant turns scope tools to the owning human elsewhere).
 */
async function persistMessage(
  io: IOServer | undefined,
  senderId: string,
  conversationId: string,
  content: string
): Promise<{ message: Record<string, unknown>; participantIds: string[] } | null> {
  const messageId = nanoid();
  const now = new Date().toISOString();
  const messageContent = content.trim();
  if (!messageContent) return null;

  const s = getDriver().session();
  try {
    const result = await s.run(
      `
      MATCH (c:Conversation {id: $conversationId})
      MATCH (sender:User {id: $senderId})
      MERGE (m:Message {id: $id})
      ON CREATE SET
        m.content = $content,
        m.senderId = $senderId,
        m.conversationId = $conversationId,
        m.messageType = 'text',
        m.createdAt = datetime($now)
      MERGE (m)-[:IN_CONVERSATION]->(c)
      MERGE (sender)-[:SENT]->(m)
      SET c.updatedAt = datetime($now),
          c.lastMessageAt = datetime($now),
          c.lastMessagePreview = left($content, 100)
      WITH c, m, sender
      MATCH (p:User)-[:PARTICIPATES_IN]->(c)
      RETURN m { .*, sender: sender { .id, .name, .email } } AS message,
             collect(DISTINCT p.id) AS participantIds
      `,
      { id: messageId, content: messageContent, senderId, conversationId, now }
    );

    if (result.records.length === 0) return null;
    const message = toJS(result.records[0].get('message')) as Record<string, unknown>;
    const participantIds = result.records[0].get('participantIds') as string[];

    if (io) {
      broadcastMessageToParticipants(io, participantIds, message);
      processLinkPreviews(io, message.id as string, conversationId, messageContent);
    }

    // Best-effort: embed the new message for semantic search (openchat-bfn.2).
    void embedAndStoreMessage(message.id as string, messageContent).catch(() => { /* best-effort */ });

    return { message, participantIds };
  } finally {
    await s.close();
  }
}

// ─── Tool implementations (all scoped to the owning HUMAN userId) ─────────────

async function toolSearchMessages(
  userId: string,
  query: string,
  limit: number
): Promise<unknown[]> {
  // Prefer hybrid (semantic + keyword) when embeddings are available, else
  // keyword. We merge results, dedupe by content+conversation, cap at limit.
  const out: Array<{ content: string; conversationId: string; senderName: string | null; createdAt: string; score?: number }> = [];
  const seen = new Set<string>();

  if (embeddingsEnabled()) {
    const sem = await semanticSearchMessages(userId, query, limit);
    if (sem) {
      for (const h of sem) {
        const key = `${h.conversationId}::${h.content}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ content: h.content, conversationId: h.conversationId, senderName: h.senderName ?? null, createdAt: h.createdAt, score: h.score });
      }
    }
  }

  // Keyword pass (always — fills in lexical matches the vector index may miss,
  // and is the sole source when embeddings are disabled).
  const s = getDriver().session();
  try {
    const result = await s.run(
      `
      MATCH (u:User {id: $userId})-[:PARTICIPATES_IN]->(c:Conversation)
      WITH collect(c.id) AS cids
      MATCH (m:Message)
      WHERE m.conversationId IN cids
        AND m.deletedAt IS NULL
        AND toLower(m.content) CONTAINS toLower($q)
      MATCH (sender:User {id: m.senderId})
      RETURN m.content AS content, m.conversationId AS conversationId,
             sender.name AS senderName, m.createdAt AS createdAt
      ORDER BY m.createdAt DESC
      LIMIT $limit
      `,
      { userId, q: query, limit: neo4j.int(limit) }
    );
    for (const r of result.records) {
      const createdAt = r.get('createdAt');
      const content = (r.get('content') as string) ?? '';
      const conversationId = r.get('conversationId') as string;
      const key = `${conversationId}::${content}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        content,
        conversationId,
        senderName: (r.get('senderName') as string | null) ?? null,
        createdAt: createdAt?.toString?.() ?? String(createdAt ?? ''),
      });
    }
  } finally {
    await s.close();
  }

  return out.slice(0, limit);
}

async function toolListConversations(userId: string): Promise<unknown[]> {
  const s = getDriver().session();
  try {
    const result = await s.run(
      `
      MATCH (u:User {id: $userId})-[:PARTICIPATES_IN]->(c:Conversation)
      CALL {
        WITH c, u
        MATCH (p:User)-[:PARTICIPATES_IN]->(c)
        WHERE p.id <> u.id
        RETURN collect(p.name) AS otherNames
      }
      RETURN c.id AS id, c.title AS title, c.type AS type,
             c.lastMessagePreview AS lastMessagePreview,
             c.lastMessageAt AS lastMessageAt,
             otherNames
      ORDER BY c.lastMessageAt DESC
      LIMIT 50
      `,
      { userId }
    );
    return result.records.map((r) => {
      const title = r.get('title') as string | null;
      const otherNames = (toJS(r.get('otherNames')) as string[]) || [];
      const displayName =
        (title && title.trim()) ||
        (otherNames.filter(Boolean).join(', ')) ||
        'Conversation';
      const lastMessageAt = r.get('lastMessageAt');
      return {
        id: r.get('id') as string,
        type: r.get('type') as string,
        displayName,
        lastMessagePreview: (r.get('lastMessagePreview') as string | null) ?? null,
        lastMessageAt: lastMessageAt?.toString?.() ?? null,
      };
    });
  } finally {
    await s.close();
  }
}

async function toolReadMessages(
  userId: string,
  conversationId: string,
  limit: number
): Promise<unknown> {
  const s = getDriver().session();
  try {
    // Verify the user participates before returning any content.
    const check = await s.run(
      `MATCH (u:User {id: $userId})-[:PARTICIPATES_IN]->(c:Conversation {id: $conversationId}) RETURN c LIMIT 1`,
      { userId, conversationId }
    );
    if (check.records.length === 0) {
      return { error: 'You do not have access to that conversation.' };
    }
    const result = await s.run(
      `
      MATCH (m:Message {conversationId: $conversationId})
      WHERE m.deletedAt IS NULL
      MATCH (sender:User {id: m.senderId})
      RETURN m.content AS content, sender.name AS senderName,
             m.senderId AS senderId, m.createdAt AS createdAt
      ORDER BY m.createdAt DESC
      LIMIT $limit
      `,
      { conversationId, limit: neo4j.int(limit) }
    );
    const messages = result.records
      .map((r) => {
        const createdAt = r.get('createdAt');
        return {
          content: (r.get('content') as string) ?? '',
          senderName: (r.get('senderName') as string | null) ?? null,
          senderId: r.get('senderId') as string,
          createdAt: createdAt?.toString?.() ?? String(createdAt ?? ''),
        };
      })
      .reverse();
    return { messages };
  } finally {
    await s.close();
  }
}

async function toolSendMessage(
  io: IOServer | undefined,
  userId: string,
  conversationId: string,
  content: string
): Promise<unknown> {
  if (!content || !content.trim()) {
    return { error: 'content is required' };
  }
  const s = getDriver().session();
  try {
    // The user must participate in the target conversation.
    const check = await s.run(
      `MATCH (u:User {id: $userId})-[:PARTICIPATES_IN]->(c:Conversation {id: $conversationId}) RETURN c LIMIT 1`,
      { userId, conversationId }
    );
    if (check.records.length === 0) {
      return { error: 'You do not have access to that conversation.' };
    }
  } finally {
    await s.close();
  }

  // TODO(openchat-bfn.4): guardrails for messaging OTHER people. send_message
  // currently sends AS the user into ANY conversation they participate in,
  // which can include DMs/groups with non-self contacts. bfn.4 must add
  // confirmation / allowlist / "only self-DM unless approved" gating here
  // before the assistant can autonomously message real contacts.
  const persisted = await persistMessage(io, userId, conversationId, content);
  if (!persisted) return { error: 'Failed to send message' };
  return { ok: true, messageId: persisted.message.id, conversationId };
}

async function toolCreateConversation(
  io: IOServer | undefined,
  userId: string,
  participantIds: string[],
  title?: string
): Promise<unknown> {
  const conversationId = nanoid();
  const now = new Date().toISOString();
  const type = participantIds.filter((id) => id !== userId).length <= 1 ? 'direct' : 'group';
  const allParticipants = [userId, ...participantIds.filter((id) => id !== userId)];

  const s = getDriver().session();
  try {
    const result = await s.run(
      `
      CREATE (c:Conversation {
        id: $id, title: $title, type: $type,
        createdAt: datetime($now), updatedAt: datetime($now), lastMessageAt: datetime($now)
      })
      WITH c
      UNWIND $participants AS pid
      MATCH (u:User {id: pid})
      CREATE (u)-[rel:PARTICIPATES_IN { joinedAt: datetime($now),
        role: CASE WHEN pid = $userId THEN 'owner' ELSE 'member' END }]->(c)
      RETURN c.id AS id
      `,
      { id: conversationId, title: title || null, type, now, participants: allParticipants, userId }
    );
    if (result.records.length === 0) return { error: 'Failed to create conversation' };

    if (io) {
      const { joinUserSocketsToConversation } = await import('../websocket/chatHandler.js');
      for (const pid of allParticipants) joinUserSocketsToConversation(io, pid, conversationId);
    }
    return { id: conversationId, type, title: title || null, participantIds: allParticipants };
  } finally {
    await s.close();
  }
}

// ─── Feedback → WorldIssueTracker (openchat-1ny) ──────────────────────────────
// Lets the user file feedback by just telling the Assistant. Mirrors the
// /api/feedback route (same WIT_AGENT_KEY server env).
const WIT_BASE = process.env.WIT_API_BASE || 'https://sthqnyjniclvnflfkyio.supabase.co/functions/v1';
const WIT_SITE = process.env.WIT_SITE_URL || 'https://worldissuetracker.com';

async function toolSubmitFeedback(
  userId: string,
  message: string,
  context?: string
): Promise<unknown> {
  const key = process.env.WIT_AGENT_KEY;
  if (!key) return { error: 'Feedback is not configured on the server (WIT_AGENT_KEY missing).' };
  const firstLine = message.trim().split('\n')[0]!.slice(0, 80);
  const title = `[OpenChat] ${firstLine || 'feedback'}`;
  const description = [
    message.trim(),
    '',
    '---',
    `Submitted via the OpenChat Assistant by user ${userId}.`,
    context ? `Context: ${context}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  try {
    const r = await fetch(`${WIT_BASE}/create-issue`, {
      method: 'POST',
      headers: { 'X-Agent-Key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, description, labels: ['openchat-feedback'] }),
    });
    const data = (await r.json().catch(() => null)) as
      | { success?: boolean; issue?: { id?: string; slug?: string } }
      | null;
    if (!r.ok || !data?.success) return { error: 'Failed to create feedback issue' };
    const slug = data.issue?.slug;
    return { ok: true, url: slug ? `${WIT_SITE}/issue/${slug}` : WIT_SITE, id: data.issue?.id };
  } catch {
    return { error: 'Failed to reach feedback service' };
  }
}

// ─── Tool schema (Anthropic tool-use) ─────────────────────────────────────────
function buildTools(): AnthropicType.Tool[] {
  return [
    {
      name: 'search_messages',
      description:
        "Search the user's own messages (across all their conversations) by keyword/semantic relevance. Returns matching messages with their conversationId so you can read or act on them.",
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search text' },
          limit: { type: 'number', description: 'Max results (default 10)' },
        },
        required: ['query'],
      },
    },
    {
      name: 'list_conversations',
      description: "List the user's conversations with a display name and last-message preview.",
      input_schema: { type: 'object', properties: {} },
    },
    {
      name: 'read_messages',
      description: 'Read recent messages in one of the user\'s conversations.',
      input_schema: {
        type: 'object',
        properties: {
          conversationId: { type: 'string' },
          limit: { type: 'number', description: 'Max messages (default 20)' },
        },
        required: ['conversationId'],
      },
    },
    {
      name: 'send_message',
      description:
        "Send a message AS THE USER into one of their conversations. Use this to act on the user's behalf (e.g. reply to someone, post an update). Confirm intent before messaging other people.",
      input_schema: {
        type: 'object',
        properties: {
          conversationId: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['conversationId', 'content'],
      },
    },
    {
      name: 'create_conversation',
      description: 'Create a new conversation with the given participant user ids (the user is added automatically).',
      input_schema: {
        type: 'object',
        properties: {
          participantIds: { type: 'array', items: { type: 'string' } },
          title: { type: 'string' },
        },
        required: ['participantIds'],
      },
    },
    {
      name: 'submit_feedback',
      description:
        "File the user's feedback, bug report, or feature request about OpenChat ITSELF (the app). Creates a tracked issue the OpenChat team sees. Use this when the user wants to send feedback about the app — NOT for messaging another person.",
      input_schema: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'The feedback / bug / request text' },
          context: { type: 'string', description: 'Optional extra context (screen, what they were doing)' },
        },
        required: ['message'],
      },
    },
  ];
}

async function executeTool(
  io: IOServer | undefined,
  userId: string,
  name: string,
  input: Record<string, unknown>
): Promise<unknown> {
  try {
    switch (name) {
      case 'search_messages': {
        const query = typeof input.query === 'string' ? input.query : '';
        const limit = typeof input.limit === 'number' && input.limit > 0 ? Math.min(input.limit, 50) : 10;
        if (!query.trim()) return { error: 'query is required' };
        return { results: await toolSearchMessages(userId, query, limit) };
      }
      case 'list_conversations':
        return { conversations: await toolListConversations(userId) };
      case 'read_messages': {
        const conversationId = typeof input.conversationId === 'string' ? input.conversationId : '';
        const limit = typeof input.limit === 'number' && input.limit > 0 ? Math.min(input.limit, 100) : 20;
        if (!conversationId) return { error: 'conversationId is required' };
        return await toolReadMessages(userId, conversationId, limit);
      }
      case 'send_message': {
        const conversationId = typeof input.conversationId === 'string' ? input.conversationId : '';
        const content = typeof input.content === 'string' ? input.content : '';
        if (!conversationId) return { error: 'conversationId is required' };
        return await toolSendMessage(io, userId, conversationId, content);
      }
      case 'create_conversation': {
        const participantIds = Array.isArray(input.participantIds)
          ? (input.participantIds.filter((x) => typeof x === 'string') as string[])
          : [];
        const title = typeof input.title === 'string' ? input.title : undefined;
        if (participantIds.length === 0) return { error: 'participantIds is required' };
        return await toolCreateConversation(io, userId, participantIds, title);
      }
      case 'submit_feedback': {
        const message = typeof input.message === 'string' ? input.message : '';
        const context = typeof input.context === 'string' ? input.context : undefined;
        if (!message.trim()) return { error: 'message is required' };
        return await toolSubmitFeedback(userId, message, context);
      }
      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (err) {
    console.warn(`[assistant] tool ${name} failed:`, err);
    return { error: `Tool ${name} failed: ${(err as Error).message}` };
  }
}

// ─── Context loading ─────────────────────────────────────────────────────────
async function loadConversationContext(
  conversationId: string
): Promise<AnthropicType.MessageParam[]> {
  const s = getDriver().session();
  try {
    const result = await s.run(
      `
      MATCH (m:Message {conversationId: $conversationId})
      WHERE m.deletedAt IS NULL
      OPTIONAL MATCH (sender:User {id: m.senderId})
      RETURN m.content AS content, m.senderId AS senderId, sender.name AS senderName
      ORDER BY m.createdAt DESC
      LIMIT $limit
      `,
      { conversationId, limit: neo4j.int(CONTEXT_MESSAGE_LIMIT) }
    );
    const rows = result.records
      .map((r) => ({
        content: (r.get('content') as string) ?? '',
        senderId: r.get('senderId') as string,
        senderName: (r.get('senderName') as string | null) ?? 'User',
      }))
      .reverse();

    // Map to Anthropic turns: assistant messages = bot's own; everything else
    // is "user" (prefixed with sender name so the model can tell speakers apart
    // in a group). Empty contents are skipped.
    return rows
      .filter((row) => row.content.trim())
      .map((row): AnthropicType.MessageParam => {
        if (row.senderId === ASSISTANT_USER_ID) {
          return { role: 'assistant', content: row.content };
        }
        return { role: 'user', content: `${row.senderName}: ${row.content}` };
      });
  } finally {
    await s.close();
  }
}

const SYSTEM_PROMPT = `You are Assistant, an in-app helper inside OpenChat (a chat application).
You are talking with a user inside a direct-message conversation. You can search the user's messages, list and read their conversations, send messages on their behalf, create conversations, and file feedback about OpenChat — all via tools. All tools act on behalf of THIS user only.

Guidelines:
- Be concise and conversational; this is a chat, not an essay.
- Use tools to ground your answers in the user's actual messages/conversations rather than guessing.
- Only use send_message / create_conversation when the user clearly asks you to act. When messaging OTHER people, confirm first.
- If the user wants to report a bug, give feedback, or request a feature about OpenChat (the app), use submit_feedback — it files a tracked issue for the OpenChat team. Confirm what you'll send, then share the resulting link. This is how feedback reaches us, so offer it when the user seems stuck or frustrated with the app.
- Your final response (plain text, no tool call) is delivered to the user as a chat message.`;

/**
 * Run one agentic assistant turn for a conversation. Loads recent context,
 * loops the Anthropic tool-use cycle (max MAX_ITERATIONS), executes tools
 * scoped to `userId`, and writes the final text as a Message FROM the
 * assistant bot. Best-effort: logs and returns on any failure.
 */
export async function runAssistantTurn(opts: {
  userId: string;
  conversationId: string;
  io?: IOServer;
}): Promise<void> {
  const { userId, conversationId, io } = opts;

  const client = await getAnthropicClient();
  if (!client) {
    console.warn('[assistant] ANTHROPIC_API_KEY not set — assistant turn skipped.');
    return;
  }

  try {
    const tools = buildTools();
    const messages = await loadConversationContext(conversationId);
    if (messages.length === 0) return;

    const model = process.env.ASSISTANT_MODEL || 'claude-haiku-4-5';
    let finalText = '';

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const response = await client.messages.create({
        model,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        tools,
        messages,
      });

      // Collect text + tool_use blocks.
      const toolUses = response.content.filter(
        (b): b is AnthropicType.ToolUseBlock => b.type === 'tool_use'
      );
      const textBlocks = response.content.filter(
        (b): b is AnthropicType.TextBlock => b.type === 'text'
      );

      if (response.stop_reason !== 'tool_use' || toolUses.length === 0) {
        // Final answer — concatenate any text blocks.
        finalText = textBlocks.map((b) => b.text).join('\n').trim();
        break;
      }

      // Record the assistant's tool-use turn, then run each tool and feed
      // results back as a single user turn.
      messages.push({ role: 'assistant', content: response.content });

      const toolResults: AnthropicType.ToolResultBlockParam[] = [];
      for (const tu of toolUses) {
        const result = await executeTool(io, userId, tu.name, (tu.input ?? {}) as Record<string, unknown>);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: JSON.stringify(result),
        });
      }
      messages.push({ role: 'user', content: toolResults });

      // If we just hit the last iteration without a final answer, surface any
      // text we have so the user isn't left hanging.
      if (i === MAX_ITERATIONS - 1) {
        finalText = textBlocks.map((b) => b.text).join('\n').trim();
      }
    }

    if (finalText) {
      await persistMessage(io, ASSISTANT_USER_ID, conversationId, finalText);
    }
  } catch (err) {
    console.error('[assistant] runAssistantTurn failed:', err);
  }
}
