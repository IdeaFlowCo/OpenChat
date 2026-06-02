/**
 * Hashtag → Thought extraction (OpenChat-thoughts-from-tags).
 *
 * Scans a message body for hashtags that map to Thought kinds. If any are
 * found, creates :Thought nodes for the sender, linked back to the source
 * message via a :FROM_MESSAGE relationship so we can show provenance in
 * the feed.
 *
 *   "#fact The meeting is at 3pm"        → kind=fact
 *   "#decision Going with option B"      → kind=decision
 *   "#commitment I'll ship it Friday"    → kind=commitment
 *   "#reminder Call mom tomorrow"        → kind=reminder
 *   "#observation Slack is dead today"   → kind=observation
 *   "#thought we should rethink..."      → kind=observation (alias)
 *   "#todo follow up with Sandeep"       → kind=reminder (alias)
 *   "#note keyboard shortcut is Cmd-K"   → kind=observation (alias)
 *
 * Multiple tags on one message → one Thought per tag.
 *
 * The Thought text is the message content with the tag itself stripped,
 * leading/trailing whitespace trimmed. If stripping leaves an empty
 * string the WHOLE message content is used as the text (so "#fact" with
 * no body becomes a Thought saying "#fact" — better than dropping it).
 *
 * Capacity guards:
 * - Refuses to extract from messages > 4000 chars (sanity limit; matches
 *   the existing MAX_TEXT_LENGTH soft cap on /api/thoughts)
 * - Refuses more than 5 tags per message (DoS guard — someone spamming
 *   #fact#fact#fact... would otherwise create 100s of thoughts)
 */

import type { Session } from 'neo4j-driver';
import type { Server as IOServer } from 'socket.io';
import { nanoid } from 'nanoid';

const MAX_MESSAGE_LEN = 4000;
const MAX_TAGS_PER_MESSAGE = 5;

// Lowercase tag → canonical kind value.
const TAG_TO_KIND: Record<string, 'fact' | 'decision' | 'commitment' | 'reminder' | 'observation'> = {
  fact: 'fact',
  decision: 'decision',
  commitment: 'commitment',
  commit: 'commitment',
  reminder: 'reminder',
  todo: 'reminder',
  observation: 'observation',
  thought: 'observation',
  note: 'observation',
};

const TAG_RE = /#([a-zA-Z]+)/g;

export interface ExtractedTag {
  /** The literal tag text the user typed, e.g. "#Fact" — preserved for UI. */
  raw: string;
  /** Lowercase tag name without the '#'. */
  name: string;
  /** Canonical Thought kind this tag maps to. */
  kind: 'fact' | 'decision' | 'commitment' | 'reminder' | 'observation';
}

/**
 * Pure: parse a message body and return the list of recognized tags, in
 * source order. Unrecognized hashtags are silently ignored.
 */
export function extractTagsFromMessage(content: string): ExtractedTag[] {
  if (!content || content.length > MAX_MESSAGE_LEN) return [];
  const seen = new Set<string>();
  const out: ExtractedTag[] = [];
  for (const match of content.matchAll(TAG_RE)) {
    const raw = match[0];
    const name = (match[1] ?? '').toLowerCase();
    const kind = TAG_TO_KIND[name];
    if (!kind) continue;
    if (seen.has(name)) continue; // Dedup same tag in one message
    seen.add(name);
    out.push({ raw, name, kind });
    if (out.length >= MAX_TAGS_PER_MESSAGE) break;
  }
  return out;
}

/**
 * Side-effectful: for each tag, create a :Thought node owned by the
 * sender + linked to the source message. Best-effort — failures are
 * logged but do NOT propagate (we don't want a Thought-creation hiccup
 * to break a chat message send).
 *
 * Returns the list of created Thought ids so the caller (or socket
 * fan-out, eventually) can emit a 'thought:created' event.
 */
export async function createThoughtsFromMessageTags(
  session: Session,
  params: {
    senderId: string;
    messageId: string;
    conversationId: string;
    content: string;
    /** Optional Socket.IO server — emits 'thought:created' to the sender's
     *  user room so the Thoughts tab auto-refreshes without polling. */
    io?: IOServer;
  }
): Promise<string[]> {
  const tags = extractTagsFromMessage(params.content);
  if (tags.length === 0) return [];

  const createdIds: string[] = [];
  console.log(`[thought-from-tag] extracted ${tags.length} tag(s) from message ${params.messageId}:`, tags.map((t) => t.raw).join(', '));
  for (const tag of tags) {
    try {
      // Strip just THIS tag from the message; leave other tags in place so
      // the Thought text reflects what each tag covers individually.
      const stripped = params.content.replace(tag.raw, '').replace(/\s+/g, ' ').trim();
      const text = stripped.length > 0 ? stripped : params.content.trim();
      const id = nanoid();
      const now = new Date().toISOString();
      await session.run(
        `
        MATCH (u:User {id: $senderId})
        OPTIONAL MATCH (m:Message {id: $messageId})
        CREATE (t:Thought {
          id: $id,
          userId: $senderId,
          text: $text,
          kind: $kind,
          status: 'none',
          createdAt: datetime($now),
          updatedAt: datetime($now)
        })
        CREATE (u)-[:HAS_THOUGHT]->(t)
        FOREACH (msg IN CASE WHEN m IS NULL THEN [] ELSE [m] END |
          CREATE (t)-[:FROM_MESSAGE]->(msg)
        )
        `,
        { id, senderId: params.senderId, messageId: params.messageId, text, kind: tag.kind, now }
      );
      createdIds.push(id);
      console.log(`[thought-from-tag] created Thought ${id} (kind=${tag.kind}) for user ${params.senderId} from message ${params.messageId}`);

      // Emit to the sender's user room so the Thoughts tab can refresh
      // without polling. Same room-naming pattern other emits use
      // (chatHandler joins each user to `user:${userId}` on connect).
      if (params.io) {
        try {
          params.io.to(`user:${params.senderId}`).emit('thought:created', {
            thought: {
              id,
              text,
              kind: tag.kind,
              status: 'none',
              createdAt: now,
              updatedAt: now,
              fromMessageId: params.messageId,
              fromConversationId: params.conversationId,
            },
          });
        } catch (e) {
          console.warn('[thought-from-tag] socket emit failed:', e);
        }
      }
    } catch (err) {
      console.warn('[thought-from-tag] failed to create Thought for tag', tag.raw, err);
      // Continue with the other tags.
    }
  }
  return createdIds;
}
