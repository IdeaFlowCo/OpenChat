export function formatListTime(iso: string | undefined, now: Date = new Date()): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (days <= 0) return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (days === 1) return 'Yesterday';
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: 'short' });
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: '2-digit' });
}

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

export function formatTime(iso: string | undefined, options: { style: 'list' | 'bubble' | 'card'; now?: Date }): string {
  if (options.style === 'list') return formatListTime(iso, options.now);
  if (!iso) return '';
  if (options.style === 'card') return formatRelativeTime(iso, options.now?.getTime());
  const date = new Date(iso);
  return Number.isFinite(date.getTime()) ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
}
