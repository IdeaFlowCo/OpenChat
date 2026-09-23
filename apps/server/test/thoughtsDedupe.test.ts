import express from 'express';
import jwt from 'jsonwebtoken';
import neo4j from 'neo4j-driver';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  close: vi.fn(),
}));

vi.mock('../src/db.js', () => ({
  getDriver: () => ({
    session: () => ({
      run: mocks.run,
      close: mocks.close,
    }),
  }),
}));

import thoughtsRouter, { mergeDuplicateThoughtsFromSameMessage } from '../src/routes/thoughts.js';

describe('mergeDuplicateThoughtsFromSameMessage (OpenChat-kb7f legacy dedupe)', () => {
  it('merges rows sharing the same source message + text into one, unioning tags', () => {
    // Rows arrive newest-first, matching ORDER BY t.createdAt DESC — the
    // per-tag fan-out created the '#decision' Thought after the '#fact' one.
    const rows = [
      {
        id: 'thought-2',
        text: '#fact #decision we ship Friday',
        kind: 'decision',
        status: 'none',
        createdAt: '2026-09-20T10:00:01.000Z',
        updatedAt: '2026-09-20T10:00:01.000Z',
        tags: ['decision'],
        sourceMessageId: 'msg-1',
        sourceConversationId: 'conv-1',
        sourceConversationName: 'Team',
      },
      {
        id: 'thought-1',
        text: '#fact #decision we ship Friday',
        kind: 'fact',
        status: 'none',
        createdAt: '2026-09-20T10:00:00.000Z',
        updatedAt: '2026-09-20T10:00:00.000Z',
        tags: ['fact'],
        sourceMessageId: 'msg-1',
        sourceConversationId: 'conv-1',
        sourceConversationName: 'Team',
      },
    ];

    const merged = mergeDuplicateThoughtsFromSameMessage(rows);

    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe('thought-1'); // earliest wins
    expect(merged[0].kind).toBe('fact');
    expect(merged[0].tags).toEqual(['decision', 'fact']);
  });

  it('leaves thoughts without a source message untouched', () => {
    const rows = [
      { id: 'a', text: 'hello', tags: [], sourceMessageId: null },
      { id: 'b', text: 'hello', tags: [], sourceMessageId: null },
    ];
    expect(mergeDuplicateThoughtsFromSameMessage(rows)).toEqual(rows);
  });

  it('does not merge same-message rows with different text', () => {
    const rows = [
      { id: 'a', text: '#fact one thing', tags: ['fact'], sourceMessageId: 'msg-1' },
      { id: 'b', text: '#fact one thing edited', tags: ['fact'], sourceMessageId: 'msg-1' },
    ];
    expect(mergeDuplicateThoughtsFromSameMessage(rows)).toHaveLength(2);
  });
});

describe('GET /api/thoughts (route-level dedupe)', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/thoughts', thoughtsRouter);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not bind');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it('returns one merged thought for a legacy two-tag duplicate pair', async () => {
    mocks.run.mockResolvedValueOnce({
      records: [
        {
          get: () => ({
            id: 'thought-2',
            text: '#fact #decision we ship Friday',
            kind: 'decision',
            status: 'none',
            createdAt: neo4j.types.DateTime.fromStandardDate(new Date('2026-09-20T10:00:01.000Z')),
            updatedAt: neo4j.types.DateTime.fromStandardDate(new Date('2026-09-20T10:00:01.000Z')),
            tags: ['decision'],
            sourceMessageId: 'msg-1',
            sourceConversationId: 'conv-1',
            sourceConversationName: 'Team',
          }),
        },
        {
          get: () => ({
            id: 'thought-1',
            text: '#fact #decision we ship Friday',
            kind: 'fact',
            status: 'none',
            createdAt: neo4j.types.DateTime.fromStandardDate(new Date('2026-09-20T10:00:00.000Z')),
            updatedAt: neo4j.types.DateTime.fromStandardDate(new Date('2026-09-20T10:00:00.000Z')),
            tags: ['fact'],
            sourceMessageId: 'msg-1',
            sourceConversationId: 'conv-1',
            sourceConversationName: 'Team',
          }),
        },
      ],
    });

    const token = jwt.sign({ userId: 'user-1', email: 'user1@example.test' }, 'dev-secret-change-me');
    const response = await fetch(`${baseUrl}/api/thoughts`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as Array<{ id: string; tags: string[]; kind: string }>;
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe('thought-1');
    expect(body[0].kind).toBe('fact');
    expect(body[0].tags.slice().sort()).toEqual(['decision', 'fact']);
  });

  it("shows one participant another participant's hashtag thought", async () => {
    const sharedThought = {
      id: 'thought-by-sol',
      text: 'The launch is Friday #decision',
      kind: 'decision',
      status: 'none',
      createdAt: '2026-09-20T10:00:00.000Z',
      updatedAt: '2026-09-20T10:00:00.000Z',
      tags: ['decision'],
      sourceMessageId: 'msg-by-sol',
      sourceConversationId: 'conv-shared',
      authorId: 'sol',
      authorName: 'Sol',
      pinned: false,
    };

    mocks.run
      // Jacob is a participant in the conversation.
      .mockResolvedValueOnce({ records: [{ get: () => 'conv-shared' }] })
      // Nothing is pinned.
      .mockResolvedValueOnce({ records: [] })
      // Reproduce the bug: the old query starts from Jacob's HAS_THOUGHT edge,
      // so Neo4j cannot return the Thought authored by Sol.
      .mockImplementationOnce(async (query: string) => ({
        records: query.includes('(u:User {id: $userId})-[:HAS_THOUGHT]->(t:Thought)')
          ? []
          : [{ get: () => sharedThought }],
      }));

    const token = jwt.sign(
      { userId: 'jacob', email: 'jacob@example.test' },
      'dev-secret-change-me',
    );
    const response = await fetch(`${baseUrl}/api/thoughts/conversation/conv-shared`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ pinned: [], fromChat: [sharedThought] });

    const [fromChatQuery, params] = mocks.run.mock.calls[2] as [
      string,
      Record<string, unknown>,
    ];
    expect(fromChatQuery).not.toContain(
      '(u:User {id: $userId})-[:HAS_THOUGHT]->(t:Thought)',
    );
    expect(fromChatQuery).toContain("t.captureMethod IN ['inline-tag', 'reply-tag']");
    expect(fromChatQuery).toContain('size(coalesce(t.tags, [])) > 0');
    expect(fromChatQuery).toContain('authorId: t.userId');
    expect(params).toEqual({ userId: 'jacob', conversationId: 'conv-shared' });
  });
});
