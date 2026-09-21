import { describe, expect, it } from 'vitest';
import { buildConversationHeaderSubtitle } from './conversationHeader';

describe('buildConversationHeaderSubtitle', () => {
  it('keeps group size, AI identity, and mute state in one stable subtitle', () => {
    expect(buildConversationHeaderSubtitle({
      isGroup: true,
      isSelfDM: false,
      memberCount: 1234,
      containsBot: true,
      isMuted: true,
    })).toBe('1234 members · Includes AI · Muted');
  });

  it('uses the direct presence message without losing AI identity', () => {
    expect(buildConversationHeaderSubtitle({
      directStatus: 'Available',
      isGroup: false,
      isSelfDM: false,
      memberCount: 2,
      containsBot: true,
      isMuted: false,
    })).toBe('Available · Includes AI');
  });

  it('describes self conversations and singular groups', () => {
    expect(buildConversationHeaderSubtitle({
      isGroup: false,
      isSelfDM: true,
      memberCount: 1,
      containsBot: false,
      isMuted: false,
    })).toBe('Private notes to yourself');

    expect(buildConversationHeaderSubtitle({
      isGroup: true,
      isSelfDM: false,
      memberCount: 1,
      containsBot: false,
      isMuted: false,
    })).toBe('1 member');
  });
});
