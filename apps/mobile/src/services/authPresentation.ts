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
      title: 'Link your existing account first',
      message:
        'This Ideaflow ID matches an existing OpenChat account. Sign in below with an existing method, then link Ideaflow ID in Settings.',
      recovery: true,
    };
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
