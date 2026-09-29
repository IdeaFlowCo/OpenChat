/**
 * A voice note is persisted with empty content; its transcript is its only
 * text. These tests pin that agents (Assistant, webhooks, Secretary) are handed
 * the voice note AFTER transcription, with the transcript, instead of being
 * triggered on empty content before the transcript exists.
 */
import express from 'express';
import jwt from 'jsonwebtoken';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  close: vi.fn(async () => {}),
  transcribe: vi.fn(),
  assistant: vi.fn(),
  secretary: vi.fn(),
  webhook: vi.fn(),
}));

vi.mock('../src/db.js', () => ({
  getDriver: () => ({ session: () => ({ run: mocks.run, close: mocks.close }) }),
  getDriverForRequest: () => ({ session: () => ({ run: mocks.run, close: mocks.close }) }),
}));
vi.mock('../src/services/transcribeVoice.js', () => ({ maybeTranscribeMessage: mocks.transcribe }));
vi.mock('../src/services/assistantTrigger.js', () => ({ maybeTriggerAssistant: mocks.assistant }));
vi.mock('../src/services/secretary.js', () => ({ maybeTriggerSecretary: mocks.secretary }));
vi.mock('../src/services/webhookDispatch.js', () => ({ dispatchMessageEvent: mocks.webhook }));
vi.mock('../src/websocket/chatHandler.js', () => ({
  joinUserSocketsToConversation: vi.fn(),
  leaveUserSocketsFromConversation: vi.fn(),
  isUserOnline: vi.fn(() => false),
  broadcastMessageToParticipants: vi.fn(),
  fanoutPushForMessage: vi.fn(async () => {}),
}));

import chatRoutes from '../src/routes/chat.js';

const AUDIO = [{ type: 'audio', url: 'https://files.test/voice.m4a', mimeType: 'audio/x-m4a', durationMs: 4000 }];

function persistedMessage(content: string, attachments: unknown) {
  const message = {
    id: 'm1',
    content,
    senderId: 'actor',
    conversationId: 'conv-1',
    messageType: 'text',
    attachments: attachments ? JSON.stringify(attachments) : null,
  };
  return {
    records: [{
      get: (key: string) =>
        key === 'message' ? message : key === 'participantIds' ? ['actor', 'assistant'] : true,
    }],
  };
}

describe('voice message delivery to agents', () => {
  let server: Server;
  let baseUrl: string;
  let authorization: string;

  const send = (body: Record<string, unknown>) =>
    fetch(`${baseUrl}/api/chat/conversations/conv-1/messages`, {
      method: 'POST',
      headers: { Authorization: authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'm1', ...body }),
    });

  beforeAll(async () => {
    process.env.JWT_SECRET = 'voice-agent-delivery-test-secret';
    const app = express();
    app.use(express.json());
    app.use('/api/chat', chatRoutes);
    await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    authorization = `Bearer ${jwt.sign(
      { userId: 'actor', email: 'actor@example.test' },
      process.env.JWT_SECRET,
    )}`;
  });

  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.close.mockImplementation(async () => {});
  });

  afterAll(async () => {
    delete process.env.JWT_SECRET;
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });

  function mockSend(content: string, attachments: unknown) {
    mocks.run.mockImplementation(async (cypher: string) => {
      if (String(cypher).includes('blockedRelationship')) {
        return { records: [{ get: (key: string) => (key === 'blockedRelationship' ? false : {}) }] };
      }
      if (String(cypher).includes('MERGE (m:Message')) return persistedMessage(content, attachments);
      return { records: [] };
    });
  }

  it('holds a voice note back from agents until its transcript exists', async () => {
    mockSend('', AUDIO);
    let finishTranscription: (text: string | null) => void = () => {};
    mocks.transcribe.mockReturnValue(new Promise((resolve) => { finishTranscription = resolve; }));

    const response = await send({ content: '', attachments: AUDIO });
    expect(response.status).toBe(201);

    // The send has returned, but the transcript does not exist yet.
    expect(mocks.assistant).not.toHaveBeenCalled();
    expect(mocks.webhook).not.toHaveBeenCalled();
    expect(mocks.secretary).not.toHaveBeenCalled();

    finishTranscription('what is on my calendar');
    await vi.waitFor(() => expect(mocks.assistant).toHaveBeenCalledOnce());

    expect(mocks.assistant).toHaveBeenCalledWith(
      expect.objectContaining({ senderId: 'actor', conversationId: 'conv-1' })
    );
    expect(mocks.webhook).toHaveBeenCalledOnce();
    expect(mocks.webhook.mock.calls[0][0]).toMatchObject({
      id: 'm1',
      transcript: 'what is on my calendar',
    });
    expect(mocks.secretary).toHaveBeenCalledWith(
      expect.objectContaining({ sourceMessageId: 'm1', content: 'what is on my calendar' })
    );
  });

  it('still tells agents about a voice note that could not be transcribed', async () => {
    mockSend('', AUDIO);
    mocks.transcribe.mockRejectedValue(new Error('transcriber down'));

    expect((await send({ content: '', attachments: AUDIO })).status).toBe(201);
    await vi.waitFor(() => expect(mocks.assistant).toHaveBeenCalledOnce());

    expect(mocks.webhook.mock.calls[0][0]).toMatchObject({ id: 'm1', transcript: null });
    // Secretary matches on text; with no transcript there is nothing to match.
    expect(mocks.secretary).not.toHaveBeenCalled();
  });

  it('triggers agents immediately for a typed message', async () => {
    mockSend('hello', null);

    expect((await send({ content: 'hello' })).status).toBe(201);

    expect(mocks.assistant).toHaveBeenCalledOnce();
    expect(mocks.webhook).toHaveBeenCalledOnce();
    expect(mocks.secretary).toHaveBeenCalledWith(expect.objectContaining({ content: 'hello' }));
    expect(mocks.transcribe).not.toHaveBeenCalled();
  });
});
