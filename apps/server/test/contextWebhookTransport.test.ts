import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

const transport = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn(), status: 204, bodies: [] as string[] }));
vi.mock('node:dns/promises', () => ({ lookup: transport.lookup }));
vi.mock('node:https', () => ({ default: { request: transport.request } }));
import { deliverContextWebhookOnce } from '../src/services/webhookDispatch.js';
import { contextWakeEnvelope } from '../src/services/contextWebhooks.js';

beforeEach(() => {
  vi.clearAllMocks(); transport.status = 204; transport.bodies = [];
  transport.lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  transport.request.mockImplementation((_url, options, callback) => {
    const req = {
      on: vi.fn().mockReturnThis(),
      write: (body: string) => transport.bodies.push(body),
      end: () => options.lookup('receiver.example', {}, (error: Error | null) => {
        expect(error).toBeNull();
        callback({ statusCode: transport.status, headers: { location: 'https://127.0.0.1/private' }, resume() {},
          on: (_event: string, done: () => void) => queueMicrotask(done) });
      }),
    };
    return req;
  });
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

it('pins the validated public address and sends the exact request-only HMAC envelope without a raw secret', async () => {
  const envelope = contextWakeEnvelope('synthetic-event', 'synthetic-request', 'synthetic-secret', 123000);
  expect(await deliverContextWebhookOnce('https://receiver.example/context', envelope.headers, envelope.body)).toBe(true);
  expect(transport.lookup).toHaveBeenCalledTimes(1);
  expect(transport.request).toHaveBeenCalledTimes(1);
  const [url, options] = transport.request.mock.calls[0];
  expect(url.toString()).toBe('https://receiver.example/context'); expect(options.method).toBe('POST');
  expect(options.headers).toEqual(envelope.headers);
  expect(options.headers['X-OpenChat-Secret']).toBeUndefined();
  expect(options.headers['X-OpenChat-Signature']).toBe('sha256=' + createHmac('sha256', 'synthetic-secret').update('123.' + envelope.body).digest('hex'));
  expect(transport.bodies).toEqual([envelope.body]);
  expect(JSON.parse(envelope.body)).toEqual({ id: 'synthetic-event', event: 'context.requested', requestId: 'synthetic-request' });
  transport.lookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
  const pinned = vi.fn(); options.lookup('receiver.example', {}, pinned);
  expect(pinned).toHaveBeenCalledWith(null, '93.184.216.34', 4);
  expect(transport.lookup).toHaveBeenCalledTimes(1);
  if (process.env.CONTEXT_TRANSPORT_EVIDENCE_PATH) await writeFile(process.env.CONTEXT_TRANSPORT_EVIDENCE_PATH,
    JSON.stringify({ destination: url.toString(), method: options.method, pinnedAddress: pinned.mock.calls[0][1], headers: options.headers, body: JSON.parse(transport.bodies[0]) }, null, 2) + '\n');
});

it.each([301, 302, 307, 308, 500])('does not follow or internally retry HTTP %s', async status => {
  transport.status = status;
  expect(await deliverContextWebhookOnce('https://receiver.example/context', {}, '{}')).toBe(false);
  expect(transport.request).toHaveBeenCalledTimes(1); expect(transport.lookup).toHaveBeenCalledTimes(1);
});

it('rejects mixed public/private DNS answers even with the legacy local exception', async () => {
  vi.stubEnv('WEBHOOK_ALLOW_LOCAL', 'true');
  transport.lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }, { address: '10.1.2.3', family: 4 }]);
  expect(await deliverContextWebhookOnce('https://receiver.example/context', {}, '{}')).toBe('blocked');
  expect(transport.request).not.toHaveBeenCalled();
});

it('bounds stalled DNS without opening an HTTPS connection', async () => {
  vi.useFakeTimers(); transport.lookup.mockImplementation(() => new Promise(() => {}));
  const result = deliverContextWebhookOnce('https://receiver.example/context', {}, '{}');
  await vi.advanceTimersByTimeAsync(2000);
  expect(await result).toBe(false); expect(transport.request).not.toHaveBeenCalled();
});
