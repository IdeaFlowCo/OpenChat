import { describe, expect, it, vi } from 'vitest';
import { directHumanOnly } from '../src/routes/conversationSources.js';

/** Mirrored history and a conversation's links are for a member's own session, never an agent's. */
describe('conversation sources: who may read', () => {
  const attempt = (req: Record<string, unknown>) => {
    const res = { setHeader: vi.fn(), status: vi.fn().mockReturnThis(), json: vi.fn() };
    const next = vi.fn();
    directHumanOnly({ headers: {}, ...req } as never, res as never, next);
    return { res, next };
  };

  it('lets a signed-in person through and marks the response uncacheable', () => {
    const { res, next } = attempt({ user: { userId: 'u1', email: '' } });
    expect(next).toHaveBeenCalledOnce();
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(res.status).not.toHaveBeenCalled();
  });

  it.each([
    ['an agent key', { user: { userId: 'u1' }, agentKeyId: 'k1', agentScopes: ['read', 'write'] }],
    ['a connector delegation', { user: { userId: 'u1' }, connectorDelegation: { clientId: 'c' }, agentScopes: ['openchat:read'] }],
    ['an embedded session', { user: { userId: 'u1', embedded: 'unlinked' } }],
  ])('answers 404, never 403, to %s', (_name, req) => {
    const { res, next } = attempt(req);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(404);
  });
});
