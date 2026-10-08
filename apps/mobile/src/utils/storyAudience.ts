import type { OwnedStory } from '../api/client';

export function storyAudienceLabel(story: Pick<OwnedStory, 'showOnProfile' | 'profileVisibility' | 'audience'>): string {
  if (story.showOnProfile && story.profileVisibility === 'public') return 'Public';
  if (story.profileVisibility === 'private') return 'Private';
  const people = story.audience.userIds.length;
  const chats = story.audience.conversationIds.length;
  if (!people && !chats) return 'Private';
  return [
    people ? `${people} selected ${people === 1 ? 'person' : 'people'}` : '',
    chats ? `${chats} selected chat${chats === 1 ? '' : 's'}` : '',
  ].filter(Boolean).join(' · ');
}
