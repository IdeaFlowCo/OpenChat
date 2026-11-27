import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ ask: vi.fn(), askMine: vi.fn(), createRule: vi.fn(), session: { close: vi.fn(), run: vi.fn(), executeRead: vi.fn() } }));
vi.mock('../src/db.js', () => ({ getDriver: () => ({ session: () => mocks.session }) }));
vi.mock('../src/websocket/chatHandler.js', () => ({ broadcastMessageToParticipants: vi.fn() }));
vi.mock('../src/lib/ideaflowConnector.js', () => ({ getConnectorPrincipal: () => null }));
vi.mock('../src/services/profileAgent.js', async (orig) => ({ ...(await orig<typeof import('../src/services/profileAgent.js')>()), askProfileAgent: mocks.ask }));
vi.mock('../src/services/threadAgent.js', async (orig) => ({ ...(await orig<typeof import('../src/services/threadAgent.js')>()), askThreadAgent: mocks.askMine }));
vi.mock('../src/services/autoResponses.js', async (orig) => ({ ...(await orig<typeof import('../src/services/autoResponses.js')>()), createRule: mocks.createRule }));
import { agentReplyRouter, autoResponsesRouter, isDirectHumanSession } from '../src/routes/profileAgent.js';
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
it('availability needs a signed-in human and a messageId', async () => {
  expect((await request(app).get('/api/chat/agent-reply/availability?messageId=m')).status).toBe(401);
  expect((await request(app).get('/api/chat/agent-reply/availability').set('Authorization', auth)).status).toBe(400);
  expect((await request(app).get('/api/chat/agent-reply/availability?messageId=m').set('Authorization', auth).set('x-test-agent-key', '1')).status).toBe(403);
});
it('agent:"mine" asks the caller’s own thread agent, for signed-in people only, and nothing else is accepted', async () => {
  mocks.askMine.mockResolvedValueOnce({ message: { id: 'reply' } });
  const ok = await request(app).post('/api/chat/agent-reply').set('Authorization', auth).send({ messageId: 'm', question: 'What is open?', agent: 'mine', askerId: 'spoofed' });
  expect(ok.status).toBe(201);
  expect(mocks.askMine).toHaveBeenCalledWith(expect.objectContaining({ askerId: 'synthetic-asker', messageId: 'm', question: 'What is open?' }));
  expect(mocks.ask).not.toHaveBeenCalled();
  expect((await request(app).post('/api/chat/agent-reply').set('Authorization', auth).send({ messageId: 'm', agent: 'ana' })).status).toBe(400);
  expect((await request(app).post('/api/chat/agent-reply').set('Authorization', auth).set('x-test-agent-key', '1').send({ messageId: 'm', agent: 'mine' })).status).toBe(403);
  expect((await request(app).post('/api/chat/agent-reply').send({ messageId: 'm', agent: 'mine' })).status).toBe(401);
  expect(mocks.askMine).toHaveBeenCalledOnce();
  const avail = await request(app).get('/api/chat/agent-reply/availability?messageId=m&agent=mine').set('Authorization', auth);
  expect(avail.status).toBe(200); expect(avail.body).toMatchObject({ enabled: true });
});
it('only a direct signed-in session counts as a person for the @agent send trigger', () => {
  const req = (over: Record<string, unknown>) => ({ headers: {}, user: { userId: 'u' }, ...over }) as never;
  expect(isDirectHumanSession(req({}))).toBe(true);
  expect(isDirectHumanSession(req({ agentKeyId: 'key' }))).toBe(false);
  expect(isDirectHumanSession(req({ connectorDelegation: { id: 'd' } }))).toBe(false);
  expect(isDirectHumanSession(req({ user: { userId: 'u', embedded: 'vision' } }))).toBe(false);
});
