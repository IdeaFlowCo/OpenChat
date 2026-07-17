import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';

// Mock the Neo4j driver so dispatch can be exercised without a live database.
// `records` is swapped per-test to simulate matching / no-matching subscriptions.
let mockRecords: Array<{ get: (k: string) => unknown }> = [];
const sessionRun = vi.fn(async () => ({ records: mockRecords }));
const sessionClose = vi.fn(async () => {});
vi.mock('../src/db.js', () => ({
  getDriver: () => ({ session: () => ({ run: sessionRun, close: sessionClose }) }),
}));

import {
  buildMessagePayload,
  buildWebhookHeaders,
  selectWebhooksForEvent,
  dispatchMessageEvent,
  MESSAGE_CREATED_EVENT,
  type WebhookSubscription,
} from '../src/services/webhookDispatch.js';

function webhookRecord(w: WebhookSubscription) {
  return { get: (k: string) => (k === 'webhook' ? w : undefined) };
}

const SAMPLE_MESSAGE = {
  id: 'm1',
  conversationId: 'c1',
  senderId: 'u1',
  content: 'hello world',
  messageType: 'text',
  attachments: null,
  replyToId: null,
  createdAt: '2026-07-16T00:00:00.000Z',
  sender: { id: 'u1', name: 'Alice', email: 'a@x.com' },
};

describe('buildMessagePayload', () => {
  it('normalizes a persisted message into the outbound shape', () => {
    const p = buildMessagePayload(MESSAGE_CREATED_EVENT, SAMPLE_MESSAGE);
    expect(p).toEqual({
      event: 'message.created',
      message: {
        id: 'm1',
        conversationId: 'c1',
        senderId: 'u1',
        senderName: 'Alice',
        content: 'hello world',
        messageType: 'text',
        attachments: null,
        replyToId: null,
        createdAt: '2026-07-16T00:00:00.000Z',
      },
    });
  });

  it('falls back to sender.id and defaults when fields are missing', () => {
    const p = buildMessagePayload(MESSAGE_CREATED_EVENT, {
      id: 'm2',
      conversationId: 'c2',
      sender: { id: 'bot' },
    });
    expect(p.message.senderId).toBe('bot');
    expect(p.message.senderName).toBeNull();
    expect(p.message.messageType).toBe('text');
    expect(p.message.content).toBe('');
  });
});

describe('buildWebhookHeaders', () => {
  it('emits the raw secret header and a correct HMAC-SHA256 signature', () => {
    const body = JSON.stringify({ hello: 'world' });
    const secret = 'whsec_test';
    const headers = buildWebhookHeaders(body, secret);
    const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');

    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['X-OpenChat-Secret']).toBe(secret);
    expect(headers['X-OpenChat-Signature']).toBe(`sha256=${expected}`);
  });

  it('produces a different signature for a different secret (tamper-evident)', () => {
    const body = 'payload';
    expect(buildWebhookHeaders(body, 's1')['X-OpenChat-Signature']).not.toBe(
      buildWebhookHeaders(body, 's2')['X-OpenChat-Signature']
    );
  });
});

describe('selectWebhooksForEvent', () => {
  const base: WebhookSubscription = {
    id: 'w1',
    url: 'https://x.example/hook',
    secret: 's',
    events: ['message.created'],
    conversationId: null,
  };

  it('selects an unfiltered webhook subscribed to the event', () => {
    expect(selectWebhooksForEvent([base], MESSAGE_CREATED_EVENT, 'c1')).toHaveLength(1);
  });

  it('selects a webhook that targets this conversation', () => {
    const w = { ...base, conversationId: 'c1' };
    expect(selectWebhooksForEvent([w], MESSAGE_CREATED_EVENT, 'c1')).toHaveLength(1);
  });

  it('drops a webhook targeting a different conversation', () => {
    const w = { ...base, conversationId: 'other' };
    expect(selectWebhooksForEvent([w], MESSAGE_CREATED_EVENT, 'c1')).toHaveLength(0);
  });

  it('drops a webhook not subscribed to the event', () => {
    const w = { ...base, events: ['something.else'] };
    expect(selectWebhooksForEvent([w], MESSAGE_CREATED_EVENT, 'c1')).toHaveLength(0);
  });
});

describe('dispatchMessageEvent', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    mockRecords = [];
    sessionRun.mockClear();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs a signed payload when a matching subscription exists', async () => {
    mockRecords = [
      webhookRecord({
        id: 'w1',
        url: 'https://x.example/hook',
        secret: 'whsec_abc',
        events: [MESSAGE_CREATED_EVENT],
        conversationId: null,
      }),
    ];

    dispatchMessageEvent(SAMPLE_MESSAGE, ['u1']);
    // dispatch is fire-and-forget; let the async IIFE settle.
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://x.example/hook');
    expect(opts.method).toBe('POST');

    // Secret + HMAC verification of the exact delivered body.
    const expectedSig = crypto.createHmac('sha256', 'whsec_abc').update(opts.body).digest('hex');
    expect(opts.headers['X-OpenChat-Secret']).toBe('whsec_abc');
    expect(opts.headers['X-OpenChat-Signature']).toBe(`sha256=${expectedSig}`);

    const parsed = JSON.parse(opts.body);
    expect(parsed.event).toBe('message.created');
    expect(parsed.message.id).toBe('m1');
  });

  it('does NOT dispatch when there is no subscription', async () => {
    mockRecords = [];
    dispatchMessageEvent(SAMPLE_MESSAGE, ['u1']);
    // Give the async IIFE a chance to run, then assert nothing was sent.
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('retries exactly once when the first delivery fails', async () => {
    mockRecords = [
      webhookRecord({
        id: 'w1',
        url: 'https://x.example/hook',
        secret: 's',
        events: [MESSAGE_CREATED_EVENT],
        conversationId: 'c1',
      }),
    ];
    fetchMock.mockResolvedValueOnce({ ok: false }).mockResolvedValueOnce({ ok: true });

    dispatchMessageEvent(SAMPLE_MESSAGE, ['u1']);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });
});
