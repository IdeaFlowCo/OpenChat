import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const db = vi.hoisted(() => ({ run: vi.fn(), close: vi.fn() }));
vi.mock('../src/db.js', () => ({ getDriver: () => ({ session: () => db }) }));
import { resolveUnlinkedRecipient, unlinkedProfileId } from '../src/services/unlinkedMessaging.js';
import router from '../src/routes/unlinkedMessaging.js';
const profile = 'https://www.unlinked.ai/people/public-person';
const fetcher = vi.fn();
beforeEach(() => { vi.resetAllMocks(); vi.stubGlobal('fetch', fetcher); vi.stubEnv('UNLINKED_MESSAGING_SECRET', 's'.repeat(40));
  db.run.mockResolvedValue({ records: [{ get: (key: string) => ({ id: 'recipient', name: 'Member' })[key] }] });
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
const answer = (value: unknown) => fetcher.mockResolvedValue(new Response(JSON.stringify(value)));
describe('Unlinked inbox identity', () => {
  it('uses only the trusted issuer and opaque subject, with idempotent shared inbox creation', async () => {
    answer({ status: 'member', name: 'Member', identity: { issuer: 'https://id.ideaflow.app/api/auth', subject: 'opaque' } });
    expect(await resolveUnlinkedRecipient('public-person')).toEqual({ status: 'ready', recipient: { id: 'recipient', name: 'Member' } });
    expect(fetcher.mock.calls[0][0]).toBe('https://www.unlinked.ai/api/messaging/v1/recipient');
    expect(fetcher.mock.calls[0][1]).toMatchObject({ redirect: 'error', body: JSON.stringify({ profileId: 'public-person' }) });
    expect(db.run.mock.calls[0][0]).toContain('MERGE (u:User {ideaflowIdentityKey:$key})');
    expect(db.run.mock.calls[0][1].key).toBe('https://id.ideaflow.app/api/auth\u001fopaque');
    expect(db.run.mock.calls[0][0]).not.toMatch(/Conversation|Message|FRIEND|SET u.email/);
    expect(db.close).toHaveBeenCalledOnce();
  });
  it.each(['unclaimed', 'unavailable'])('does not provision an inbox for %s', async status => {
    answer({ status, name: 'Imported' }); await resolveUnlinkedRecipient('public-person'); expect(db.run).not.toHaveBeenCalled();
  });
  it.each([{ issuer: 'https://evil.invalid', subject: 'person' }, { issuer: 'https://id.ideaflow.app/api/auth', subject: '' }])('rejects untrusted identity %j', async identity => {
    answer({ status: 'member', name: 'Member', identity }); await expect(resolveUnlinkedRecipient('public-person')).rejects.toThrow(); expect(db.run).not.toHaveBeenCalled();
  });
  it('requires authentication and rejects private/hostile profile links without upstream requests', async () => {
    const app = express().use(express.json()).use('/api', router);
    expect((await request(app).post('/api/unlinked/recipient').send({ profile })).status).toBe(401);
    const token = jwt.sign({ userId: 'sender', email: 'sender@example.invalid' }, process.env.JWT_SECRET || 'dev-secret-change-me');
    expect((await request(app).post('/api/unlinked/recipient').auth(token, { type: 'bearer' }).send({ profile: 'https://www.unlinked.ai/profile' })).status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('returns a retryable service error instead of classifying an outage as an unclaimed person', async () => {
    fetcher.mockResolvedValue(new Response('', { status: 503 })); await expect(resolveUnlinkedRecipient('public-person')).rejects.toThrow(); expect(db.run).not.toHaveBeenCalled();
  });
  it.each(['https://evil.invalid/people/id', 'https://www.unlinked.ai/people/..', 'https://www.unlinked.ai/people/%2fsecret', 'https://www.unlinked.ai/people/%7f', 'https://www.unlinked.ai/people/a?email=a', 'https://www.unlinked.ai/c/token'])('rejects %s', value => expect(unlinkedProfileId(value)).toBeNull());
});
