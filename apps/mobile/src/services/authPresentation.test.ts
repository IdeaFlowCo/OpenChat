import { describe, expect, it } from 'vitest';
import {
  authNoticeForFailure,
  createIdeaflowLinkRecovery,
  IDEAFLOW_LINK_RECOVERY_TTL_MS,
  isIdeaflowLinkRecoveryActive,
} from './authPresentation';

describe('authNoticeForFailure', () => {
  it('expires recovery markers and rejects legacy unbounded values', () => {
    const now = 1_000_000;
    const recovery = createIdeaflowLinkRecovery(now);

    expect(isIdeaflowLinkRecoveryActive(recovery, now + IDEAFLOW_LINK_RECOVERY_TTL_MS - 1)).toBe(true);
    expect(isIdeaflowLinkRecoveryActive(recovery, now + IDEAFLOW_LINK_RECOVERY_TTL_MS)).toBe(false);
    expect(isIdeaflowLinkRecoveryActive('1', now)).toBe(false);
  });

  it('turns the stable link_required code into explicit-link recovery', () => {
    expect(
      authNoticeForFailure('Ideaflow', {
        code: 'link_required',
        message: 'server wording can change',
      }),
    ).toEqual({
      title: 'Connect your existing account',
      message:
        'An OpenChat account with this email exists, but we could not confirm it is yours automatically. Sign in below with an existing method, then connect Ideaflow ID in Settings.',
      recovery: true,
    });
  });

  it('explains the other resolver outcomes by their stable codes, never by server prose', () => {
    for (const code of ['already_linked', 'needs_admin_proof', 'confirm_expired', 'confirm_locked']) {
      const notice = authNoticeForFailure('Ideaflow', { code, message: 'server wording can change' });
      expect(notice.recovery).toBe(false);
      expect(notice.message).not.toContain('server wording');
    }
    // Only Ideaflow failures use these notices.
    expect(authNoticeForFailure('Google', { code: 'already_linked', message: 'x' }).title).toBe('Google sign-in failed');
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
