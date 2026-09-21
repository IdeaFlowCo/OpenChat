export const LEGACY_PLACEHOLDER_EMAIL_DOMAIN = 'users.openchat.invalid';

/**
 * Checks if a given email is the internal legacy crash-fix placeholder address.
 * E.g., user_id@users.openchat.invalid
 */
export function isPlaceholderEmail(email?: string | null): boolean {
  if (!email) return false;
  return email.toLowerCase().endsWith(`@${LEGACY_PLACEHOLDER_EMAIL_DOMAIN}`);
}
