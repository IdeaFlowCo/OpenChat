import { describe, expect, it } from 'vitest';
import type { OverlayAsk } from '../api/client';
import { isTodoAsk, parseTodoCommand, todoTitleFromMessage, todosByMessage, todosForConversation, TODO_TITLE_MAX } from './chatTodos';

function ask(patch: Partial<OverlayAsk>): OverlayAsk {
  return {
    revision: 1, id: 'a1', text: 'Introduce Harper to Sia', authorParty: { kind: 'self' }, author: null, own: true, asker: null,
    sources: [], carrier: { kind: 'self' }, placements: [{ kind: 'conversation', conversationId: 'c1' }], fromMe: true, forMe: true,
    horizon: 'short', recheckAfter: '2026-11-24T00:00:00.000Z', needsRecheck: false, status: 'open', exposure: 'only_me', exposureConversationId: null,
    evidence: null, createdAt: '2026-11-10T00:00:00.000Z', updatedAt: '2026-11-10T00:00:00.000Z', closedAt: null, checkedAt: null,
    recordedBy: null, recordedVia: null, assertion: null, ...patch,
  };
}

describe('to-dos are asks the owner both cares about and carries', () => {
  it('excludes asks someone else cares about and asks nobody carries', () => {
    expect(isTodoAsk(ask({}))).toBe(true);
    expect(isTodoAsk(ask({ fromMe: false }))).toBe(false);
    expect(isTodoAsk(ask({ carrier: null }))).toBe(false);
    expect(isTodoAsk(ask({ carrier: { kind: 'user', id: 'u2', name: 'Maya' } }))).toBe(false);
  });

  it('lists only this chat, open in the order noted and done newest first', () => {
    const result = todosForConversation([
      ask({ id: 'later', createdAt: '2026-11-10T02:00:00.000Z' }),
      ask({ id: 'first', createdAt: '2026-11-10T01:00:00.000Z' }),
      ask({ id: 'elsewhere', placements: [{ kind: 'conversation', conversationId: 'c2' }] }),
      ask({ id: 'unplaced', placements: [{ kind: 'self' }] }),
      ask({ id: 'friends-ask', fromMe: false, carrier: null }),
      ask({ id: 'done-old', status: 'fulfilled', closedAt: '2026-11-09T00:00:00.000Z' }),
      ask({ id: 'done-new', status: 'withdrawn', closedAt: '2026-11-10T03:00:00.000Z' }),
    ], 'c1');
    expect(result.open.map(todo => todo.id)).toEqual(['first', 'later']);
    expect(result.done.map(todo => todo.id)).toEqual(['done-new', 'done-old']);
  });

  it('maps a source message to its to-do in this conversation only', () => {
    const source = { app: 'openchat', conversationId: 'c1', messageId: 'copy', sourceMessageId: 'm1', itemIndex: 0, excerpt: 'x', assertion: 'stated', audienceIntent: null, recordedAt: '' };
    const { open } = todosForConversation([ask({ sources: [source, { ...source, conversationId: 'c2', sourceMessageId: 'm9' }, { ...source, app: 'whatsapp', sourceMessageId: 'w1' }] })], 'c1');
    const map = todosByMessage(open, 'c1');
    expect([...map.keys()]).toEqual(['m1']);
  });
});

describe('a title from a message', () => {
  it('takes the first non-empty line and flattens spacing', () => {
    expect(todoTitleFromMessage('\n  Intro   Harper\tto Sia \nsecond line')).toBe('Intro Harper to Sia');
    expect(todoTitleFromMessage('')).toBe('');
    expect(todoTitleFromMessage(null)).toBe('');
  });

  it('cuts long lines at a word within the limit', () => {
    const title = todoTitleFromMessage('word '.repeat(80));
    expect(title.length).toBeLessThanOrEqual(TODO_TITLE_MAX);
    expect(title.endsWith('…')).toBe(true);
    expect(title).not.toMatch(/\s…$/);
  });
});

describe('the /todo composer command never reads as a chat message', () => {
  it.each([
    ['/todo introduce Harper to Sia', 'introduce Harper to Sia'],
    ['  /TODO  call  Sia ', 'call Sia'],
    ['/todo: email the deck', 'email the deck'],
    ['/todo\nmultiple\nlines', 'multiple lines'],
    ['/todo', ''],
    ['/todo   ', ''],
  ])('%j is a command', (input, text) => {
    expect(parseTodoCommand(input)).toEqual({ isCommand: true, text });
  });

  it.each(['todo buy milk', 'see /todo later', '/todos are great', '/todo-list', '/to do', ''])('%j is an ordinary message', input => {
    expect(parseTodoCommand(input)).toEqual({ isCommand: false });
  });
});
