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
    /** Optional Socket.IO server — emits 'thought:created' to every user who
     *  can read it so the Thoughts tab auto-refreshes without polling. */
    io?: IOServer;
  }
): Promise<string[]> {
  const tags = extractTagsFromMessage(params.content);
  if (tags.length === 0) return [];

  const createdIds: string[] = [];
  console.log(`[thought-from-tag] extracted ${tags.length} tag(s) from message ${params.messageId}:`, tags.map((t) => t.raw).join(', '));
  for (const tag of tags) {
    try {
      // Keep the FULL message text incl. the hashtags (per Jacob 2026-06-04):
      // the tag stays visible in the Thought, and is also elevated into the
      // `tags` metadata below. Don't strip.
      const text = params.content.trim();
      const id = nanoid();
      const now = new Date().toISOString();
      const result = await session.run(
        `
        MATCH (u:User {id: $senderId})
        OPTIONAL MATCH (m:Message {id: $messageId})
        OPTIONAL MATCH (conv:Conversation {id: $conversationId})
        CREATE (t:Thought {
          id: $id,
          userId: $senderId,
          text: $text,
          kind: $kind,
          tags: $tags,
          status: 'none',
          createdAt: datetime($now),
          updatedAt: datetime($now)
        })
        CREATE (u)-[:HAS_THOUGHT]->(t)
        FOREACH (msg IN CASE WHEN m IS NULL THEN [] ELSE [m] END |
          CREATE (t)-[:FROM_MESSAGE]->(msg)
        )
        WITH u, conv
        OPTIONAL MATCH (participant:User)-[:PARTICIPATES_IN]->(conv)
        RETURN
          coalesce(u.name, 'Group member') AS authorName,
          conv.type AS conversationType,
          coalesce(conv.title, conv.name) AS conversationName,
          collect(participant.id) AS participantIds
        `,
        {
          id,
          senderId: params.senderId,
          messageId: params.messageId,
          conversationId: params.conversationId,
          text,
          kind: tag.kind,
          tags: [tag.name],
          now,
        }
      );
      createdIds.push(id);
      console.log(`[thought-from-tag] created Thought ${id} (kind=${tag.kind}) for user ${params.senderId} from message ${params.messageId}`);

      // Group-tagged Thoughts are visible to every current group member; DMs
      // and standalone Thoughts remain private to their author.
      if (params.io) {
        try {
          const record = result.records[0];
          const conversationType = record?.get('conversationType') as string | null;
          const participantIds = (record?.get('participantIds') as string[] | undefined) ?? [];
          const recipients = conversationType === 'group'
            ? participantIds
            : [params.senderId];
          const payload = {
            thought: {
              id,
              text,
              kind: tag.kind,
              tags: [tag.name],
              status: 'none',
              createdAt: now,
              updatedAt: now,
              ownerId: params.senderId,
              authorName: (record?.get('authorName') as string | undefined) ?? 'Group member',
              sourceMessageId: params.messageId,
              sourceConversationId: params.conversationId,
              sourceConversationName: record?.get('conversationName') as string | null,
              sourceConversationType: conversationType,
            },
          };
          for (const recipientId of new Set(recipients)) {
            params.io.to(`user:${recipientId}`).emit('thought:created', payload);
          }
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
