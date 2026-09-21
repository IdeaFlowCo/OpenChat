export interface ConversationHeaderSubtitleInput {
  directStatus?: string;
  isGroup: boolean;
  isSelfDM: boolean;
  memberCount: number;
  containsBot: boolean;
  isMuted: boolean;
}

/**
 * Keep header state in one bounded line so compact and embedded chat chrome
 * communicate the same facts without adding more fixed-width title badges.
 */
export function buildConversationHeaderSubtitle({
  directStatus,
  isGroup,
  isSelfDM,
  memberCount,
  containsBot,
  isMuted,
}: ConversationHeaderSubtitleInput): string {
  const parts: string[] = [];

  if (isGroup) {
    parts.push(`${memberCount} ${memberCount === 1 ? 'member' : 'members'}`);
  } else if (isSelfDM) {
    parts.push('Private notes to yourself');
  } else if (directStatus?.trim()) {
    parts.push(directStatus.trim());
  }

  if (containsBot) parts.push('Includes AI');
  if (isMuted) parts.push('Muted');

  return parts.join(' · ');
}
