import { describe, expect, it, vi } from 'vitest';
import { bindIdeaflowIdentityToUser } from '../src/routes/auth.js';

const identity = {
  issuer: 'https://id.ideaflow.app/api/auth',
  subject: 'person-subject-123',
  email: 'person@example.test',
  emailVerified: true,
  name: 'Person Example',
  picture: 'https://images.example.test/person.jpg',
};

function result(users: Array<Record<string, unknown>>) {
  return {
    records: users.map(user => ({ get: () => user })),
  };
}

function sessionWithResults(...results: ReturnType<typeof result>[]) {
  const txRun = vi.fn(async () => results.shift() ?? result([]));
  return {
    run: vi.fn(() => { throw new Error('binding must use a managed transaction'); }),
    executeWrite: vi.fn(async (work: (tx: { run: typeof txRun }) => Promise<unknown>) => work({ run: txRun })),
    txRun,
    close: vi.fn(),
  };
}

describe('bindIdeaflowIdentityToUser', () => {
  it('binds the exact (issuer, sub) pair to the given user id — no matching email required', async () => {
    const current = { id: 'user-1', email: 'unrelated@example.test', name: 'Current User' };
    const bound = { ...current, avatarUrl: identity.picture };
    // 1) lock/read current user, 2) no other user owns this identity, 3) SET succeeds
    const session = sessionWithResults(result([current]), result([]), result([bound]));

    const outcome = await bindIdeaflowIdentityToUser(session as never, 'user-1', identity);

    expect(outcome).toEqual(bound);
    expect(session.executeWrite).toHaveBeenCalledTimes(1);
    expect(session.run).not.toHaveBeenCalled();
    expect(session.txRun).toHaveBeenCalledTimes(3);
    // Every query is addressed by the authenticated user's id, not by email.
    for (const call of session.txRun.mock.calls) {
      expect((call[1] as Record<string, unknown>).userId).toBe('user-1');
    }
    expect(String(session.txRun.mock.calls[0][0])).toContain('SET u._ideaflowBindingLock = true');
    expect(String(session.txRun.mock.calls[1][0])).toContain('u.ideaflowIdentityKey = $identityKey');
    expect(String(session.txRun.mock.calls[2][0])).toContain('SET u.ideaflowIssuer');
  });

  it('is idempotent when the current user is already bound to exactly this identity', async () => {
    const identityKey = `${identity.issuer}\u001f${identity.subject}`;
    const current = {
      id: 'user-1',
      email: 'unrelated@example.test',
      name: 'Current',
      ideaflowIssuer: identity.issuer,
      ideaflowSub: identity.subject,
      ideaflowIdentityKey: identityKey,
    };
    const session = sessionWithResults(result([current]), result([]));

    const outcome = await bindIdeaflowIdentityToUser(session as never, 'user-1', identity);

    expect(outcome).toEqual({ id: 'user-1', email: 'unrelated@example.test', name: 'Current', avatarUrl: undefined });
    // No SET was attempted — resolved from the lookup alone.
    expect(session.txRun).toHaveBeenCalledTimes(2);
  });

  it('refuses when the current user already carries a different Ideaflow ID mapping', async () => {
    const current = {
      id: 'user-1',
      email: 'unrelated@example.test',
      name: 'Current',
      ideaflowIdentityKey: 'https://id.ideaflow.app/api/auth\u001fa-different-subject',
    };
    const session = sessionWithResults(result([current]));

    await expect(bindIdeaflowIdentityToUser(session as never, 'user-1', identity))
      .rejects.toThrow('IDEAFLOW_ACCOUNT_ALREADY_LINKED');
    expect(session.txRun).toHaveBeenCalledTimes(1);
  });

  it('refuses when this exact identity is already mapped to a different OpenChat user', async () => {
    const current = { id: 'user-1', email: 'current@example.test', name: 'Current' };
    const session = sessionWithResults(result([current]), result([{ id: 'someone-else' }]));

    await expect(bindIdeaflowIdentityToUser(session as never, 'user-1', identity))
      .rejects.toThrow('IDEAFLOW_ALREADY_LINKED_ELSEWHERE');
    expect(session.txRun).toHaveBeenCalledTimes(2);
  });

  it('refuses when another user owns the issuer+sub pair but has no derived key', async () => {
    const current = { id: 'user-1', email: 'current@example.test', name: 'Current' };
    const session = sessionWithResults(result([current]), result([{
      id: 'someone-else',
      ideaflowIssuer: identity.issuer,
      ideaflowSub: identity.subject,
    }]));

    await expect(bindIdeaflowIdentityToUser(session as never, 'user-1', identity))
      .rejects.toThrow('IDEAFLOW_ALREADY_LINKED_ELSEWHERE');
    expect(String(session.txRun.mock.calls[1][0])).toContain('u.ideaflowSub = $subject');
  });

  it('completes a compatible partial mapping on the authenticated current user', async () => {
    const current = {
      id: 'user-1',
      email: 'legacy@example.test',
      name: 'Current',
      ideaflowIssuer: identity.issuer,
      ideaflowSub: identity.subject,
      ideaflowIdentityKey: null,
    };
    const bound = { ...current, ideaflowIdentityKey: `${identity.issuer}\u001f${identity.subject}` };
    const session = sessionWithResults(result([current]), result([]), result([bound]));

    await expect(bindIdeaflowIdentityToUser(session as never, 'user-1', identity))
      .resolves.toEqual(bound);
    expect(String(session.txRun.mock.calls[2][0])).toContain('SET u.ideaflowIssuer');
  });

  it('refuses a conflicting issuer or subject on the authenticated current user', async () => {
    const current = {
      id: 'user-1',
      email: 'legacy@example.test',
      name: 'Current',
      ideaflowIssuer: identity.issuer,
      ideaflowSub: 'different-subject',
      ideaflowIdentityKey: null,
    };
    const session = sessionWithResults(result([current]));

    await expect(bindIdeaflowIdentityToUser(session as never, 'user-1', identity))
      .rejects.toThrow('IDEAFLOW_ACCOUNT_ALREADY_LINKED');
  });

  it('translates a lost unique-constraint race into the same "linked elsewhere" conflict', async () => {
    const current = { id: 'user-1', email: 'unrelated@example.test', name: 'Current' };
    const constraintError = Object.assign(
      new Error('already exists with label `User` and property `ideaflowIdentityKey`'),
      { code: 'Neo.ClientError.Schema.ConstraintValidationFailed' },
    );
    const txRun = vi.fn()
      .mockResolvedValueOnce(result([current])) // current user locked and unmapped
      .mockResolvedValueOnce(result([])) // nobody else owns it (checked just before the race)
      .mockRejectedValueOnce(constraintError); // a concurrent bind wins the race
    const session = {
      run: vi.fn(() => { throw new Error('binding must use a managed transaction'); }),
      executeWrite: vi.fn(async (work: (tx: { run: typeof txRun }) => Promise<unknown>) => work({ run: txRun })),
      close: vi.fn(),
    };

    await expect(bindIdeaflowIdentityToUser(session as never, 'user-1', identity))
      .rejects.toThrow('IDEAFLOW_ALREADY_LINKED_ELSEWHERE');
  });

  it('never creates a duplicate User node — always matches an existing id, never CREATEs', async () => {
    const current = { id: 'user-1', email: 'unrelated@example.test', name: 'Current' };
    const bound = { ...current };
    const session = sessionWithResults(result([current]), result([]), result([bound]));

    await bindIdeaflowIdentityToUser(session as never, 'user-1', identity);

    for (const call of session.txRun.mock.calls) {
      expect(String(call[0])).not.toContain('CREATE');
      expect(String(call[0])).toContain('MATCH (u:User');
    }
  });

  it('serializes same-user binds by taking the write lock before reading the mapping', async () => {
    const current = { id: 'user-1', email: 'current@example.test', name: 'Current' };
    const bound = { ...current, avatarUrl: identity.picture };
    const session = sessionWithResults(result([current]), result([]), result([bound]));

    await bindIdeaflowIdentityToUser(session as never, 'user-1', identity);

    const firstQuery = String(session.txRun.mock.calls[0][0]);
    expect(firstQuery.indexOf('SET u._ideaflowBindingLock = true')).toBeLessThan(
      firstQuery.indexOf('RETURN u'),
    );
    expect(session.executeWrite).toHaveBeenCalledTimes(1);
  });
});
