import { expect, it } from 'vitest';
import { formatRelativeTime, formatTime } from './time';

it('uses the shared short month/day contract on cards from seven days onward', () => {
  const now = new Date(2026, 10, 15, 12).getTime();
  const date = new Date(2026, 10, 8, 11);
  const expected = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date);
  expect(formatRelativeTime(date.toISOString(), now)).toBe(expected);
  expect(formatTime(date.toISOString(), { style: 'card', now: new Date(now) })).toBe(expected);
});

it('includes the year only for card dates in a different year', () => {
  const now = new Date(2026, 10, 15, 12).getTime();
  const date = new Date(2025, 10, 8, 11);
  expect(formatRelativeTime(date.toISOString(), now)).toBe(new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(date));
  expect(formatRelativeTime('invalid', now)).toBe('Unknown date');
});
