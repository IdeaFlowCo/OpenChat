export const AUTH_NOTICE_KEY = 'openchat_auth_notice';
export const AUTH_NOTICE_MESSAGE = "You're not logged in. Please sign in with Noos.";

const TOKEN_EXPIRY_GRACE_MS = 30_000;

export function rememberAuthNotice() {
  sessionStorage.setItem(AUTH_NOTICE_KEY, AUTH_NOTICE_MESSAGE);
}

export function clearStoredSession() {
  localStorage.removeItem('openchat_token');
  localStorage.removeItem('openchat_user');
  localStorage.removeItem('openchat_refresh_token');
  sessionStorage.removeItem('openchat_sso_state');
}

export function decodeJwtPayload(token: string): { userId?: string; email?: string; exp?: number } {
  const payload = token.split('.')[1];
  if (!payload) throw new Error('JWT payload missing');
  const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(base64.length + ((4 - base64.length % 4) % 4), '=');
  return JSON.parse(atob(padded));
}

export function getStoredToken(): string | null {
  const stored = localStorage.getItem('openchat_token');
  if (!stored) return null;

  try {
    const payload = decodeJwtPayload(stored);
    if (typeof payload.exp === 'number' && payload.exp * 1000 <= Date.now() - TOKEN_EXPIRY_GRACE_MS) {
      rememberAuthNotice();
      clearStoredSession();
      return null;
    }
    return stored;
  } catch {
    rememberAuthNotice();
    clearStoredSession();
    return null;
  }
}

export function getStoredUser(): { userId: string; email: string; name?: string } | null {
  const saved = localStorage.getItem('openchat_user');
  if (!saved) return null;

  try {
    return JSON.parse(saved);
  } catch {
    clearStoredSession();
    return null;
  }
}
