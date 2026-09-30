export function streamFetchErrorMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : '';
  if (/^(?:\d{3}: )?Failed to fetch thoughts$/.test(message)) return 'Failed to load Stream';
  if (/^(?:\d{3}: )?Failed to fetch conversation thoughts$/.test(message)) {
    return "Failed to load this chat's Stream";
  }
  return message || fallback;
}
