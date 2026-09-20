export const IDEAFLOW_LINK_RECOVERY_KEY = 'openchat_ideaflow_link_recovery';
export const IDEAFLOW_LINK_RECOVERY_TTL_MS = 5 * 60 * 1000;

export function createIdeaflowLinkRecovery(now = Date.now()): string {
  return String(now + IDEAFLOW_LINK_RECOVERY_TTL_MS);
}

export function isIdeaflowLinkRecoveryActive(value: string | null, now = Date.now()): boolean {
  if (!value || !/^\d+$/.test(value)) return false;
  const expiresAt = Number(value);
  return Number.isSafeInteger(expiresAt) && expiresAt > now;
}

export interface AuthNotice {
  title: string;
  message: string;
  recovery: boolean;
}

interface CodedError {
  message?: unknown;
  code?: unknown;
}

export function authNoticeForFailure(
  provider: 'Ideaflow' | 'Google' | 'password' | 'registration',
  error: unknown,
): AuthNotice {
  const coded = error as CodedError | null;
  if (provider === 'Ideaflow' && coded?.code === 'link_required') {
    return {
      title: 'Connect your existing account',
      message:
        'An OpenChat account with this email exists, but we could not confirm it is yours automatically. Sign in below with an existing method, then connect Ideaflow ID in Settings.',
      recovery: true,
    };
  }
  if (provider === 'Ideaflow') {
    const byCode: Record<string, AuthNotice> = {
      already_linked: {
        title: 'Already connected to another Ideaflow account',
        message:
          'The OpenChat account with this email is connected to a different Ideaflow account. Use that Ideaflow account, or choose Use another Ideaflow account.',
        recovery: false,
      },
      needs_admin_proof: {
        title: 'This account cannot be connected automatically',
        message: 'This account has elevated access, so it needs an administrator to connect Ideaflow ID.',
        recovery: false,
      },
      confirm_expired: {
        title: 'That confirmation expired',
        message: 'Continue with Ideaflow again to start over.',
        recovery: false,
      },
      confirm_locked: {
        title: 'Too many incorrect attempts',
        message: 'Try again in a few minutes.',
        recovery: false,
      },
    };
    const notice = typeof coded?.code === 'string' ? byCode[coded.code] : undefined;
    if (notice) return notice;
  }

  const message =
    typeof coded?.message === 'string' && coded.message.trim()
      ? coded.message
      : typeof error === 'string' && error.trim()
        ? error
        : 'Please try again.';

  const title =
    provider === 'password'
      ? 'Sign-in failed'
      : provider === 'registration'
        ? 'Sign-up failed'
        : `${provider} sign-in failed`;

  return { title, message, recovery: false };
}
