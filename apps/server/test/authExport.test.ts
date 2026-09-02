import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import jwt from 'jsonwebtoken';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

interface AgentKey {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  agentName: string | null;
  agentVersion: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}

const mocks = vi.hoisted(() => {
  const state: { agentKeys: AgentKey[] } = { agentKeys: [] };

  return {
    state,
    sessionRun: vi.fn(async (query: string, params: Record<string, unknown>) => {
      if (query.includes('CREATE (u)-[:OWNS_KEY]->(k)')) {
        state.agentKeys.push({
          id: params.id as string,
          name: params.name as string,
          keyPrefix: params.keyPrefix as string,
          scopes: params.scopes as string[],
          agentName: params.agentName as string | null,
          agentVersion: params.agentVersion as string | null,
          createdAt: params.createdAt as string,
          lastUsedAt: null,
          expiresAt: params.expiresAt as string | null,
          revokedAt: null,
        });
        return { records: [] };
      }

      if (query.includes('AS agentKeys')) {
        const agentKeys = query.includes('OPTIONAL MATCH (u)-[:OWNS_KEY]->(ak)')
          ? state.agentKeys
          : [];
        const values: Record<string, unknown> = {
          user: {
            id: params.userId,
            email: 'owner@example.com',
            name: 'Owner',
          },
          conversations: [],
          messages: [],
          thoughts: [],
          blockedUsers: [],
          agentKeys,
          intentDrafts: [{
            id: 'draft-1', ownerUserId: params.userId, goal: 'Find a ticket', seeks: ['ticket'], brings: [],
            details: 'owner-private', source: 'private-message', provenanceJson: '{"messageId":"source-1"}', state: 'pending',
          }],
          stories: [{ id: 'story-1', ownerUserId: params.userId, text: 'Looking for a ticket', status: 'active' }],
          intents: [{ id: 'intent-1', ownerUserId: params.userId, kind: 'ask', terms: 'ticket', details: 'owner-private' }],
          socialPreferences: { experienceMode: 'simple', networkPaused: true, updatedAt: '2026-09-02T00:00:00Z' },
          agentMatches: [{
            id: 'match-1', status: 'pending', ownIntent: { id: 'intent-1', kind: 'ask', terms: 'ticket' },
            otherKind: 'offer', otherTerms: 'one ticket', matchType: 'complementary', score: 0.9,
          }],
        };
        return {
          records: [{ get: (key: string) => values[key] }],
        };
      }

      throw new Error(`Unexpected query in auth export test: ${query}`);
    }),
    sessionClose: vi.fn(async () => {}),
  };
});

vi.mock('../src/db.js', () => ({
  getDriver: () => ({
    session: () => ({
      run: mocks.sessionRun,
      close: mocks.sessionClose,
    }),
  }),
}));

import authRoutes from '../src/routes/auth.js';
import agentKeyRoutes from '../src/routes/agentKeys.js';

describe('GET /api/auth/export', () => {
  let server: Server | undefined;

  beforeEach(() => {
    mocks.state.agentKeys = [];
    mocks.sessionRun.mockClear();
    mocks.sessionClose.mockClear();
    process.env.JWT_SECRET = 'auth-export-test-secret';
    process.env.OC_KEY_ENCRYPTION_SECRET = 'ab'.repeat(32);
  });

  afterEach(async () => {
    delete process.env.JWT_SECRET;
    delete process.env.OC_KEY_ENCRYPTION_SECRET;
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server!.close((error) => (error ? reject(error) : resolve()));
      });
      server = undefined;
    }
  });

  it('includes an agent key created through the agent-key route', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/agent-keys', agentKeyRoutes);
    app.use('/api/auth', authRoutes);

    server = await new Promise<Server>((resolve) => {
      const listeningServer = app.listen(0, '127.0.0.1', () => resolve(listeningServer));
    });
    const { port } = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${port}`;
    const token = jwt.sign(
      { userId: 'owner-1', email: 'owner@example.com' },
      process.env.JWT_SECRET!
    );
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };

    const createResponse = await fetch(`${baseUrl}/api/agent-keys`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: 'Audit helper',
        scopes: ['read'],
        agentName: 'audit-agent',
      }),
    });
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json() as AgentKey & { key: string };

    const exportResponse = await fetch(`${baseUrl}/api/auth/export?range=all_time`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(exportResponse.status).toBe(200);
    const exported = await exportResponse.json() as Record<string, unknown> & { agentKeys: AgentKey[] };

    expect(exported.agentKeys).toEqual([
      expect.objectContaining({
        id: created.id,
        name: 'Audit helper',
        keyPrefix: created.keyPrefix,
        scopes: ['read'],
        agentName: 'audit-agent',
      }),
    ]);
    expect(exported).toMatchObject({
      schema: 'openchat.account_export.v1',
      intentDrafts: [{
        id: 'draft-1', ownerUserId: 'owner-1', details: 'owner-private',
        source: 'private-message', provenance: { messageId: 'source-1' },
      }],
      stories: [{ id: 'story-1', ownerUserId: 'owner-1' }],
      intents: [{ id: 'intent-1', ownerUserId: 'owner-1', details: 'owner-private' }],
      socialPreferences: { experienceMode: 'simple', networkPaused: true },
      agentMatches: [{
        id: 'match-1', status: 'pending', otherKind: 'offer', otherTerms: 'one ticket',
        ownIntent: { id: 'intent-1', kind: 'ask', terms: 'ticket' },
      }],
    });
    expect(JSON.stringify((exported.agentMatches as unknown[]))).not.toMatch(/otherOwner|ownerUserId|private|details|source|provenance|response/i);
  });
});
