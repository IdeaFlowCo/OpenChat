export function streamErrorMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : '';
  if (/^(?:\d{3}: )?Failed to fetch thoughts$/.test(message)) return 'Failed to load Stream';
  if (/^(?:\d{3}: )?Failed to fetch conversation thoughts$/.test(message)) {
    return "Failed to load this chat's Stream";
  }
  return message
    ? message.replace(/\bthoughts\b/gi, 'Stream entries').replace(/\bthought\b/gi, 'Stream entry')
    : fallback;
}
