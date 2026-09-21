/**
 * Legacy-client compatibility shim (openchat-dwk).
 *
 * OpenChat-51a (`4dd81f5`, 2026-09-16) removed the real `email` field from every
 * user-shaped projection so one user never learns another's address. That was
 * correct, but it was a *breaking* change for App Store binaries already in
 * users' hands: iOS v0.1.24 (build 91, JS frozen 2026-09-02) calls
 * `p.user.email.split('@')` unconditionally while rendering group messages, so
 * the absent field became a fatal `TypeError` the moment any group was opened.
 * See `docs/decisions/2026-09-20-legacy-placeholder-email.md`.
 *
 * Those clients therefore get a *synthetic* address derived from the opaque
 * user id they already hold. It satisfies their `split('@')` deref while
 * leaking nothing: the domain is reserved by RFC 2606 and can never route.
 *
 * Do NOT reintroduce the real address anywhere 51a removed it. Clients built
 * from `4dd81f5` onward ignore this field entirely, so it can be deleted once
 * v0.1.24 installs have decayed.
 */

/** RFC 2606 reserved TLD — guarantees the placeholder can never be delivered. */
export const LEGACY_PLACEHOLDER_EMAIL_DOMAIN = 'users.openchat.invalid';

/** Synthetic, non-routable stand-in for a user's address. */
export function legacyPlaceholderEmail(userId: string): string {
  return `${userId}@${LEGACY_PLACEHOLDER_EMAIL_DOMAIN}`;
}

/** True only for values this module produced — never for a real address. */
export function isLegacyPlaceholderEmail(value: unknown): value is string {
  return (
    typeof value === 'string' && value.endsWith(`@${LEGACY_PLACEHOLDER_EMAIL_DOMAIN}`)
  );
}

/**
 * Cypher map-projection entry yielding the placeholder for a user variable.
 *
 * Usage: `` participant { .id, .name, ${legacyEmailProjection('participant')} } ``
 */
export function legacyEmailProjection(userVar: string): string {
  return `email: ${userVar}.id + '@${LEGACY_PLACEHOLDER_EMAIL_DOMAIN}'`;
}
