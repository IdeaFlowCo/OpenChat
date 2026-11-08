import { afterEach, describe, expect, it } from 'vitest';
import {
  conversationTitleFor,
  formatDocumentTitle,
  publishConversationTitle,
  resolveDocumentTitle,
} from './documentTitle';

const cleanups: Array<() => void> = [];
const publish = (id: string, title: string, embedded = false) => {
  const off = publishConversationTitle(id, title, embedded);
  cleanups.push(off);
  return off;
};
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

describe('formatDocumentTitle', () => {
  it('puts the open thing first, then the app', () => {
    expect(formatDocumentTitle({ screenTitle: 'Settings' })).toBe('Settings — OpenChat');
    expect(formatDocumentTitle({ conversationTitle: 'Alice', screenTitle: '' })).toBe('Alice — OpenChat');
  });

  it('shows the unread count on the chat list only', () => {
    expect(formatDocumentTitle({ screenTitle: 'Chats', unreadTotal: 3 })).toBe('Chats (3) — OpenChat');
    expect(formatDocumentTitle({ screenTitle: 'Chats', unreadTotal: 0 })).toBe('Chats — OpenChat');
    expect(formatDocumentTitle({ conversationTitle: 'Alice', screenTitle: 'Chats', unreadTotal: 3 })).toBe('Alice — OpenChat');
    expect(formatDocumentTitle({ screenTitle: 'Settings', unreadTotal: 3 })).toBe('Settings — OpenChat');
  });

  it('falls back to the app name instead of a blank or doubled title', () => {
    expect(formatDocumentTitle({})).toBe('OpenChat');
    expect(formatDocumentTitle({ screenTitle: '  ' })).toBe('OpenChat');
    expect(formatDocumentTitle({ screenTitle: 'OpenChat' })).toBe('OpenChat');
  });
});

describe('resolveDocumentTitle', () => {
  it('names a pushed conversation from its route params', () => {
    publish('c1', 'Alice');
    publish('c2', 'Design team');
    expect(resolveDocumentTitle({ routeName: 'Chat', optionTitle: '', routeConversationId: 'c2', unreadTotal: 4 }))
      .toBe('Design team — OpenChat');
  });

  it('shows the generic title while a conversation is still loading', () => {
    expect(resolveDocumentTitle({ routeName: 'Chat', optionTitle: '', routeConversationId: 'c9' })).toBe('OpenChat');
  });

  it('names the conversation open in the desktop pane, else the list with its count', () => {
    publish('c1', 'Alice', true);
    expect(resolveDocumentTitle({ routeName: 'Conversations', optionTitle: 'Chats', activeConversationId: 'c1', unreadTotal: 2 }))
      .toBe('Alice — OpenChat');
    expect(resolveDocumentTitle({ routeName: 'Conversations', optionTitle: 'Chats', activeConversationId: null, unreadTotal: 2 }))
      .toBe('Chats (2) — OpenChat');
  });

  it('ignores a stale selection on the compact list (no embedded pane)', () => {
    publish('c1', 'Alice', false);
    expect(resolveDocumentTitle({ routeName: 'Conversations', optionTitle: 'Chats', activeConversationId: 'c1' }))
      .toBe('Chats — OpenChat');
  });

  it('uses the screen on top of a conversation, not the conversation', () => {
    publish('c1', 'Alice');
    expect(resolveDocumentTitle({ routeName: 'GroupInfo', optionTitle: 'Group Info', activeConversationId: 'c1' }))
      .toBe('Group Info — OpenChat');
  });

  it('names untitled auth screens', () => {
    expect(resolveDocumentTitle({ routeName: 'Login' })).toBe('Sign in — OpenChat');
  });
});

describe('publishConversationTitle', () => {
  it('keeps an earlier mount of the same conversation when a later one unmounts', () => {
    publish('c1', 'Alice');
    const offTop = publish('c1', 'Alice (renamed)');
    expect(conversationTitleFor('c1')).toBe('Alice (renamed)');
    offTop();
    expect(conversationTitleFor('c1')).toBe('Alice');
  });
});
