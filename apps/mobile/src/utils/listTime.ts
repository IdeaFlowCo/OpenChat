/**
 * Chat-list timestamps the way iMessage and WhatsApp show them
 * (OpenChat-eo3n.8): the time today, "Yesterday", the weekday within a week,
 * then a short date ("Oct 8"), with the year once it is not this year.
 */
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

/** Show a presence dot only when someone is actually around. */
export function onlinePresence(status: string | undefined): string | undefined {
  return status === 'available' || status === 'online' || status === 'away' || status === 'busy' ? status : undefined;
}
