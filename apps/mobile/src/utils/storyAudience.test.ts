import { describe, expect, it } from 'vitest';
import { storyAudienceLabel } from './storyAudience';

describe('owner Story audience labels', () => {
  const audience = { userIds: [], conversationIds: [] };
  it('distinguishes public publication from private asks with identical empty audiences', () => {
    expect(storyAudienceLabel({ showOnProfile: true, profileVisibility: 'public', audience })).toBe('Public');
    expect(storyAudienceLabel({ showOnProfile: true, profileVisibility: 'private', audience })).toBe('Private');
    expect(storyAudienceLabel({ audience })).toBe('Private');
  });
  it('describes selected people and chats for profile and ordinary Stories', () => {
    expect(storyAudienceLabel({ profileVisibility: 'selected', audience: { userIds: ['a'], conversationIds: [] } })).toBe('1 selected person');
    expect(storyAudienceLabel({ audience: { userIds: ['a', 'b'], conversationIds: ['room'] } })).toBe('2 selected people · 1 selected chat');
    expect(storyAudienceLabel({ audience: { userIds: [], conversationIds: ['one', 'two'] } })).toBe('2 selected chats');
  });
});
