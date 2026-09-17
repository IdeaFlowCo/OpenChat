import { describe, expect, it } from 'vitest';
import { authNoticeForFailure } from './authPresentation';

describe('authNoticeForFailure', () => {
  it('turns the stable link_required code into explicit-link recovery', () => {
    expect(
      authNoticeForFailure('Ideaflow', {
        code: 'link_required',
        message: 'server wording can change',
      }),
    ).toEqual({
      title: 'Link your existing account first',
      message:
        'This Ideaflow ID matches an existing OpenChat account. Sign in below with an existing method, then link Ideaflow ID in Settings.',
      recovery: true,
    });
  });

  it('does not treat matching email prose as permission to link', () => {
    const notice = authNoticeForFailure(
      'Ideaflow',
      new Error('An OpenChat account with this email already exists.'),
    );
    expect(notice.recovery).toBe(false);
    expect(notice.message).toContain('already exists');
  });

  it('keeps legacy sign-in failures provider-specific', () => {
    expect(authNoticeForFailure('Google', new Error('Access denied'))).toEqual({
      title: 'Google sign-in failed',
      message: 'Access denied',
      recovery: false,
    });
    expect(authNoticeForFailure('password', 'Wrong password').title).toBe(
      'Sign-in failed',
    );
  });
});
