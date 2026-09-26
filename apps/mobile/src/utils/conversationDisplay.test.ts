import { describe, expect, it } from 'vitest';
import type { Conversation, CurrentUser } from '../api/client';
import {
  AGENT_DISPLAY_NAME,
  getDirectConversationTitle,
  getUserDisplayName,
  SELF_CONVERSATION_TITLE,
} from './conversationDisplay';

const me: CurrentUser = { userId: 'me-user-id', email: 'me@example.test', name: 'Me' };

describe('conversationDisplay', () => {
  it('returns AGENT_DISPLAY_NAME for assistant bot participant', () => {
    const assistantConv: Conversation = {
      id: 'conv-assistant',
      type: 'direct',
      participants: [
        { user: { id: 'me-user-id', name: 'Me' }, role: 'member' },
        { user: { id: 'assistant', name: 'Assistant', isBot: true }, role: 'member' },
      ],
    };

    expect(getDirectConversationTitle(assistantConv, me, 'Fallback')).toBe('OpenChat Agent');
    expect(AGENT_DISPLAY_NAME).toBe('OpenChat Agent');
  });

  it('returns SELF_CONVERSATION_TITLE for self DM', () => {
    const selfConv: Conversation = {
      id: 'conv-self',
      type: 'direct',
      participants: [
        { user: { id: 'me-user-id', name: 'Me' }, role: 'member' },
      ],
    };

    expect(getDirectConversationTitle(selfConv, me, 'Fallback')).toBe(SELF_CONVERSATION_TITLE);
  });

  it('returns other user name for standard DM', () => {
    const peerConv: Conversation = {
      id: 'conv-peer',
      type: 'direct',
      participants: [
        { user: { id: 'me-user-id', name: 'Me' }, role: 'member' },
        { user: { id: 'alice-id', name: 'Alice' }, role: 'member' },
      ],
    };

    expect(getDirectConversationTitle(peerConv, me, 'Fallback')).toBe('Alice');
  });

  it('formats user display name correctly', () => {
    expect(getUserDisplayName({ name: 'Bob', email: 'bob@example.com' })).toBe('Bob');
    expect(getUserDisplayName({ email: 'carol@example.com' })).toBe('carol');
    expect(getUserDisplayName(null)).toBe('OpenChat member');
  });
});
