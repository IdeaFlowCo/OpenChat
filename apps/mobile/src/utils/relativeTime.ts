/** Relative metadata shared by Stream and back-channel cards. */
export function formatRelativeTime(iso: string, now = Date.now()): string {
  const date = new Date(iso), timestamp = date.getTime();
  if (!Number.isFinite(timestamp)) return 'Unknown date';
  const diff = Math.max(0, now - timestamp);
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return date.toLocaleDateString();
}
