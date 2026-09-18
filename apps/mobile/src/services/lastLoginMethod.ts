// "Last used" sign-in hint (code-v8l). Remembers which method last COMPLETED a
// sign-in on this browser/device so the login screen can point at it when
// several methods are on offer. Storage holds only a short method id: no
// tokens, email, or user ids.

export type LoginMethod = 'ideaflow' | 'google' | 'apple' | 'password';

export const LAST_LOGIN_METHOD_KEY = 'openchat_last_login_method';

export const LOGIN_METHOD_LABELS: Record<LoginMethod, string> = {
  ideaflow: 'Ideaflow',
  google: 'Google',
  apple: 'Apple',
  password: 'email and password',
};

// Minimal AsyncStorage-shaped surface so this stays testable without React Native.
export interface KeyValueStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

/**
 * Validate a stored value against the methods enabled right now. Returns null
 * (no hint) for unknown/stale values and whenever fewer than two methods are
 * on offer, since a hint between one choice is noise.
 */
export function resolveLastLoginMethod(
  stored: string | null | undefined,
  enabled: readonly LoginMethod[],
): LoginMethod | null {
  if (enabled.length < 2 || !stored) return null;
  return enabled.find(method => method === stored) ?? null;
}

export async function readLastLoginMethod(storage: KeyValueStorage): Promise<string | null> {
  try {
    return await storage.getItem(LAST_LOGIN_METHOD_KEY);
  } catch {
    return null;
  }
}

/**
 * Run a sign-in and remember `method` only if it resolved, i.e. the backend
 * completed the exchange and the session was established. Failures and
 * cancellations rethrow untouched and leave the previous hint as it was.
 * A storage failure never affects the sign-in result.
 */
export async function signInAndRemember<T>(
  storage: KeyValueStorage,
  method: LoginMethod,
  signIn: () => Promise<T>,
): Promise<T> {
  const result = await signIn();
  try {
    await storage.setItem(LAST_LOGIN_METHOD_KEY, method);
  } catch {
    /* private mode / quota / unavailable: the hint is best-effort */
  }
  return result;
}
