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
 * Multiple tags on one message → ONE Thought per message. All tag names are
 * unioned into `tags: string[]`; `kind` is the FIRST tag's kind (primary).
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
  /** Canonical Thought kind (the "type"). Known type-tags map directly;
   *  any other tag defaults to 'observation'. */
  kind: 'fact' | 'decision' | 'commitment' | 'reminder' | 'observation';
  /** True if this tag is a reserved TYPE tag (set the kind); false if it's a
   *  free-form LABEL (kept as a label, kind defaults to observation). Types and
   *  labels are fundamentally different — a type is the Thought's kind, a label
   *  is a topic tag on it. */
  isType: boolean;
}

/**
 * Pure: parse a message body and return ALL hashtags, in source order.
 * Reserved type-tags (#fact/#decision/#commitment/#reminder/#observation +
 * aliases) set the Thought kind; any other tag is a free-form label that
 * defaults to kind 'observation'. (Per Jacob 2026-06-04: any tag becomes a
 * Thought; people don't use casual hashtags.)
 */
export function extractTagsFromMessage(content: string): ExtractedTag[] {
  if (!content || content.length > MAX_MESSAGE_LEN) return [];
  const seen = new Set<string>();
  const out: ExtractedTag[] = [];
  for (const match of content.matchAll(TAG_RE)) {
    const raw = match[0];
    const name = (match[1] ?? '').toLowerCase();
    if (!name) continue;
    const known = TAG_TO_KIND[name];
    const kind = known ?? 'observation';
    if (seen.has(name)) continue; // Dedup same tag in one message
    seen.add(name);
    out.push({ raw, name, kind, isType: !!known });
    if (out.length >= MAX_TAGS_PER_MESSAGE) break;
  }
  return out;
}

/**
 * Side-effectful: create a single :Thought node owned by the sender,
 * carrying ALL of the message's tags, linked to the source message.
 * Best-effort — failures are logged but do NOT propagate (we don't want a
 * Thought-creation hiccup to break a chat message send).
 *
 * Returns the created Thought's id (as a single-element array, for
 * backward compatibility with callers) so the caller (or socket fan-out)
 * can emit a 'thought:created' event.
 */
export async function createThoughtsFromMessageTags(
  session: Session,
  params: {
    senderId: string;
    messageId: string;
    conversationId: string;
    content: string;
    /** Optional Socket.IO server — emits to the sender's personal feed and
     *  the source conversation's shared inline-tag feed. */
    io?: IOServer;
  }
): Promise<string[]> {
  const tags = extractTagsFromMessage(params.content);
  if (tags.length === 0) return [];

  console.log(`[thought-from-tag] extracted ${tags.length} tag(s) from message ${params.messageId}:`, tags.map((t) => t.raw).join(', '));
  try {
    // Keep the FULL message text incl. the hashtags (per Jacob 2026-06-04):
    // the tags stay visible in the Thought, and are also elevated into the
    // `tags` metadata below. Don't strip.
    const text = params.content.trim();
    const id = nanoid();
    const now = new Date().toISOString();
    const kind = tags[0].kind;
    const tagNames = tags.map((tag) => tag.name);
    await session.run(
      `
      MATCH (u:User {id: $senderId})
      OPTIONAL MATCH (m:Message {id: $messageId})
      CREATE (t:Thought {
        id: $id,
        userId: $senderId,
        text: $text,
        kind: $kind,
        tags: $tags,
        captureMethod: 'inline-tag',
        status: 'none',
        createdAt: datetime($now),
        updatedAt: datetime($now)
      })
      CREATE (u)-[:HAS_THOUGHT]->(t)
      FOREACH (msg IN CASE WHEN m IS NULL THEN [] ELSE [m] END |
        CREATE (t)-[:FROM_MESSAGE]->(msg)
      )
      `,
      { id, senderId: params.senderId, messageId: params.messageId, text, kind, tags: tagNames, now }
    );
    console.log(`[thought-from-tag] created Thought ${id} (kind=${kind}, tags=${tagNames.join(', ')}) for user ${params.senderId} from message ${params.messageId}`);

    // The sender's personal Thoughts tab and every participant's chat-scoped
    // view are separate surfaces, so use separate events/rooms. This avoids
    // inserting another participant's Thought into anyone's personal feed.
    if (params.io) {
      try {
        const thought = {
          id,
          text,
          kind,
          tags: tagNames,
          status: 'none',
          createdAt: now,
          updatedAt: now,
          sourceMessageId: params.messageId,
          sourceConversationId: params.conversationId,
          authorId: params.senderId,
          pinned: false,
        };
        params.io.to(`user:${params.senderId}`).emit('thought:created', { thought });
        params.io.to(`conversation:${params.conversationId}`).emit('thought:shared', {
          conversationId: params.conversationId,
          thought,
        });
      } catch (e) {
        console.warn('[thought-from-tag] socket emit failed:', e);
      }
    }
    return [id];
  } catch (err) {
    console.warn('[thought-from-tag] failed to create Thought for message', params.messageId, err);
    return [];
  }
}
