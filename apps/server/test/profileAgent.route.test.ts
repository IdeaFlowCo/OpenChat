import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ ask: vi.fn(), createRule: vi.fn(), session: { close: vi.fn(), run: vi.fn(), executeRead: vi.fn() } }));
vi.mock('../src/db.js', () => ({ getDriver: () => ({ session: () => mocks.session }) }));
vi.mock('../src/websocket/chatHandler.js', () => ({ broadcastMessageToParticipants: vi.fn() }));
vi.mock('../src/lib/ideaflowConnector.js', () => ({ getConnectorPrincipal: () => null }));
vi.mock('../src/services/profileAgent.js', async (orig) => ({ ...(await orig<typeof import('../src/services/profileAgent.js')>()), askProfileAgent: mocks.ask }));
vi.mock('../src/services/autoResponses.js', async (orig) => ({ ...(await orig<typeof import('../src/services/autoResponses.js')>()), createRule: mocks.createRule }));
import { agentReplyRouter, autoResponsesRouter } from '../src/routes/profileAgent.js';
import { ProfileAgentError } from '../src/services/profileAgent.js';
const app = express().use(express.json());
app.use((req, _res, next) => { if (req.headers['x-test-agent-key']) (req as any).agentKeyId = 'key'; next(); });
app.use('/api/chat/agent-reply', agentReplyRouter).use('/api/auto-responses', autoResponsesRouter);
const auth = `Bearer ${jwt.sign({ userId: 'synthetic-asker', email: 'asker@example.test' }, 'dev-secret-change-me')}`;
beforeEach(() => { vi.clearAllMocks(); });

it('requires a signed-in human and a messageId', async () => {
  expect((await request(app).post('/api/chat/agent-reply').send({ messageId: 'm' })).status).toBe(401);
  expect((await request(app).post('/api/chat/agent-reply').set('Authorization', auth).send({})).status).toBe(400);
  expect(mocks.ask).not.toHaveBeenCalled();
});
it('passes only the asker identity and the question, and maps agent errors without leaking details', async () => {
  mocks.ask.mockResolvedValueOnce({ message: { id: 'reply' } });
  const ok = await request(app).post('/api/chat/agent-reply').set('Authorization', auth).send({ messageId: 'm', question: 'When?', ownerId: 'spoofed' });
  expect(ok.status).toBe(201);
  expect(mocks.ask).toHaveBeenCalledWith(expect.objectContaining({ askerId: 'synthetic-asker', messageId: 'm', question: 'When?' }));
  expect(mocks.ask.mock.calls[0]![0]).not.toHaveProperty('ownerId');
  mocks.ask.mockRejectedValueOnce(new ProfileAgentError(429, 'cap', 'This agent has used its monthly allowance. Try again next month.'));
  const capped = await request(app).post('/api/chat/agent-reply').set('Authorization', auth).send({ messageId: 'm' });
  expect(capped.status).toBe(429); expect(capped.body.code).toBe('cap');
  mocks.ask.mockRejectedValueOnce(new Error('synthetic internal detail'));
  const failed = await request(app).post('/api/chat/agent-reply').set('Authorization', auth).send({ messageId: 'm' });
  expect(failed.status).toBe(500); expect(JSON.stringify(failed.body)).not.toContain('internal detail');
});
it('refuses API keys: an agent key cannot spend an agent budget or set auto-send rules', async () => {
  expect((await request(app).post('/api/chat/agent-reply').set('Authorization', auth).set('x-test-agent-key', '1').send({ messageId: 'm' })).status).toBe(403);
  expect((await request(app).post('/api/auto-responses/rules').set('Authorization', auth).set('x-test-agent-key', '1').send({ whenAway: true, action: 'agent', delivery: 'send' })).status).toBe(403);
  expect(mocks.ask).not.toHaveBeenCalled(); expect(mocks.createRule).not.toHaveBeenCalled();
});
