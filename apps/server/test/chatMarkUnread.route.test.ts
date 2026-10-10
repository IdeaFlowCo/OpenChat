import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { beforeEach, expect, it, vi } from 'vitest';
const db = vi.hoisted(() => ({ run: vi.fn(), close: vi.fn() }));
vi.mock('../src/db.js', () => ({ getDriver: () => ({ session: () => db }) }));
import chatRouter from '../src/routes/chat.js';
import { CONVERSATIONS_QUERY, UNREAD_TOTAL_QUERY } from '../src/queries/chatUnread.js';
const app = express().use(express.json()).use('/api/chat', chatRouter);
const token = (claims: Record<string, unknown> = {}) => jwt.sign({ userId: 'member', email: 'member@example.test', ...claims }, 'dev-secret-change-me');
beforeEach(() => { vi.resetAllMocks(); db.run.mockResolvedValue({ records: [{ get: () => 'conv-1' }] }); });

it('marks a conversation unread for the caller only, including embedded Unlinked sessions', async () => {
  for (const claims of [{}, { embedded: 'unlinked' }]) {
    db.run.mockClear()
    const reply = await request(app).patch('/api/chat/conversations/conv-1/unread').set('Authorization', `Bearer ${token(claims)}`);
    expect(reply.status).toBe(200); expect(reply.body).toEqual({ ok: true, conversationId: 'conv-1', markedUnread: true });
    const [cypher, params] = db.run.mock.calls[0];
    expect(cypher).toContain('MATCH (u:User {id: $userId})-[rel:PARTICIPATES_IN]->(c:Conversation {id: $conversationId})');
    expect(cypher).toContain('SET rel.markedUnreadAt'); expect(cypher).not.toContain('lastReadAt');
    expect(params).toMatchObject({ userId: 'member', conversationId: 'conv-1' });
  }
});

it('is 404 for a conversation the caller is not in, and 401 without a token', async () => {
  db.run.mockResolvedValue({ records: [] });
  expect((await request(app).patch('/api/chat/conversations/other/unread').set('Authorization', `Bearer ${token()}`)).status).toBe(404);
  expect((await request(app).patch('/api/chat/conversations/conv-1/unread')).status).toBe(401);
});

it('reading clears the mark; list and total count a marked conversation as at least one', async () => {
  db.run.mockResolvedValueOnce({ records: [{ get: () => ({}) }] }).mockResolvedValueOnce({ records: [] });
  await request(app).patch('/api/chat/conversations/conv-1/read').set('Authorization', `Bearer ${token()}`);
  expect(db.run.mock.calls[0][0]).toContain('REMOVE rel.markedUnreadAt');
  expect(CONVERSATIONS_QUERY).toContain('markedUnread: myRel.markedUnreadAt IS NOT NULL');
  expect(CONVERSATIONS_QUERY).toContain('CASE WHEN unreadCount = 0 AND myRel.markedUnreadAt IS NOT NULL THEN 1 ELSE unreadCount END');
  expect(UNREAD_TOTAL_QUERY).toContain('CASE WHEN unread = 0 AND myRel.markedUnreadAt IS NOT NULL THEN 1 ELSE unread END');
});
