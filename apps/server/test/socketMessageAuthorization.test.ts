import { describe, expect, it, vi } from 'vitest';
import { authorizeSocketMessageSend } from '../src/websocket/chatHandler.js';

function sessionWith(value?: boolean) {
  return {
    run: vi.fn(async () => ({
      records: value === undefined
        ? []
        : [{ get: (key: string) => key === 'blockedRelationship' ? value : undefined }],
    })),
  };
}

describe('socket message authorization', () => {
  it('checks block edges in both directions before the primary send path', async () => {
    const session = sessionWith(true);

    await expect(authorizeSocketMessageSend(session, 'sender', 'conversation'))
      .resolves.toBe('blocked');

    const cypher = String(session.run.mock.calls[0][0]);
    expect(cypher).toContain('(other)-[:BLOCKED]->(u)');
    expect(cypher).toContain('(u)-[:BLOCKED]->(other)');
  });

  it('distinguishes allowed sends from non-participants', async () => {
    await expect(authorizeSocketMessageSend(sessionWith(false), 'sender', 'conversation'))
      .resolves.toBe('allowed');
    await expect(authorizeSocketMessageSend(sessionWith(), 'sender', 'conversation'))
      .resolves.toBe('not_participant');
  });
});
