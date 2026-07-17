import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';

const mocks = vi.hoisted(() => {
  const state: {
    records: Array<{ get: (k: string) => unknown }>;
    requestBodies: string[];
    statusCodes: number[];
    lookupAddresses: string[];
  } = { records: [], requestBodies: [], statusCodes: [], lookupAddresses: [] };
  const requestMock = vi.fn((url, options, callback) => {
    const handlers: Record<string, (err?: Error) => void> = {};
    const req = {
      on: vi.fn((event: string, handler: (err?: Error) => void) => {
        handlers[event] = handler;
        return req;
      }),
      write: vi.fn((body: string) => {
        state.requestBodies.push(body);
      }),
      end: vi.fn(() => {
        options.lookup(String(url.hostname ?? ''), {}, (err: Error | null, address: string) => {
          if (err) {
            handlers.error?.(err);
            return;
          }
          state.lookupAddresses.push(address);
          const statusCode = state.statusCodes.shift() ?? 200;
          const res = {
            statusCode,
            resume: vi.fn(),
            on: vi.fn((event: string, handler: () => void) => {
              if (event === 'end') queueMicrotask(handler);
              return res;
            }),
          };
          callback(res);
        });
      }),
    };
    return req;
  });
  return {
    state,
    sessionRun: vi.fn(async () => ({ records: state.records })),
    sessionClose: vi.fn(async () => {}),
    lookupMock: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
    requestMock,
  };
});
vi.mock('../src/db.js', () => ({
  getDriver: () => ({
    session: () => ({ run: mocks.sessionRun, close: mocks.sessionClose }),
  }),
}));
vi.mock('node:dns/promises', () => ({
  lookup: mocks.lookupMock,
}));
vi.mock('node:http', () => ({
  default: { request: mocks.requestMock },
  request: mocks.requestMock,
}));
vi.mock('node:https', () => ({
  default: { request: mocks.requestMock },
  request: mocks.requestMock,
}));

import {
  buildMessagePayload,
  buildWebhookHeaders,
  selectWebhooksForEvent,
  dispatchMessageEvent,
  ensureWebhookIndex,
  isSafeWebhookUrl,
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
  beforeEach(() => {
    mocks.state.records = [];
    mocks.state.requestBodies = [];
    mocks.state.statusCodes = [];
    mocks.state.lookupAddresses = [];
    mocks.sessionRun.mockClear();
    mocks.sessionClose.mockClear();
    mocks.lookupMock.mockClear();
    mocks.lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    mocks.requestMock.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs a signed payload when a matching subscription exists', async () => {
    mocks.state.records = [
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
    await vi.waitFor(() => expect(mocks.requestMock).toHaveBeenCalledTimes(1));

    const [url, opts] = mocks.requestMock.mock.calls[0];
    expect(url.toString()).toBe('https://x.example/hook');
    expect(opts.method).toBe('POST');
    expect(mocks.state.lookupAddresses).toEqual(['93.184.216.34']);

    // Secret + HMAC verification of the exact delivered body.
    const body = mocks.state.requestBodies[0];
    const expectedSig = crypto.createHmac('sha256', 'whsec_abc').update(body).digest('hex');
    expect(opts.headers['X-OpenChat-Secret']).toBe('whsec_abc');
    expect(opts.headers['X-OpenChat-Signature']).toBe(`sha256=${expectedSig}`);

    const parsed = JSON.parse(body);
    expect(parsed.event).toBe('message.created');
    expect(parsed.message.id).toBe('m1');
  });

  it('POSTs a signed payload for a forwarded message', async () => {
    mocks.state.records = [
      webhookRecord({
        id: 'w1',
        url: 'https://x.example/hook',
        secret: 'whsec_forward',
        events: [MESSAGE_CREATED_EVENT],
        conversationId: 'c1',
      }),
    ];

    dispatchMessageEvent({ ...SAMPLE_MESSAGE, id: 'm-forward', forwardedFromMessageId: 'm-original' }, ['u1']);
    await vi.waitFor(() => expect(mocks.requestMock).toHaveBeenCalledTimes(1));

    const body = mocks.state.requestBodies[0];
    const parsed = JSON.parse(body);
    const expectedSig = crypto.createHmac('sha256', 'whsec_forward').update(body).digest('hex');
    const [, opts] = mocks.requestMock.mock.calls[0];
    expect(opts.headers['X-OpenChat-Signature']).toBe(`sha256=${expectedSig}`);
    expect(parsed.message.id).toBe('m-forward');
  });

  it('does NOT dispatch when there is no subscription', async () => {
    mocks.state.records = [];
    dispatchMessageEvent(SAMPLE_MESSAGE, ['u1']);
    // Give the async IIFE a chance to run, then assert nothing was sent.
    await new Promise((r) => setTimeout(r, 20));
    expect(mocks.requestMock).not.toHaveBeenCalled();
  });

  it('retries exactly once when the first delivery fails', async () => {
    mocks.state.records = [
      webhookRecord({
        id: 'w1',
        url: 'https://x.example/hook',
        secret: 's',
        events: [MESSAGE_CREATED_EVENT],
        conversationId: 'c1',
      }),
    ];
    mocks.state.statusCodes = [500, 200];

    dispatchMessageEvent(SAMPLE_MESSAGE, ['u1']);
    await vi.waitFor(() => expect(mocks.requestMock).toHaveBeenCalledTimes(2));
  });

  it('does NOT dispatch to a private resolved address', async () => {
    mocks.lookupMock.mockResolvedValue([{ address: '10.0.0.5', family: 4 }]);
    mocks.state.records = [
      webhookRecord({
        id: 'w1',
        url: 'https://internal.example/hook',
        secret: 's',
        events: [MESSAGE_CREATED_EVENT],
        conversationId: 'c1',
      }),
    ];

    dispatchMessageEvent(SAMPLE_MESSAGE, ['u1']);
    await vi.waitFor(() => expect(mocks.lookupMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(mocks.requestMock).not.toHaveBeenCalled();
  });
});

describe('isSafeWebhookUrl', () => {
  it('rejects non-http schemes', async () => {
    await expect(isSafeWebhookUrl('file:///etc/passwd')).resolves.toBe(false);
  });

  it('rejects loopback and link-local hosts', async () => {
    await expect(isSafeWebhookUrl('http://localhost:3000/hook')).resolves.toBe(false);
    await expect(isSafeWebhookUrl('http://127.0.0.1/hook')).resolves.toBe(false);
    await expect(isSafeWebhookUrl('http://169.254.169.254/latest')).resolves.toBe(false);
    await expect(isSafeWebhookUrl('http://[::1]/hook')).resolves.toBe(false);
    await expect(isSafeWebhookUrl('http://[fe80::1]/hook')).resolves.toBe(false);
  });

  it('rejects private DNS results', async () => {
    mocks.lookupMock.mockResolvedValue([{ address: '192.168.1.10', family: 4 }]);
    await expect(isSafeWebhookUrl('https://private.example/hook')).resolves.toBe(false);
  });

  it('rejects non-global DNS results', async () => {
    for (const address of ['0.0.0.0', '100.64.0.1', '192.88.99.1', '198.18.0.1', '203.0.113.7', '224.0.0.1']) {
      mocks.lookupMock.mockResolvedValue([{ address, family: 4 }]);
      await expect(isSafeWebhookUrl('https://non-global.example/hook')).resolves.toBe(false);
    }
  });

  it('rejects IPv6 unspecified, multicast, documentation, and mapped private targets', async () => {
    await expect(isSafeWebhookUrl('http://[::]/hook')).resolves.toBe(false);
    await expect(isSafeWebhookUrl('http://[ff02::1]/hook')).resolves.toBe(false);
    await expect(isSafeWebhookUrl('http://[2001:db8::1]/hook')).resolves.toBe(false);
    await expect(isSafeWebhookUrl('http://[::ffff:10.0.0.1]/hook')).resolves.toBe(false);
  });

  it('allows public DNS results', async () => {
    mocks.lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    await expect(isSafeWebhookUrl('https://public.example/hook')).resolves.toBe(true);
  });
});

describe('ensureWebhookIndex', () => {
  it('creates the owner lookup index idempotently', async () => {
    await ensureWebhookIndex();

    expect(mocks.sessionRun).toHaveBeenCalledWith(
      expect.stringContaining('CREATE INDEX webhook_owner_user_id IF NOT EXISTS')
    );
    expect(mocks.sessionClose).toHaveBeenCalled();
  });
});
