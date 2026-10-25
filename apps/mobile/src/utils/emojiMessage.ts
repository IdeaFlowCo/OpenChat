/**
 * Emoji-only messages and the chat's emoji send button (OpenChat-3aiu).
 *
 * Mirror of apps/server/src/services/emojiMessage.ts; keep the two in sync.
 */

export const MAX_EMOJI_SIZE = 4;

/** What a chat uses until someone picks a different emoji. */
export const DEFAULT_QUICK_EMOJI = '🍓';

/** Choices offered by the "Chat emoji" picker; any emoji can also be typed. */
export const QUICK_EMOJI_CHOICES = [
  '🍓', '👍', '❤️', '🔥', '😂', '🎉', '👋', '🙏',
  '🌈', '🐸', '🍕', '🚀', '✨', '🤗', '🫶', '😘',
  '🥹', '🌻', '🍀', '🐙', '🦄', '🧋', '🎸', '💫',
] as const;

const SINGLE_EMOJI = /^(?:(?:\p{Extended_Pictographic}|\p{Emoji_Presentation})(?:\p{Emoji_Modifier}|️|⃣)*(?:‍(?:\p{Extended_Pictographic}|\p{Emoji_Presentation})(?:\p{Emoji_Modifier}|️)*)*|\p{Regional_Indicator}{2}|[0-9#*]\uFE0F?\u20E3)$/u;

/** True when `content` is exactly one emoji (surrounding whitespace ignored). */
export function isSingleEmoji(content: unknown): boolean {
  if (typeof content !== 'string') return false;
  const trimmed = content.trim();
  if (!trimmed || trimmed.length > 24) return false;
  if (/^[0-9#*]$/.test(trimmed)) return false;
  return SINGLE_EMOJI.test(trimmed);
}

/** Clamp a stored or in-progress size to the supported range. */
export function clampEmojiSize(size: unknown): number {
  if (typeof size !== 'number' || !Number.isFinite(size)) return 1;
  return Math.min(MAX_EMOJI_SIZE, Math.max(1, Math.round(size)));
}

/**
 * Font size for an emoji-only message. Size 1 is already "jumbo" (a lone
 * emoji reads better big, as in iMessage); each held level adds more.
 */
export function emojiFontSize(size: unknown): number {
  const level = clampEmojiSize(size);
  return [0, 40, 56, 76, 100][level];
}

/**
 * Hold-to-grow: how long the button has been held → level 1..MAX. The first
 * step comes quickly so a deliberate hold is rewarded at once; the last takes
 * a committed press.
 */
export const HOLD_LEVEL_MS = [0, 350, 900, 1600] as const;

export function holdLevelForDuration(heldMs: number): number {
  let level = 1;
  for (let i = 1; i < HOLD_LEVEL_MS.length; i++) if (heldMs >= HOLD_LEVEL_MS[i]) level = i + 1;
  return Math.min(MAX_EMOJI_SIZE, level);
}

/** Visual scale of the composer button while held, continuous in time. */
export function holdScaleForDuration(heldMs: number): number {
  const total = HOLD_LEVEL_MS[HOLD_LEVEL_MS.length - 1];
  const t = Math.min(1, Math.max(0, heldMs / total));
  return 1 + t * 1.8;
}

export interface TicklePayload {
  fromUserId: string;
  toUserId: string;
  fromName: string;
  toName: string;
}

/** Parse a tickle card's payload; null when it is not a well-formed tickle. */
export function parseTicklePayload(message: { cardKind?: string; cardPayload?: string }): TicklePayload | null {
  if (message.cardKind !== 'tickle' || typeof message.cardPayload !== 'string') return null;
  try {
    const raw = JSON.parse(message.cardPayload) as Record<string, unknown>;
    if (typeof raw.fromUserId !== 'string' || typeof raw.toUserId !== 'string') return null;
    return {
      fromUserId: raw.fromUserId,
      toUserId: raw.toUserId,
      fromName: typeof raw.fromName === 'string' && raw.fromName ? raw.fromName : 'Someone',
      toName: typeof raw.toName === 'string' && raw.toName ? raw.toName : 'someone',
    };
  } catch {
    return null;
  }
}

/** The centered line a tickle card shows, from the viewer's point of view. */
export function tickleLine(payload: TicklePayload, myUserId: string | undefined): string {
  if (myUserId && payload.fromUserId === myUserId) return `You tickled ${payload.toName}`;
  if (myUserId && payload.toUserId === myUserId) return `${payload.fromName} tickled you`;
  return `${payload.fromName} tickled ${payload.toName}`;
}
