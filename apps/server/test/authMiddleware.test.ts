import jwt from 'jsonwebtoken';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateToken } from '../src/middleware/auth.js';

const PRIMARY_SECRET = 'openchat-primary-test-secret';
const NOOS_SECRET = 'noos-secondary-test-secret';
const AUTH_USER = { userId: 'user-test-1', email: 'person@example.com' };

describe('validateToken', () => {
  beforeEach(() => {
    process.env.JWT_SECRET = PRIMARY_SECRET;
    delete process.env.NOOS_JWT_SECRET;
  });

  afterEach(() => {
    delete process.env.JWT_SECRET;
    delete process.env.NOOS_JWT_SECRET;
  });

  it('accepts tokens signed with the primary OpenChat secret', () => {
    const token = jwt.sign(AUTH_USER, PRIMARY_SECRET);

    expect(validateToken(token)).toMatchObject(AUTH_USER);
  });

  it('accepts tokens signed with the verify-only Noos secret', () => {
    process.env.NOOS_JWT_SECRET = NOOS_SECRET;
    const token = jwt.sign(AUTH_USER, NOOS_SECRET);

    expect(validateToken(token)).toMatchObject(AUTH_USER);
  });

  it('keeps accepting primary tokens when the Noos secret is configured', () => {
    process.env.NOOS_JWT_SECRET = NOOS_SECRET;
    const token = jwt.sign(AUTH_USER, PRIMARY_SECRET);

    expect(validateToken(token)).toMatchObject(AUTH_USER);
  });

  it('rejects tokens signed with an unknown secret', () => {
    process.env.NOOS_JWT_SECRET = NOOS_SECRET;
    const token = jwt.sign(AUTH_USER, 'unknown-secret');

    expect(validateToken(token)).toBeNull();
  });

  it('rejects signed payloads that do not contain required auth claims', () => {
    const token = jwt.sign({ subject: 'missing-user-claims' }, PRIMARY_SECRET);

    expect(validateToken(token)).toBeNull();
  });
});
