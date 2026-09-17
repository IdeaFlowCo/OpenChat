import { getDriver } from '../db.js';

export const DEFAULT_PUBLIC_DISPLAY_NAME = 'OpenChat member';

/**
 * User-facing names must never become an accidental email-disclosure channel.
 * Authentication providers may omit a name, and legacy records historically
 * fell back to the login email; use a neutral label in either case.
 */
export function normalizePublicDisplayName(
  value: unknown,
  fallback = DEFAULT_PUBLIC_DISPLAY_NAME,
): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes('@')) return fallback;
  return trimmed;
}

export function isSafePublicDisplayName(value: unknown): value is string {
  return typeof value === 'string'
    && value.trim().length > 0
    && !value.includes('@');
}

/**
 * One-time/idempotent startup repair for accounts created before public name
 * discovery. IDs, relationships, and conversation history remain untouched.
 * Failing this repair fails startup so the server never knowingly serves an
 * email address as a public display name.
 */
export async function sanitizeLegacyPublicDisplayNames(): Promise<number> {
  const session = getDriver().session();
  try {
    const result = await session.run(`
      MATCH (u:User)
      WHERE u.name IS NULL OR trim(u.name) = '' OR u.name CONTAINS '@'
      SET u.name = $fallback,
          u.updatedAt = datetime()
      RETURN count(u) AS updated
    `, { fallback: DEFAULT_PUBLIC_DISPLAY_NAME });
    const updated = result.records[0]?.get('updated');
    return typeof updated?.toNumber === 'function' ? updated.toNumber() : Number(updated ?? 0);
  } finally {
    await session.close();
  }
}
