import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Regression coverage for Jacob's report: "our app is truncating long
// messages. It shouldn't do that." Reproduces the full send + fetch
// round-trip for a long (5000+ char) message through the real route
// handlers in src/routes/chat.ts, with Neo4j mocked at the session level
// (same pattern as chatAttachments.route.test.ts / chatMarkUnread.route.test.ts).

const db = vi.hoisted(() => ({ run: vi.fn(), close: vi.fn(async () => {}) }));
vi.mock('../src/db.js', () => ({ getDriver: () => ({ session: () => db }) }));

import chatRouter from '../src/routes/chat.js';

const app = express().use(express.json()).use('/api/chat', chatRouter);
const token = () => jwt.sign({ userId: 'member', email: 'member@example.test' }, process.env.JWT_SECRET || 'dev-secret-change-me');
const auth = () => `Bearer ${token()}`;

// The server trims leading/trailing whitespace off a sent message (same as the
// composer), so this fixture has none — any mid-string character loss below is
// what the test is actually watching for, not an artifact of `.trim()`.
const LONG_CONTENT = 'The quick brown fox jumps over the lazy dog.'.repeat(120); // ~5,400 chars

beforeEach(() => { vi.resetAllMocks(); });

describe('long message content round-trips without truncation', () => {
  it('POST /conversations/:id/messages echoes the full content back, unmodified', async () => {
    expect(LONG_CONTENT.length).toBeGreaterThan(5000);

    // 1) participation + block check
    db.run.mockResolvedValueOnce({
      records: [{ get: (key: string) => (key === 'blockedRelationship' ? false : {}) }],
    });
    // 2) the MERGE/insert query — server should hand back exactly what it was given.
    db.run.mockResolvedValueOnce({
      records: [{
        get: (key: string) => {
          if (key === 'message') {
            return {
              id: 'm-long-1',
              content: LONG_CONTENT,
              senderId: 'member',
              conversationId: 'conv-1',
              messageType: 'text',
              createdAt: '2026-10-22T00:00:00.000Z',
              sender: { id: 'member', name: 'Member' },
            };
          }
          if (key === 'participantIds') return ['member'];
          if (key === 'wasCreated') return true;
          return undefined;
        },
      }],
    });

    const res = await request(app)
      .post('/api/chat/conversations/conv-1/messages')
      .set('Authorization', auth())
      .send({ content: LONG_CONTENT });

    expect(res.status).toBe(201);
    expect(res.body.content).toBe(LONG_CONTENT);
    expect(res.body.content.length).toBe(LONG_CONTENT.length);

    // The content that actually reached the Cypher query must be the full,
    // untrimmed-of-anything-but-whitespace string — not a sliced copy.
    const insertCall = db.run.mock.calls[1];
    expect(insertCall[1].content).toBe(LONG_CONTENT);
  });

  it('GET /conversations/:id/messages returns the full content for a previously-sent long message', async () => {
    // Participation check for the GET route.
    db.run.mockResolvedValueOnce({ records: [{ get: () => ({}) }] });
    // The messages page query.
    db.run.mockResolvedValueOnce({
      records: [{
        get: (key: string) => {
          if (key !== 'message') return undefined;
          return {
            id: 'm-long-1',
            content: LONG_CONTENT,
            senderId: 'other',
            conversationId: 'conv-1',
            messageType: 'text',
            createdAt: '2026-10-22T00:00:00.000Z',
            sender: { id: 'other', name: 'Other' },
            reactions: [],
            replyTo: null,
          };
        },
      }],
    });

    // loadPreviewsForMessages (no previews for this message).
    db.run.mockResolvedValueOnce({ records: [] });

    const res = await request(app)
      .get('/api/chat/conversations/conv-1/messages')
      .set('Authorization', auth());

    expect(res.status).toBe(200);
    expect(res.body.messages).toHaveLength(1);
    expect(res.body.messages[0].content).toBe(LONG_CONTENT);
    expect(res.body.messages[0].content.length).toBe(LONG_CONTENT.length);
  });
});
