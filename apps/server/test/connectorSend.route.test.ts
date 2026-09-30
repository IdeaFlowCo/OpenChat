import { createHash } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectorDelegationService } from '../src/services/connectorDelegation.js';
import { connectorDelegationGuard } from '../src/routes/connectorDelegation.js';

const mocks = vi.hoisted(() => ({ run: vi.fn(), effect: vi.fn() }));
vi.mock('../src/db.js', () => ({ getDriver: () => ({ session: () => ({ run: mocks.run, close: async () => {} }) }) }));
vi.mock('../src/websocket/chatHandler.js', () => ({ broadcastMessageToParticipants: mocks.effect,
  fanoutPushForMessage: async () => mocks.effect(), joinUserSocketsToConversation: vi.fn(),
  leaveUserSocketsFromConversation: vi.fn(), isUserOnline: vi.fn() }));
vi.mock('../src/services/linkPreview.js', () => ({ processLinkPreviews: mocks.effect, loadPreviewsForMessages: vi.fn() }));
vi.mock('../src/services/extractThoughtsFromMessage.js', () => ({ createThoughtsFromMessageTags: async () => mocks.effect() }));
vi.mock('../src/services/assistantTrigger.js', () => ({ maybeTriggerAssistant: mocks.effect }));
vi.mock('../src/services/secretary.js', () => ({ maybeTriggerSecretary: mocks.effect }));
vi.mock('../src/services/webhookDispatch.js', () => ({ dispatchMessageEvent: mocks.effect }));
vi.mock('../src/services/embeddings.js', () => ({ embedAndStoreMessage: async () => mocks.effect(),
  semanticSearchMessages: vi.fn(), embeddingsEnabled: vi.fn() }));
import chatRoutes from '../src/routes/chat.js';

const callback = 'https://fixture.example.test/callback';
const verifier = 'A'.repeat(43);
const record = (values: Record<string, unknown>) => ({ get: (key: string) => values[key] });

describe('real delegated send route', () => {
  const messages = new Map<string, Record<string, unknown>>();
  const conversations = new Map<string, Record<string, unknown>>();
  const service = new ConnectorDelegationService({ enabled: true,
    clients: [{ id: 'fixture', secret: 'secret', callbacks: [callback] }] });
  const app = express();
  app.use(express.json());
  app.set('io', {});
  app.use('/api', connectorDelegationGuard(service));
  app.use('/api/chat', chatRoutes);
  const issue = (connectorGrantId = 'grant') => {
    const tx = service.start({ clientId: 'fixture', callback, connectorGrantId, connectorUserId: 'notes-alice',
      scopes: ['openchat.read', 'openchat.send'], state: 'state',
      codeChallenge: createHash('sha256').update(verifier).digest('base64url') })!;
    service.review(tx, 'alice');
    const code = service.consent(tx, 'alice', ['openchat.read', 'openchat.send'])!.code;
    return service.exchange({ clientId: 'fixture', callback, code, state: 'state', verifier })!.token;
  };
  const send = (token: string, clientRequestId: string, content: string, conversation = 'shared', extra = {}) =>
    request(app).post(`/api/chat/conversations/${conversation}/messages`)
      .set('Authorization', `Bearer ${token}`).send({ clientRequestId, content, ...extra });

  beforeEach(() => {
    messages.clear(); conversations.clear(); mocks.effect.mockClear(); mocks.run.mockReset();
    mocks.run.mockImplementation(async (_query, params) => {
      if (params.userId) return { records: [record({ blockedRelationship: false })] };
      if (params.content === undefined) {
        const message = messages.get(params.id);
        return { records: message ? [record({ message })] : [] };
      }
      const message = { id: params.id, content: params.content, senderId: params.senderId,
        conversationId: params.conversationId, createdAt: params.now };
      messages.set(params.id, message);
      conversations.set(params.conversationId, { lastMessagePreview: params.preview, lastMessageAt: params.now });
      return { records: [record({ message, participantIds: ['alice'], wasCreated: true })] };
    });
  });

  it('retries across reauthorization without writes, preview changes, or delivery effects', async () => {
    const token = issue();
    const a = await send(token, 'A', ' exact A ');
    expect(a.status).toBe(201);
    expect((await send(token, 'B', 'B')).status).toBe(201);
    const preview = { ...conversations.get('shared') };
    const effects = mocks.effect.mock.calls.length;
    mocks.run.mockClear();
    const retry = await send(issue(), 'A', ' exact A ');
    expect(retry.status).toBe(200);
    expect(retry.body).toEqual(a.body);
    expect(messages.size).toBe(2);
    expect(conversations.get('shared')).toEqual(preview);
    expect(mocks.effect).toHaveBeenCalledTimes(effects);
    expect(mocks.run).toHaveBeenCalledTimes(2);
    expect(mocks.run.mock.calls.every(([, params]) => params.content === undefined)).toBe(true);
  });

  it('rejects changed payload or conversation before mutation and scopes IDs by grant', async () => {
    const token = issue();
    const first = await send(token, 'A', 'A');
    const effects = mocks.effect.mock.calls.length;
    mocks.run.mockClear();
    expect((await send(issue(), 'A', 'changed')).status).toBe(409);
    expect((await send(token, 'A', 'A', 'other')).status).toBe(409);
    expect(messages.size).toBe(1);
    expect(conversations.has('other')).toBe(false);
    expect(mocks.run.mock.calls.every(([, params]) => params.content === undefined)).toBe(true);
    expect(mocks.effect).toHaveBeenCalledTimes(effects);
    const otherGrant = await send(issue('other-grant'), 'A', 'A');
    expect(otherGrant.status).toBe(201);
    expect(otherGrant.body.id).not.toBe(first.body.id);
    expect((await send(token, 'A', 'A', 'shared', { id: 'caller-chosen' })).status).toBe(400);
  });
});
