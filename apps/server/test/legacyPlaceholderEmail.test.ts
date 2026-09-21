import express from 'express';
import jwt from 'jsonwebtoken';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  LEGACY_PLACEHOLDER_EMAIL_DOMAIN,
  isLegacyPlaceholderEmail,
  legacyEmailProjection,
  legacyPlaceholderEmail,
} from '../src/privacy/legacyEmailCompat.js';
import { CONVERSATIONS_QUERY } from '../src/queries/chatUnread.js';

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  close: vi.fn(async () => {}),
}));

vi.mock('../src/db.js', () => ({
  getDriver: () => ({
    session: () => ({ run: mocks.run, close: mocks.close }),
  }),
}));

import chatRouter from '../src/routes/chat.js';
import { ensureDirectConversation } from '../src/services/directConversation.js';

const REAL_EMAIL = 'alice.real@example.test';
const USER_ID = 'u_9fZq3';

/**
 * Verbatim copy of the participant loop shipped in iOS v0.1.24 (build 91,
 * `ChatScreen.tsx:105-110` @ 799a317). It is reproduced here — unguarded
 * `.split('@')` and all — because keeping frozen App Store binaries alive is
 * the entire point of the placeholder. If this loop throws, those installs
 * hard-crash on opening any group with a message (openchat-dwk).
 */
function shippedV0124MentionLoop(
  participants: { user: { id: string; name?: string; email?: string } }[],
): Map<string, string> {
  const nameMap = new Map<string, string>();
  for (const p of participants) {
    const displayName = p.user.name || p.user.email!.split('@')[0] || p.user.email!;
    nameMap.set(displayName.toLowerCase(), p.user.id);
    const localPart = p.user.email!.split('@')[0].toLowerCase();
    if (!nameMap.has(localPart)) nameMap.set(localPart, p.user.id);
  }
  return nameMap;
}

describe('legacy placeholder email', () => {
  it('is a non-empty, @-containing string whose local part is the opaque user id', () => {
    const placeholder = legacyPlaceholderEmail(USER_ID);

    expect(placeholder.length).toBeGreaterThan(0);
    expect(placeholder).toContain('@');
    expect(placeholder.split('@')[0]).toBe(USER_ID);
    expect(placeholder).toBe(`${USER_ID}@${LEGACY_PLACEHOLDER_EMAIL_DOMAIN}`);
  });

  it('never carries a real address, and its domain is RFC 2606 unroutable', () => {
    const placeholder = legacyPlaceholderEmail(USER_ID);

    expect(placeholder).not.toContain(REAL_EMAIL);
    expect(placeholder).not.toContain('example.test');
    expect(placeholder).not.toContain(REAL_EMAIL.split('@')[0]);
    expect(placeholder.endsWith('.invalid')).toBe(true);
    expect(isLegacyPlaceholderEmail(placeholder)).toBe(true);
    expect(isLegacyPlaceholderEmail(REAL_EMAIL)).toBe(false);
  });

  it('keeps the shipped v0.1.24 mention loop from throwing', () => {
    const participants = [{ user: { id: USER_ID, name: 'Alice' } }];

    // Without the field — today's production behaviour before this fix.
    expect(() => shippedV0124MentionLoop(participants)).toThrowError(TypeError);

    // With it — no throw, and the real name still wins as the display name.
    const withPlaceholder = participants.map(p => ({
      user: { ...p.user, email: legacyPlaceholderEmail(p.user.id) },
    }));
    const nameMap = shippedV0124MentionLoop(withPlaceholder);
    expect(nameMap.get('alice')).toBe(USER_ID);
    expect(nameMap.get(USER_ID.toLowerCase())).toBe(USER_ID);
  });

  it('emits a Cypher map-projection entry, not a real .email property read', () => {
    const fragment = legacyEmailProjection('participant');

    expect(fragment).toBe(`email: participant.id + '@${LEGACY_PLACEHOLDER_EMAIL_DOMAIN}'`);
    expect(fragment).not.toContain('.email');
  });
});

/**
 * Asserts a captured Cypher string projects a synthetic placeholder for `userVar`
 * and still never reads the real `.email` property (the OpenChat-51a invariant).
 */
function expectPlaceholderProjection(cypher: string | undefined, userVar: string): void {
  expect(cypher, `no Cypher captured for ${userVar}`).toBeDefined();
  expect(cypher).toContain(legacyEmailProjection(userVar));
  expect(cypher).not.toContain('.email');
}

describe('server projections carry the placeholder', () => {
  it('projects it for conversation-list participants', () => {
    expectPlaceholderProjection(CONVERSATIONS_QUERY, 'participant');
  });

  it('projects it for participants of a newly created direct conversation', async () => {
    mocks.run.mockReset();
    mocks.run
      .mockResolvedValueOnce({ records: [{ get: () => true }] })
      .mockResolvedValueOnce({
        records: [{
          get: (key: string) => key === 'created'
            ? true
            : { id: 'dm-1', participants: [] },
        }],
      });

    await ensureDirectConversation('a', 'b');

    expectPlaceholderProjection(String(mocks.run.mock.calls[1][0]), 'user');
  });
});

describe('chat routes', () => {
  let server: Server;
  let baseUrl: string;
  const token = jwt.sign({ userId: USER_ID, email: REAL_EMAIL }, 'dev-secret-change-me');
  const authorization = `Bearer ${token}`;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/chat', chatRouter);
    await new Promise<void>(resolve => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not bind');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close(error => (error ? reject(error) : resolve()));
    });
  });

  beforeEach(() => {
    mocks.run.mockReset();
    mocks.run.mockResolvedValue({ records: [] });
  });

  function capture(marker: string): string | undefined {
    return mocks.run.mock.calls
      .map(([query]) => String(query))
      .find(query => query.includes(marker));
  }

  it('projects the placeholder for conversation-detail participants', async () => {
    await fetch(`${baseUrl}/api/chat/conversations/sailing`, {
      headers: { Authorization: authorization },
    });

    expectPlaceholderProjection(capture('AS participants'), 'participant');
  });

  it('projects the placeholder for message senders', async () => {
    mocks.run.mockResolvedValueOnce({ records: [{ get: () => ({}) }] });

    await fetch(`${baseUrl}/api/chat/conversations/sailing/messages`, {
      headers: { Authorization: authorization },
    });

    const messageQuery = capture('AS message');
    expectPlaceholderProjection(messageQuery, 'sender');
    // Reply-quote senders are hydrated inline and reach the same clients.
    expect(messageQuery).toContain(legacyEmailProjection('replySender'));
  });
});
