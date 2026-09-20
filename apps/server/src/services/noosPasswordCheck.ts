/**
 * OpenChat has no password verifier of its own: password sign-in is delegated
 * to Noos (`POST /api/auth/login`), which owns the shared `:User.passwordHash`.
 * The one-time Ideaflow ownership check reuses that same endpoint as its oracle
 * so there is exactly one place that judges a password, with its own rate
 * limiting. The caller must still confirm the returned id is the account it
 * meant to check.
 */
export async function verifyPasswordViaNoos(
  email: string,
  password: string,
  noosUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ userId: string } | null> {
  if (!password || password.length > 1024) return null;
  try {
    const res = await fetchImpl(`${noosUrl.replace(/\/+$/, '')}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const body = await res.json() as { user?: { id?: unknown } };
    return typeof body.user?.id === 'string' && body.user.id ? { userId: body.user.id } : null;
  } catch {
    return null;
  }
}
