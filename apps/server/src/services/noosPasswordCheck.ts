/**
 * OpenChat has no password verifier of its own: password sign-in is delegated
 * to Noos (`POST /api/auth/login`), which owns the shared `:User.passwordHash`.
 * The one-time Ideaflow ownership check reuses that same endpoint as its oracle
 * so there is exactly one place that judges a password. Noos has no login
 * limiter of its own here, so the caps in ideaflowConfirmFlow are the guard.
 * The caller must still confirm the returned id is the account it meant to
 * check.
 */
/**
 * Where the password oracle lives, or null when it must not be used: unset in
 * production (the localhost default would silently fail every check), or a
 * plaintext URL that is not loopback (passwords must not cross a network in the
 * clear).
 */
export function resolveNoosPasswordOracleUrl(
  configured: string | undefined,
  nodeEnv: string | undefined = process.env.NODE_ENV,
): string | null {
  const raw = configured?.trim();
  if (!raw) return nodeEnv === 'production' ? null : 'http://localhost:52743';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol === 'https:') return raw;
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  return url.protocol === 'http:' && loopback ? raw : null;
}

export type NoosPasswordCheck =
  | { status: 'ok'; userId: string }
  | { status: 'invalid' }
  // The oracle did not give a verdict (outage, timeout, rate limit). Never
  // count this against the person's password.
  | { status: 'unavailable' };

export async function verifyPasswordViaNoos(
  email: string,
  password: string,
  noosUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<NoosPasswordCheck> {
  if (!password || password.length > 1024) return { status: 'invalid' };
  try {
    const res = await fetchImpl(`${noosUrl.replace(/\/+$/, '')}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
      redirect: 'error',
      signal: AbortSignal.timeout(8000),
    });
    // Noos answers a wrong or unknown login with 400/401. Anything else (a WAF 403,
    // a wrong path 404, 429, 5xx) is not a verdict about the password.
    if (res.status === 400 || res.status === 401) {
      return { status: 'invalid' };
    }
    if (!res.ok) return { status: 'unavailable' };
    const body = await res.json() as { user?: { id?: unknown } };
    return typeof body.user?.id === 'string' && body.user.id
      ? { status: 'ok', userId: body.user.id }
      : { status: 'unavailable' };
  } catch {
    return { status: 'unavailable' };
  }
}
