/** Message provenance helpers. */

export const VISION_CAPTION = 'from Vision';

/**
 * The "from Vision" caption is shown only to the sender, on messages they sent
 * from Vision. Recipients see nothing different.
 */
export function showsVisionCaption(
  message: { senderId?: string | null; provenanceService?: string | null },
  currentUserId: string | null | undefined
): boolean {
  return !!currentUserId && message.senderId === currentUserId && message.provenanceService === 'vision';
}
