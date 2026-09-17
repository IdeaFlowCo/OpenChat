import { describe, expect, it, vi } from 'vitest';
import { linkIdeaflowIdentity } from '../src/routes/auth.js';

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
  return {
    run: vi.fn(async () => results.shift() ?? result([])),
    close: vi.fn(),
  };
}

describe('linkIdeaflowIdentity', () => {
  it('resolves an existing durable issuer+subject mapping before considering email', async () => {
    const user = { id: 'existing', email: 'old-address@example.test', name: 'Existing' };
    const session = sessionWithResults(result([user]), result([user]));

    await expect(linkIdeaflowIdentity(session as never, identity)).resolves.toEqual(user);

    expect(session.run).toHaveBeenCalledTimes(2);
    expect(String(session.run.mock.calls[0][0])).toContain('ideaflowIssuer');
    expect(String(session.run.mock.calls[1][0])).toContain('ideaflowEmail');
  });

  it('links one legacy user by uniquely matched verified email', async () => {
    const user = { id: 'legacy', email: identity.email, name: 'Legacy' };
    const linked = { ...user, avatarUrl: identity.picture };
    const session = sessionWithResults(result([]), result([user]), result([linked]));

    await expect(linkIdeaflowIdentity(session as never, identity)).resolves.toEqual(linked);

    expect(session.run).toHaveBeenCalledTimes(3);
    expect(String(session.run.mock.calls[1][0])).toContain('toLower(u.email) = $email');
    expect(String(session.run.mock.calls[2][0])).toContain('u.ideaflowSub = $subject');
  });

  it('refuses ambiguous legacy-email matches instead of choosing an account', async () => {
    const session = sessionWithResults(result([]), result([
      { id: 'legacy-a', email: identity.email, name: 'A' },
      { id: 'legacy-b', email: identity.email, name: 'B' },
    ]));

    await expect(linkIdeaflowIdentity(session as never, identity))
      .rejects.toThrow('IDEAFLOW_EMAIL_COLLISION');
    expect(session.run).toHaveBeenCalledTimes(2);
  });

  it('refuses to replace another issuer+subject mapping on an email match', async () => {
    const session = sessionWithResults(result([]), result([{
      id: 'already-linked',
      email: identity.email,
      name: 'Already Linked',
      ideaflowIssuer: identity.issuer,
      ideaflowSub: 'different-subject',
    }]));

    await expect(linkIdeaflowIdentity(session as never, identity))
      .rejects.toThrow('IDEAFLOW_EMAIL_COLLISION');
    expect(session.run).toHaveBeenCalledTimes(2);
  });

  it('creates a new OpenChat user while retaining the external identity key', async () => {
    const created = {
      id: 'new-user',
      email: identity.email,
      name: identity.name,
      avatarUrl: identity.picture,
    };
    const session = sessionWithResults(result([]), result([]), result([created]));

    await expect(linkIdeaflowIdentity(session as never, identity)).resolves.toEqual(created);

    expect(String(session.run.mock.calls[2][0])).toContain("signupProvider: 'ideaflow-id'");
    expect(session.run.mock.calls[2][1]).toMatchObject({
      issuer: identity.issuer,
      subject: identity.subject,
      email: identity.email,
    });
  });

  it('never falls back to the IdeaFlow login email for a public display name', async () => {
    const emailOnlyIdentity = { ...identity, name: undefined };
    const created = {
      id: 'new-email-only-user',
      email: identity.email,
      name: 'OpenChat member',
    };
    const session = sessionWithResults(result([]), result([]), result([created]));

    await linkIdeaflowIdentity(session as never, emailOnlyIdentity);

    expect(session.run.mock.calls[2][1]).toMatchObject({
      email: identity.email,
      name: 'OpenChat member',
    });
    expect(session.run.mock.calls[2][1]).not.toMatchObject({ name: identity.email });
  });
});
