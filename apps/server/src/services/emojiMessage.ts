/**
 * Emoji-only messages (OpenChat-3aiu).
 *
 * The composer's quick-emoji button sends the chat's emoji as an ordinary text
 * message whose `content` is just that emoji. Holding the button grows it; the
 * chosen size travels as `emojiSize` (1 = tap, up to MAX_EMOJI_SIZE). The size
 * is only meaningful — and only stored — when the content is a single emoji,
 * so older clients and other consumers still see a plain emoji message.
 *
 * Mirror of apps/mobile/src/utils/emojiMessage.ts; keep the two in sync.
 */

export const MAX_EMOJI_SIZE = 4;

// One emoji grapheme: a pictographic base (or an emoji-presentation character
// such as a keycap-less digit is NOT included), optional skin-tone modifier,
// optional VS16, and any number of ZWJ-joined continuations (families, flags
// with tags, professions). Regional-indicator pairs cover country flags.
const SINGLE_EMOJI = /^(?:(?:\p{Extended_Pictographic}|\p{Emoji_Presentation})(?:\p{Emoji_Modifier}|️|⃣)*(?:‍(?:\p{Extended_Pictographic}|\p{Emoji_Presentation})(?:\p{Emoji_Modifier}|️)*)*|\p{Regional_Indicator}{2}|[0-9#*]\uFE0F?\u20E3)$/u;

/** True when `content` is exactly one emoji (surrounding whitespace ignored). */
export function isSingleEmoji(content: unknown): boolean {
  if (typeof content !== 'string') return false;
  const trimmed = content.trim();
  if (!trimmed || trimmed.length > 24) return false;
  // Plain digits, '#' and '*' have Emoji=Yes but are not pictographic; the
  // pattern above excludes them unless they carry a keycap (⃣).
  if (/^[0-9#*]$/.test(trimmed)) return false;
  return SINGLE_EMOJI.test(trimmed);
}

export type EmojiSizeParse =
  | { ok: true; size: number | null }
  | { ok: false; error: string };

/**
 * Validate a client-supplied `emojiSize`. Omitted → null (store nothing).
 * A size on non-emoji content is ignored rather than rejected, so a client
 * that keeps the field around for a drafted text message still sends fine.
 */
export function parseEmojiSize(value: unknown, content: unknown): EmojiSizeParse {
  if (value === undefined || value === null) return { ok: true, size: null };
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_EMOJI_SIZE) {
    return { ok: false, error: `emojiSize must be an integer from 1 to ${MAX_EMOJI_SIZE}` };
  }
  if (!isSingleEmoji(content)) return { ok: true, size: null };
  return { ok: true, size: value };
}
