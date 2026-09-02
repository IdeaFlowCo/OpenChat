import crypto from 'node:crypto';
import express from 'express';
import jwt from 'jsonwebtoken';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  close: vi.fn(),
  createIntent: vi.fn(),
  listIntents: vi.fn(),
  withdrawIntent: vi.fn(),
  listMatches: vi.fn(),
  respondToMatch: vi.fn(),
}));

vi.mock('../src/db.js', () => ({
  getDriver: () => ({
    session: () => ({ run: mocks.run, close: mocks.close }),
  }),
}));

vi.mock('../src/services/agentNetwork.js', () => ({
  createIntent: mocks.createIntent,
  listIntents: mocks.listIntents,
  withdrawIntent: mocks.withdrawIntent,
  listMatches: mocks.listMatches,
  respondToMatch: mocks.respondToMatch,
}));

import agentNetworkRouter from '../src/routes/agentNetwork.js';

function bearer(userId = 'route-user'): string {
  return `Bearer ${jwt.sign({ userId, email: `${userId}@example.test` }, 'dev-secret-change-me')}`;
}

function encryptedAgentKey(fullKey: string, secretHex: string): { ciphertext: string; iv: string } {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(secretHex, 'hex'), iv);
  const body = Buffer.concat([cipher.update(fullKey, 'utf8'), cipher.final()]);
  return {
    ciphertext: Buffer.concat([body, cipher.getAuthTag()]).toString('hex'),
    iv: iv.toString('hex'),
  };
}

describe('agent-network routes', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api', agentNetworkRouter);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not bind');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.OC_KEY_ENCRYPTION_SECRET;
    mocks.run.mockResolvedValue({ records: [] });
    mocks.listIntents.mockResolvedValue([]);
    mocks.listMatches.mockResolvedValue([]);
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  it('requires authentication for intent CRUD', async () => {
    const response = await fetch(`${baseUrl}/api/intents`);
    expect(response.status).toBe(401);
  });

  it('rejects invalid kind, terms, details, and unsupported patches', async () => {
    const headers = { Authorization: bearer(), 'Content-Type': 'application/json' };
    for (const body of [
      { kind: 'need', terms: 'help', confirm: true },
      { kind: 'ask', terms: '', confirm: true },
      { kind: 'offer', terms: 'x'.repeat(501), confirm: true },
      { kind: 'ask', terms: 'help', details: 'x'.repeat(2001), confirm: true },
      { kind: 'ask', terms: 'help', confirm: false },
    ]) {
      const response = await fetch(`${baseUrl}/api/intents`, {
        method: 'POST', headers, body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
    }
    const patch = await fetch(`${baseUrl}/api/intents/intent`, {
      method: 'PATCH', headers, body: JSON.stringify({ status: 'active' }),
    });
    expect(patch.status).toBe(400);
  });

  it('accepts an oc_ agent key and scopes publishing to its owner', async () => {
    const key = `oc_${crypto.randomBytes(18).toString('base64url')}`;
    const secret = crypto.randomBytes(32).toString('hex');
    const encrypted = encryptedAgentKey(key, secret);
    process.env.OC_KEY_ENCRYPTION_SECRET = secret;
    mocks.run.mockResolvedValueOnce({
      records: [{
        get: (field: string) => ({
          keyCiphertext: encrypted.ciphertext,
          keyIv: encrypted.iv,
          keyId: 'key-id',
          ownerUserId: 'agent-owner',
          expiresAt: null,
        })[field],
      }],
    });
    mocks.createIntent.mockResolvedValue({ id: 'intent-id', kind: 'ask', terms: 'React help' });

    const response = await fetch(`${baseUrl}/api/intents`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'ask', terms: 'React help', confirm: true }),
    });
    expect(response.status).toBe(201);
    expect(mocks.createIntent).toHaveBeenCalledWith(
      'agent-owner',
      { kind: 'ask', terms: 'React help' },
      { confirmed: true, io: undefined },
    );
  });

  it('does not let a non-owner withdraw an intent', async () => {
    mocks.withdrawIntent.mockResolvedValue(null);
    const response = await fetch(`${baseUrl}/api/intents/not-mine`, {
      method: 'PATCH',
      headers: { Authorization: bearer(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'withdrawn' }),
    });
    expect(response.status).toBe(404);
  });

  it('accepts additive canonical matching fields without changing legacy requirements', async () => {
    mocks.createIntent.mockResolvedValue({ id: 'canonical', kind: 'ask', terms: 'Build a company' });
    const body = {
      kind: 'ask', terms: 'Build a company', confirm: true, goal: 'Start an accessibility company',
      seeks: ['technical cofounder'], brings: ['sales'], matchingMode: 'reciprocal',
      openToCollaborators: true, closeOnConnect: false,
      audience: { userIds: ['friend'], conversationIds: ['group'] },
    };
    const response = await fetch(`${baseUrl}/api/intents`, {
      method: 'POST', headers: { Authorization: bearer(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(201);
    expect(mocks.createIntent).toHaveBeenCalledWith('route-user', {
      kind: 'ask', terms: 'Build a company', goal: 'Start an accessibility company',
      seeks: ['technical cofounder'], brings: ['sales'], matchingMode: 'reciprocal',
      openToCollaborators: true, closeOnConnect: false, audienceRestricted: true,
      audienceUserIds: ['friend'], audienceConversationIds: ['group'],
    }, { confirmed: true, io: undefined });
  });

  it('validates and returns approve, decline, and already-resolved projections', async () => {
    const headers = { Authorization: bearer(), 'Content-Type': 'application/json' };
    const invalid = await fetch(`${baseUrl}/api/matches/m/respond`, {
      method: 'POST', headers, body: JSON.stringify({ decision: 'maybe' }),
    });
    expect(invalid.status).toBe(400);

    mocks.respondToMatch
      .mockResolvedValueOnce({ id: 'm', status: 'awaiting_other' })
      .mockResolvedValueOnce({ id: 'm', status: 'closed' })
      .mockResolvedValueOnce({ id: 'm', status: 'closed', alreadyResolved: true });
    const returned = [];
    for (const decision of ['approve', 'decline', 'approve']) {
      const response = await fetch(`${baseUrl}/api/matches/m/respond`, {
        method: 'POST', headers, body: JSON.stringify({ decision }),
      });
      expect(response.status).toBe(200);
      returned.push(await response.json());
    }
    expect(returned).toEqual([
      { match: { id: 'm', status: 'awaiting_other' } },
      { match: { id: 'm', status: 'closed' } },
      { match: { id: 'm', status: 'closed', alreadyResolved: true } },
    ]);
    expect(mocks.respondToMatch).toHaveBeenNthCalledWith(1, 'route-user', 'm', 'approve', undefined);
    expect(mocks.respondToMatch).toHaveBeenNthCalledWith(2, 'route-user', 'm', 'decline', undefined);
    expect(await (await fetch(`${baseUrl}/api/matches`, { headers })).json()).toEqual({ matches: [] });
  });
});
