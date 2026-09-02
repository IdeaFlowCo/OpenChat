import { describe, expect, it } from 'vitest';
import {
  getDirectConversationParticipant as getMobileParticipant,
  getDirectConversationTitle as getMobileTitle,
  isSelfDirectConversation as isMobileSelfConversation,
} from '../../mobile/src/utils/conversationDisplay.js';
import {
  getDirectConversationParticipant as getWebParticipant,
  getDirectConversationTitle as getWebTitle,
  isSelfDirectConversation as isWebSelfConversation,
} from '../../web/src/utils/conversationDisplay.js';

const me = { userId: 'user-me', email: 'me@example.test', name: 'Jacob' };
const selfParticipant = { user: { id: me.userId, email: me.email, name: me.name }, role: 'owner' as const };
const otherParticipant = { user: { id: 'user-other', email: 'friend@example.test', name: 'Friend' }, role: 'member' as const };

const mobileSelfConversation = {
  id: 'self',
  type: 'direct' as const,
  participants: [selfParticipant],
};
const webSelfConversation = {
  ...mobileSelfConversation,
  createdAt: '2026-09-02T00:00:00.000Z',
  updatedAt: '2026-09-02T00:00:00.000Z',
};

describe('self-conversation display helpers', () => {
  it('labels a mobile self-chat explicitly while retaining its participant for the avatar', () => {
    expect(isMobileSelfConversation(mobileSelfConversation, me)).toBe(true);
    expect(getMobileTitle(mobileSelfConversation, me, 'Unknown')).toBe('Myself');
    expect(getMobileParticipant(mobileSelfConversation, me)).toEqual(selfParticipant.user);
  });

  it('keeps the legacy web client in parity', () => {
    expect(isWebSelfConversation(webSelfConversation, me)).toBe(true);
    expect(getWebTitle(webSelfConversation, me, 'Unknown')).toBe('Myself');
    expect(getWebParticipant(webSelfConversation, me)).toEqual(selfParticipant.user);
  });

  it('does not depend on the account having a display name', () => {
    const namelessSelf = {
      ...mobileSelfConversation,
      participants: [{ user: { id: me.userId, email: me.email } }],
    };
    expect(getMobileTitle(namelessSelf, me, 'Unknown')).toBe('Myself');
  });

  it('preserves regular direct-message and explicit-title behavior', () => {
    const direct = { ...mobileSelfConversation, id: 'direct', participants: [selfParticipant, otherParticipant] };
    expect(isMobileSelfConversation(direct, me)).toBe(false);
    expect(getMobileTitle(direct, me, 'Unknown')).toBe('Friend');
    expect(getMobileParticipant(direct, me)).toEqual(otherParticipant.user);
    expect(getMobileTitle({ ...direct, title: 'Project room' }, me, 'Unknown')).toBe('Project room');
  });

  it('keeps the self label authoritative over an explicit direct-chat title', () => {
    expect(getMobileTitle({ ...mobileSelfConversation, title: 'Saved notes' }, me, 'Unknown')).toBe('Myself');
    expect(getWebTitle({ ...webSelfConversation, title: 'Saved notes' }, me, 'Unknown')).toBe('Myself');
  });

  it('supports flat participant data returned by search', () => {
    const searchHit = { type: 'direct' as const, participants: [selfParticipant.user] };
    expect(isMobileSelfConversation(searchHit, me)).toBe(true);
    expect(getMobileTitle(searchHit, me, 'Unknown')).toBe('Myself');
    expect(getMobileParticipant(searchHit, me)).toEqual(selfParticipant.user);
    expect(isWebSelfConversation(searchHit, me)).toBe(true);
    expect(getWebTitle(searchHit, me, 'Unknown')).toBe('Myself');
    expect(getWebParticipant(searchHit, me)).toEqual(selfParticipant.user);
  });
});
