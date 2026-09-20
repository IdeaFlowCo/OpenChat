import { describe, expect, it, vi } from 'vitest';
import { resolveIdeaflowSignIn } from '../src/routes/auth.js';
import { getIdeaflowCohortConfig, IdeaflowCohortConfig } from '../src/services/ideaflowCohort.js';

const identity = {
  issuer: 'https://id.ideaflow.app/api/auth',
  subject: 'person-subject-123',
  email: 'person@example.test',
  emailVerified: true,
  name: 'Person Example',
  picture: 'https://images.example.test/person.jpg',
};

const OPEN_COHORT: IdeaflowCohortConfig = {
  allowAllVerifiedEmails: true,
  allowlist: new Set(),
  allowNewUserCreation: false,
};

const OPEN_COHORT_WITH_CREATION: IdeaflowCohortConfig = {
  ...OPEN_COHORT,
  allowNewUserCreation: true,
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

describe('getIdeaflowCohortConfig', () => {
  it('fails closed when the allowlist is unset', () => {
    const cohort = getIdeaflowCohortConfig({});
    expect(cohort.allowAllVerifiedEmails).toBe(false);
    expect(cohort.allowlist.size).toBe(0);
    expect(cohort.allowNewUserCreation).toBe(false);
  });

  it('parses a comma-separated, case-insensitive allowlist', () => {
    const cohort = getIdeaflowCohortConfig({
      IDEAFLOW_ID_COHORT_ALLOWLIST: ' Person@Example.test, other@example.test ,',
    });
    expect(cohort.allowlist.has('person@example.test')).toBe(true);
    expect(cohort.allowlist.has('other@example.test')).toBe(true);
    expect(cohort.allowAllVerifiedEmails).toBe(false);
  });

  it('treats the literal "*" as an explicit full-rollout switch', () => {
    const cohort = getIdeaflowCohortConfig({ IDEAFLOW_ID_COHORT_ALLOWLIST: '*' });
    expect(cohort.allowAllVerifiedEmails).toBe(true);
  });

  it('only enables new-user creation when explicitly set to "true"', () => {
    expect(getIdeaflowCohortConfig({ IDEAFLOW_ID_ALLOW_NEW_USER_CREATION: 'true' }).allowNewUserCreation).toBe(true);
    expect(getIdeaflowCohortConfig({ IDEAFLOW_ID_ALLOW_NEW_USER_CREATION: 'yes' }).allowNewUserCreation).toBe(false);
    expect(getIdeaflowCohortConfig({}).allowNewUserCreation).toBe(false);
  });
});

describe('resolveIdeaflowSignIn', () => {
  it('refuses every sign-in, including an existing mapping, when the cohort is unset (fail closed)', async () => {
    const user = { id: 'existing', email: 'old-address@example.test', name: 'Existing' };
    const session = sessionWithResults(result([user]), result([user]));
    const closedCohort = getIdeaflowCohortConfig({});

    await expect(resolveIdeaflowSignIn(session as never, identity, closedCohort))
      .rejects.toThrow('IDEAFLOW_COHORT_DENIED');
    expect(session.run).not.toHaveBeenCalled();
  });

  it('resolves an existing durable issuer+subject mapping before considering email', async () => {
    const user = { id: 'existing', email: 'old-address@example.test', name: 'Existing' };
    const mapped = {
      ...user,
      ideaflowIssuer: identity.issuer,
      ideaflowSub: identity.subject,
      ideaflowIdentityKey: `${identity.issuer}\u001f${identity.subject}`,
    };
    const session = sessionWithResults(result([mapped]), result([user]));

    await expect(resolveIdeaflowSignIn(session as never, identity, OPEN_COHORT)).resolves.toEqual(user);

    expect(session.run).toHaveBeenCalledTimes(2);
    expect(String(session.run.mock.calls[0][0])).toContain('ideaflowIssuer');
    expect(String(session.run.mock.calls[1][0])).toContain('ideaflowEmail');
  });

  it('never auto-links a uniquely matched verified email — returns a link-required conflict instead', async () => {
    const session = sessionWithResults(result([]), result([{ id: 'legacy' }]));

    await expect(resolveIdeaflowSignIn(session as never, identity, OPEN_COHORT_WITH_CREATION))
      .rejects.toThrow('IDEAFLOW_LINK_REQUIRED');
    expect(session.run).toHaveBeenCalledTimes(2);
    expect(String(session.run.mock.calls[1][0])).toContain("toLower(coalesce(u.email, '')) = $emailLookup");
  });

  it('treats an ambiguous email match the same as a single match — link required, not a chosen account', async () => {
    const session = sessionWithResults(result([]), result([{ id: 'legacy-a' }, { id: 'legacy-b' }]));

    await expect(resolveIdeaflowSignIn(session as never, identity, OPEN_COHORT_WITH_CREATION))
      .rejects.toThrow('IDEAFLOW_LINK_REQUIRED');
  });

  it('refuses to create a brand-new user when the cohort has not enabled new-user creation', async () => {
    const session = sessionWithResults(result([]), result([]));

    await expect(resolveIdeaflowSignIn(session as never, identity, OPEN_COHORT))
      .rejects.toThrow('IDEAFLOW_NEW_USER_CREATION_DISABLED');
    expect(session.run).toHaveBeenCalledTimes(2);
  });

  it('creates a new OpenChat user only when the cohort explicitly enables new-user creation', async () => {
    const created = {
      id: 'new-user',
      email: identity.email,
      name: identity.name,
      avatarUrl: identity.picture,
    };
    const session = sessionWithResults(result([]), result([]), result([created]));

    await expect(resolveIdeaflowSignIn(session as never, identity, OPEN_COHORT_WITH_CREATION))
      .resolves.toEqual(created);

    expect(String(session.run.mock.calls[2][0])).toContain("signupProvider: 'ideaflow-id'");
    expect(session.run.mock.calls[2][1]).toMatchObject({
      issuer: identity.issuer,
      subject: identity.subject,
      email: identity.email,
    });
  });

  it('never falls back to the Ideaflow login email for a public display name', async () => {
    const emailOnlyIdentity = { ...identity, name: undefined };
    const created = {
      id: 'new-email-only-user',
      email: identity.email,
      name: 'OpenChat member',
    };
    const session = sessionWithResults(result([]), result([]), result([created]));

    await resolveIdeaflowSignIn(session as never, emailOnlyIdentity, OPEN_COHORT_WITH_CREATION);

    expect(session.run.mock.calls[2][1]).toMatchObject({
      email: identity.email,
      name: 'OpenChat member',
    });
    expect(session.run.mock.calls[2][1]).not.toMatchObject({ name: identity.email });
  });

  it('rejects with an integrity error if the unique-mapping invariant is somehow violated', async () => {
    const session = sessionWithResults(result([{ id: 'a' }, { id: 'b' }]));

    await expect(resolveIdeaflowSignIn(session as never, identity, OPEN_COHORT))
      .rejects.toThrow('IDEAFLOW_IDENTITY_COLLISION');
  });

  it('rejects a pair-only partial mapping instead of falling through to email or creation', async () => {
    const partial = {
      id: 'partial',
      email: identity.email,
      name: 'Partial',
      ideaflowIssuer: identity.issuer,
      ideaflowSub: identity.subject,
      ideaflowIdentityKey: null,
    };
    const session = sessionWithResults(result([partial]));

    await expect(resolveIdeaflowSignIn(session as never, identity, OPEN_COHORT_WITH_CREATION))
      .rejects.toThrow('IDEAFLOW_IDENTITY_COLLISION');
    expect(session.run).toHaveBeenCalledTimes(1);
  });

  it('rejects a key-only partial mapping instead of accepting it as durable identity', async () => {
    const partial = {
      id: 'partial',
      email: identity.email,
      name: 'Partial',
      ideaflowIdentityKey: `${identity.issuer}\u001f${identity.subject}`,
    };
    const session = sessionWithResults(result([partial]));

    await expect(resolveIdeaflowSignIn(session as never, identity, OPEN_COHORT_WITH_CREATION))
      .rejects.toThrow('IDEAFLOW_IDENTITY_COLLISION');
    expect(session.run).toHaveBeenCalledTimes(1);
  });

  it('translates a new-user unique constraint race into an identity collision', async () => {
    const constraintError = Object.assign(new Error('duplicate identity key'), {
      code: 'Neo.ClientError.Schema.ConstraintValidationFailed',
    });
    const session = {
      run: vi.fn()
        .mockResolvedValueOnce(result([]))
        .mockResolvedValueOnce(result([]))
        .mockRejectedValueOnce(constraintError),
      close: vi.fn(),
    };

    await expect(resolveIdeaflowSignIn(session as never, identity, OPEN_COHORT_WITH_CREATION))
      .rejects.toThrow('IDEAFLOW_IDENTITY_COLLISION');
  });

  it('admits only allowlisted emails when the cohort is a specific list, not "*"', async () => {
    const cohort = getIdeaflowCohortConfig({ IDEAFLOW_ID_COHORT_ALLOWLIST: 'someone-else@example.test' });
    const session = sessionWithResults(result([]));

    await expect(resolveIdeaflowSignIn(session as never, identity, cohort))
      .rejects.toThrow('IDEAFLOW_COHORT_DENIED');
    expect(session.run).not.toHaveBeenCalled();
  });
});
