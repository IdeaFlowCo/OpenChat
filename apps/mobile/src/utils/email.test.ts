import { describe, expect, it } from 'vitest';
import { isPlaceholderEmail } from './email';

describe('isPlaceholderEmail', () => {
  it('returns false for empty or null emails', () => {
    expect(isPlaceholderEmail(null)).toBe(false);
    expect(isPlaceholderEmail(undefined)).toBe(false);
    expect(isPlaceholderEmail('')).toBe(false);
  });

  it('returns false for normal email addresses', () => {
    expect(isPlaceholderEmail('alice@noos.app')).toBe(false);
    expect(isPlaceholderEmail('bob@gmail.com')).toBe(false);
    expect(isPlaceholderEmail('test@openchat.invalid')).toBe(false);
  });

  it('returns true for placeholder emails', () => {
    expect(isPlaceholderEmail('NHrSJzZDlm1T6_-dRGKqv@users.openchat.invalid')).toBe(true);
    expect(isPlaceholderEmail('12345@users.openchat.invalid')).toBe(true);
    // case insensitivity test
    expect(isPlaceholderEmail('12345@USERS.OPENCHAT.INVALID')).toBe(true);
  });
});
