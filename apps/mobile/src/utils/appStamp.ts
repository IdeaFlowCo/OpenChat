export type AppStampData = {
  version: string;
  commit?: string | null;
  commitTime?: string | null;
  buildTime?: string | null;
  event?: 'commit' | 'build';
};

export function stampTime(stamp: AppStampData): string | null {
  const value = stamp.event === 'commit' ? stamp.commitTime : stamp.event === 'build' ? stamp.buildTime : null;
  return value && /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value)) ? value : null;
}

export function relativeStamp(value: string, now: number): string {
  const time = new Date(value);
  const elapsed = now - time.getTime();
  if (elapsed < -120000) return 'clock difference';
  if (elapsed < 60000) return 'just now';
  if (elapsed < 3600000) return `${Math.floor(elapsed / 60000)}m ago`;
  if (elapsed < 86400000) return `${Math.floor(elapsed / 3600000)}h ago`;
  if (elapsed < 604800000) return `${Math.floor(elapsed / 86400000)}d ago`;
  return time.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(time.getFullYear() !== new Date(now).getFullYear() ? { year: 'numeric' } : {}) });
}

export function exactStamp(stamp: AppStampData, value: string): string {
  return `${new Date(value).toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'long' })}${stamp.commit ? ` · commit ${stamp.commit.slice(0, 7)}` : ''}${stamp.event === 'build' ? ' (build time)' : ''}`;
}
