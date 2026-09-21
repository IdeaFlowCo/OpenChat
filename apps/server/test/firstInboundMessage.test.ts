import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  run: vi.fn(async () => ({ records: [] })),
  close: vi.fn(async () => undefined),
}));

vi.mock('../src/db.js', () => ({
  getDriver: () => ({
    session: () => ({ run: db.run, close: db.close }),
  }),
}));

import { CONVERSATIONS_QUERY } from '../src/queries/chatUnread.js';
import {
  broadcastMessageToParticipants,
  setupChatSocket,
} from '../src/websocket/chatHandler.js';
import { ensureDirectConversation } from '../src/services/directConversation.js';

describe('first inbound message delivery contract', () => {
  beforeEach(() => {
    db.run.mockClear();
    db.close.mockClear();
  });

  it('joins every authenticated socket to its per-user room on connect', () => {
    let onConnection: ((socket: unknown) => void) | undefined;
    const io = {
      use: vi.fn(),
      on: vi.fn((event: string, handler: (socket: unknown) => void) => {
        if (event === 'connection') onConnection = handler;
      }),
      to: vi.fn(() => ({ emit: vi.fn() })),
      emit: vi.fn(),
    };
    const socket = {
      id: 'socket-a',
      user: { userId: 'recipient-a', email: 'a@example.test' },
      join: vi.fn(),
      on: vi.fn(),
    };

    setupChatSocket(io as never);
    expect(onConnection).toBeTypeOf('function');
    onConnection!(socket);

    expect(socket.join).toHaveBeenCalledWith('user:recipient-a');
  });

  it('fans message:new out to every participant user room', () => {
    const emit = vi.fn();
    const rooms: string[] = [];
    const operator = {
      to: vi.fn((room: string) => {
        rooms.push(room);
        return operator;
      }),
      emit,
    };
    const io = {
      to: vi.fn((room: string) => {
        rooms.push(room);
        return operator;
      }),
    };
    const message = { id: 'message-1', conversationId: 'new-dm' };

    broadcastMessageToParticipants(
      io as never,
      ['sender-b', 'recipient-a'],
      message,
    );

    expect(rooms).toEqual(['user:sender-b', 'user:recipient-a']);
    expect(emit).toHaveBeenCalledWith('message:new', message);
  });

  it('emits conversation:created to both sides of a newly created DM', async () => {
    const conversation = {
      id: 'new-dm',
      type: 'direct',
      participants: [
        { user: { id: 'recipient-a', name: 'A' }, role: 'member' },
        { user: { id: 'sender-b', name: 'B' }, role: 'owner' },
      ],
    };
    db.run
      .mockResolvedValueOnce({
        records: [{ get: (key: string) => key === 'allowed' ? true : undefined }],
      })
      .mockResolvedValueOnce({
        records: [{
          get: (key: string) => key === 'conversation' ? conversation : key === 'created',
        }],
      });
    const emit = vi.fn();
    const io = {
      to: vi.fn(() => ({ emit })),
      sockets: { sockets: new Map() },
    };

    await expect(ensureDirectConversation('sender-b', 'recipient-a', io as never))
      .resolves.toMatchObject({ created: true, conversation: { id: 'new-dm' } });

    expect(io.to).toHaveBeenCalledWith('user:recipient-a');
    expect(io.to).toHaveBeenCalledWith('user:sender-b');
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenCalledWith('conversation:created', {
      conversationId: 'new-dm',
      conversation,
    });
  });

  it('lists conversations by participation, independent of creator or open state', () => {
    expect(CONVERSATIONS_QUERY).toContain(
      'MATCH (u:User {id: $userId})-[myRel:PARTICIPATES_IN]->(c:Conversation)',
    );
    expect(CONVERSATIONS_QUERY).not.toMatch(/createdBy|openedAt|joined\/opened/i);
  });

  it('loads the preview sender through the message conversationId property', () => {
    expect(CONVERSATIONS_QUERY).toContain('WHERE m.conversationId = c.id');
    expect(CONVERSATIONS_QUERY).toContain('.senderId');
    expect(CONVERSATIONS_QUERY).not.toContain('OPTIONAL MATCH (c)<-[:IN_CONVERSATION]-(m:Message)');
  });
});
