import { describe, expect, it } from 'vitest';
import { formatListTime, onlinePresence } from './listTime';

const now = new Date(2026, 9, 10, 15, 0); // Sat 10 Oct 2026, 15:00 local

describe('formatListTime', () => {
  it('shows the time today, Yesterday, a weekday within a week, then a short date', () => {
    expect(formatListTime(new Date(2026, 9, 10, 9, 5).toISOString(), now)).toMatch(/9:05/);
    expect(formatListTime(new Date(2026, 9, 9, 23, 0).toISOString(), now)).toBe('Yesterday');
    expect(formatListTime(new Date(2026, 9, 7, 12, 0).toISOString(), now)).toBe(new Date(2026, 9, 7).toLocaleDateString(undefined, { weekday: 'short' }));
    expect(formatListTime(new Date(2026, 8, 20, 12, 0).toISOString(), now)).toBe(new Date(2026, 8, 20).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }));
    expect(formatListTime(new Date(2025, 8, 20, 12, 0).toISOString(), now)).toContain('25');
    expect(formatListTime(undefined, now)).toBe('');
    expect(formatListTime('nonsense', now)).toBe('');
  });
});

describe('onlinePresence', () => {
  it('hides offline, invisible and unknown', () => {
    expect(onlinePresence('available')).toBe('available');
    expect(onlinePresence('busy')).toBe('busy');
    expect(onlinePresence('offline')).toBeUndefined();
    expect(onlinePresence('invisible')).toBeUndefined();
    expect(onlinePresence(undefined)).toBeUndefined();
  });
});
