import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ run: vi.fn(), effect: vi.fn(), push: vi.fn(), reply: vi.fn() }));
vi.mock('../src/db.js', () => ({ getDriver: () => ({ session: () => ({ run: mocks.run, close: async () => {} }) }) }));
vi.mock('../src/websocket/chatHandler.js', () => ({ broadcastMessageToParticipants: mocks.effect,
  fanoutPushForMessage: async (...args: unknown[]) => mocks.push(...args), joinUserSocketsToConversation: vi.fn(),
  leaveUserSocketsFromConversation: vi.fn(), isUserOnline: vi.fn() }));
vi.mock('../src/services/linkPreview.js', () => ({ processLinkPreviews: mocks.effect, loadPreviewsForMessages: vi.fn() }));
vi.mock('../src/services/extractThoughtsFromMessage.js', () => ({ createThoughtsFromMessageTags: async () => mocks.effect() }));
vi.mock('../src/services/assistantTrigger.js', () => ({ maybeTriggerAssistant: mocks.effect }));
vi.mock('../src/services/secretary.js', () => ({ maybeTriggerSecretary: mocks.effect }));
vi.mock('../src/services/webhookDispatch.js', () => ({ dispatchMessageEvent: mocks.effect }));
vi.mock('../src/services/embeddings.js', () => ({ embedAndStoreMessage: async () => mocks.effect(),
  semanticSearchMessages: vi.fn(), embeddingsEnabled: vi.fn() }));
vi.mock('../src/services/visionBridge.js', async (original) => ({ ...(await original<typeof import('../src/services/visionBridge.js')>()), scheduleVisionReplyDelivery: mocks.reply }));
import chatRoutes from '../src/routes/chat.js';
import { connectorOperationGuard } from '../src/routes/ideaflowConnector.js';
import { issueConnectorOperation } from '../src/lib/ideaflowConnector.js';

const record = (values: Record<string, unknown>) => ({ get: (key: string) => values[key] });
const secret = process.env.JWT_SECRET || 'dev-secret-change-me';
const human = jwt.sign({ userId: 'alice', email: 'alice@example.test' }, secret);
const provenance = { service: 'vision', noteId: 'note-1', noteRevision: 3, loopId: 'loop-1', ownerSubject: 'alice-sub' };

describe('REST send: connector idempotency, Vision provenance and mentions', () => {
  const messages = new Map<string, Record<string, unknown>>();
  const queries: Array<{ query: string; params: Record<string, unknown> }> = [];
  let convType = 'group';
  const app = express();
  app.use(express.json());
  app.set('io', {});
  app.use('/api', connectorOperationGuard);
  app.use('/api/chat', chatRoutes);

  beforeEach(() => {
    messages.clear(); queries.length = 0; convType = 'group';
    mocks.effect.mockReset(); mocks.push.mockReset().mockResolvedValue(undefined); mocks.reply.mockReset(); mocks.run.mockReset();
    mocks.run.mockImplementation(async (query: string, params: Record<string, unknown>) => {
      queries.push({ query, params });
      if (query.includes('blockedRelationship')) return { records: [record({ blockedRelationship: false })] };
      if (query.includes('u.ideaflowIssuer AS issuer')) return { records: [record({ issuer: 'https://id.ideaflow.app/api/auth', subject: 'alice-sub' })] };
      if (query.includes('c.type AS convType')) return { records: [record({ convType })] };
      if (query.includes('p.name AS pname')) return { records: [record({ pid: 'bob', pname: 'Bob Stone' }), record({ pid: 'carol', pname: 'Carol' })] };
      if (query.includes('RETURN m.id AS id')) return { records: [record({ id: params.replyToId })] };
      if (query.trim().startsWith('MATCH (m:Message {id: $id}) RETURN m { .* }')) {
        const message = messages.get(params.id as string);
        return { records: message ? [record({ message })] : [] };
      }
      const existing = messages.get(params.id as string);
      const message = existing ?? { id: params.id, content: params.content, senderId: params.senderId, conversationId: params.conversationId,
        mentions: params.mentions, provenanceService: params.provenanceService, replyToId: params.replyToId };
      messages.set(params.id as string, message);
      return { records: [record({ message, participantIds: ['alice', 'bob', 'carol'], wasCreated: !existing })] };
    });
  });

  const connectorSend = (body: Record<string, unknown>, conversation = 'room') => {
    const path = `/api/chat/conversations/${conversation}/messages`;
    const token = issueConnectorOperation('alice', { method: 'POST', path, body }, ['openchat:write'], 'Vision');
    return request(app).post(path).set('Authorization', `Bearer ${token}`).send(body);
  };

  it('a unified-connector retry with the same clientRequestId returns the original message, once', async () => {
    const body = { content: 'Hello from Vision', clientRequestId: 'receipt-1' };
    const first = await connectorSend(body);
    expect(first.status).toBe(201);
    expect(first.body.id).toMatch(/^ocu_[a-f0-9]{64}$/);
    const retry = await connectorSend(body);
    expect(retry.status).toBe(200);
    expect(retry.body.id).toBe(first.body.id);
    expect(messages.size).toBe(1);
    expect(mocks.push).toHaveBeenCalledTimes(1);
    const conflict = await connectorSend({ content: 'Different text', clientRequestId: 'receipt-1' });
    expect(conflict.status).toBe(409);
    // The id is scoped to the conversation: the same key elsewhere is a different message.
    expect((await connectorSend(body, 'other-room')).body.id).not.toBe(first.body.id);
  });

  it('connector sends require a clientRequestId and refuse unknown fields', async () => {
    expect((await connectorSend({ content: 'No key' })).status).toBe(400);
    expect((await connectorSend({ content: 'x', clientRequestId: 'k', attachments: [] })).status).toBe(400);
    expect(messages.size).toBe(0);
  });

  it('stores Vision provenance beside the message and exposes only the service', async () => {
    const reply = await connectorSend({ content: 'Sent from my note', clientRequestId: 'receipt-2', provenance });
    expect(reply.status).toBe(201);
    expect(reply.body.provenanceService).toBe('vision');
    expect(reply.body).not.toHaveProperty('provenanceJson');
    const merge = queries.find(q => q.query.includes('MessageProvenance'))!;
    expect(JSON.parse(merge.params.provenanceJson as string)).toEqual(provenance);
    expect(merge.params.provenanceService).toBe('vision');
  });

  it.each([
    [{ ...provenance, service: 'email' }], [{ ...provenance, extra: 1 }], [{ ...provenance, noteId: '' }],
    [{ ...provenance, noteRevision: -1 }], ['vision'], [{ ...provenance, ownerSubject: 'a\u0000b' }],
  ])('rejects malformed provenance %#', async (bad) => {
    const res = await request(app).post('/api/chat/conversations/room/messages').auth(human, { type: 'bearer' }).send({ content: 'x', provenance: bad });
    expect(res.status).toBe(400); expect(messages.size).toBe(0);
  });

  it('refuses provenance naming another owner', async () => {
    const res = await request(app).post('/api/chat/conversations/room/messages').auth(human, { type: 'bearer' })
      .send({ content: 'x', provenance: { ...provenance, ownerSubject: 'someone-else' } });
    expect(res.status).toBe(400); expect(messages.size).toBe(0);
  });

  it('parses @mentions on the REST path and notifies them like the socket path', async () => {
    const res = await request(app).post('/api/chat/conversations/room/messages').auth(human, { type: 'bearer' }).send({ content: 'Thoughts @Bob Stone and @carol?' });
    expect(res.status).toBe(201);
    expect(res.body.mentions).toEqual(['bob', 'carol']);
    expect(mocks.push).toHaveBeenCalledWith('room', 'alice', expect.objectContaining({ id: res.body.id }), ['bob', 'carol']);
  });

  it('does not parse mentions in direct chats', async () => {
    convType = 'direct';
    const res = await request(app).post('/api/chat/conversations/room/messages').auth(human, { type: 'bearer' }).send({ content: 'Hi @Bob' });
    expect(res.body.mentions).toEqual([]);
  });

  it('schedules a Vision reply delivery for each newly created reply', async () => {
    messages.set('target', { id: 'target', content: 'from vision', senderId: 'alice', conversationId: 'room' });
    const res = await request(app).post('/api/chat/conversations/room/messages').auth(human, { type: 'bearer' }).send({ content: 'Answer', replyToId: 'target', id: 'reply-1' });
    expect(res.status).toBe(201);
    expect(mocks.reply).toHaveBeenCalledWith('reply-1', 'target');
    await request(app).post('/api/chat/conversations/room/messages').auth(human, { type: 'bearer' }).send({ content: 'Answer', replyToId: 'target', id: 'reply-1' });
    expect(mocks.reply).toHaveBeenCalledTimes(1);
  });
});
