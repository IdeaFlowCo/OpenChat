import { describe, expect, it } from 'vitest';
import type { Conversation, User } from '../api/client';
import { buildComposeSections, matchRank, RECENT_LIMIT } from './composeSections';

const user = (id: string, name: string): User => ({ id, name });
const dm = (other: User, lastMessageAt?: string): Conversation => ({
  id: `c-${other.id}`, type: 'direct', lastMessageAt,
  participants: [{ user: { id: 'me', name: 'Me' } }, { user: other }],
});

describe('matchRank', () => {
  it('prefers a word prefix over a substring', () => {
    expect(matchRank('Claire Dubois', 'cla')).toBe(0);
    expect(matchRank('Claire Dubois', 'dub')).toBe(0);
    expect(matchRank('Maclaire', 'clai')).toBe(1);
    expect(matchRank('Bob', 'cla')).toBeNull();
    expect(matchRank('Anyone', '  ')).toBe(0);
  });
});

describe('buildComposeSections', () => {
  const claire = user('claire', 'Claire'), harrison = user('harrison', 'Harrison Qian'), adam = user('adam', 'Adam');
  const conversations = [
    dm(harrison, '2026-10-08T00:00:00Z'),
    dm(claire, '2026-10-09T00:00:00Z'),
    { id: 'g1', type: 'group', lastMessageAt: '2026-10-10T00:00:00Z', participants: [{ user: adam }] } as Conversation,
    dm(adam), // never messaged: not recent
  ];

  it('orders recent direct chats newest first, then friends, then the directory without repeats', () => {
    const sections = buildComposeSections({
      conversations, friends: [user('zed', 'Zed'), claire, user('bea', 'Bea')],
      directory: [user('me', 'Me'), adam, claire, user('zed', 'Zed')], currentUserId: 'me', query: '',
    });
    expect(sections.recent.map(u => u.id)).toEqual(['claire', 'harrison']);
    expect(sections.friends.map(u => u.id)).toEqual(['bea', 'zed']);
    expect(sections.everyone.map(u => u.id)).toEqual(['me', 'adam']);
  });

  it('caps recent with no query but shows every recent match while searching', () => {
    const many = Array.from({ length: RECENT_LIMIT + 3 }, (_, i) => dm(user(`p${i}`, `Pat ${i}`), `2026-10-0${(i % 9) + 1}T00:00:00Z`));
    expect(buildComposeSections({ conversations: many, friends: [], directory: [], currentUserId: 'me', query: '' }).recent).toHaveLength(RECENT_LIMIT);
    expect(buildComposeSections({ conversations: many, friends: [], directory: [], currentUserId: 'me', query: 'pat' }).recent).toHaveLength(RECENT_LIMIT + 3);
  });

  it('finds someone you already talk to instantly, before any directory result', () => {
    const sections = buildComposeSections({ conversations, friends: [], directory: [], currentUserId: 'me', query: 'cla' });
    expect(sections.recent.map(u => u.id)).toEqual(['claire']);
    expect(buildComposeSections({ conversations, friends: [], directory: [], currentUserId: 'me', query: 'qian' }).recent.map(u => u.id)).toEqual(['harrison']);
  });
});
