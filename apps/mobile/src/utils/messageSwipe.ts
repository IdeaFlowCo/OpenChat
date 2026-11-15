/**
 * The geometry of a sideways swipe on a chat message, kept free of React
 * Native so the thresholds can be tested (see components/SwipeableMessage).
 */
export const SWIPE_ACTION_WIDTH = 64;
/** Two actions sit behind a message: To-do and Save. */
export const SWIPE_REVEAL = SWIPE_ACTION_WIDTH * 2;
export const SWIPE_REPLY_AT = 56;
const REPLY_MAX = 84;
const OPEN_AT = 48;

/** Whether a drag should be taken from the list: clearly sideways, not a scroll. */
export function isSidewaysDrag(dx: number, dy: number): boolean {
  return Math.abs(dx) > 14 && Math.abs(dx) > Math.abs(dy) * 1.8;
}

/** Where the row sits for a drag: free to the left up to the actions, resisted beyond; capped to the right. */
export function swipeOffset(dx: number, startedOpen: boolean): number {
  const raw = dx + (startedOpen ? -SWIPE_REVEAL : 0);
  if (raw < -SWIPE_REVEAL) return -SWIPE_REVEAL + (raw + SWIPE_REVEAL) * 0.2;
  return Math.min(raw, REPLY_MAX);
}

/** What letting go does: reply, leave the actions showing, or return to rest. */
export function swipeOutcome(offset: number): 'reply' | 'open' | 'rest' {
  if (offset >= SWIPE_REPLY_AT) return 'reply';
  if (offset <= -OPEN_AT) return 'open';
  return 'rest';
}
