/**
 * Parses CORS_ORIGIN as a comma-separated allowlist.
 * Single-origin values remain valid; whitespace and empty entries are ignored.
 */
export function parseCorsOrigins(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}
