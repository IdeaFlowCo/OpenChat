import { describe, expect, it } from 'vitest';
import type { Conversation, CurrentUser } from '../api/client';
import {
  getConversationPreview,
  shouldShowGroupSenderLabel,
} from './conversationPresentation';

const me: CurrentUser = { userId: 'me', email: 'me@example.test' };
const participants = [
  { user: { id: 'me', name: 'Jacob' }, role: 'member' as const },
  { user: { id: 'alice', name: 'Alice' }, role: 'member' as const },
];

function conversation(type: Conversation['type'], senderId: string): Conversation {
  return {
    id: `${type}-chat`,
    type,
    participants,
    lastMessagePreview: 'on my way',
    lastMessage: {
      id: 'message-1',
      conversationId: `${type}-chat`,
      senderId,
      content: 'on my way',
      createdAt: '2026-09-20T20:00:00.000Z',
    },
  };
}

describe('conversation sender context', () => {
  it('labels the first incoming run only in group conversations', () => {
    expect(shouldShowGroupSenderLabel(true, false, 'alice', undefined)).toBe(true);
    expect(shouldShowGroupSenderLabel(true, false, 'alice', 'alice')).toBe(false);
    expect(shouldShowGroupSenderLabel(false, false, 'alice', undefined)).toBe(false);
    expect(shouldShowGroupSenderLabel(true, true, 'me', 'alice')).toBe(false);
  });

  it('prefixes group previews with the participant name', () => {
    expect(getConversationPreview(conversation('group', 'alice'), me))
      .toBe('Alice: on my way');
  });

  it('uses You for an own group message and leaves direct previews bare', () => {
    expect(getConversationPreview(conversation('group', 'me'), me))
      .toBe('You: on my way');
    expect(getConversationPreview(conversation('direct', 'alice'), me))
      .toBe('on my way');
  });
});
