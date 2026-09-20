import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  close: vi.fn(async () => {}),
}));

vi.mock('../src/db.js', () => ({
  getDriver: () => ({
    session: () => ({ run: mocks.run, close: mocks.close }),
  }),
}));

import {
  DEFAULT_PUBLIC_DISPLAY_NAME,
  isSafePublicDisplayName,
  normalizePublicDisplayName,
  sanitizeLegacyPublicDisplayNames,
} from '../src/privacy/profilePrivacy.js';

describe('public profile privacy', () => {
  beforeEach(() => {
    mocks.run.mockReset();
    mocks.close.mockClear();
  });

  it('keeps real names and replaces blank or email-like values', () => {
    expect(normalizePublicDisplayName('  Ada Lovelace  ')).toBe('Ada Lovelace');
    expect(normalizePublicDisplayName('ada@example.test')).toBe(DEFAULT_PUBLIC_DISPLAY_NAME);
    expect(normalizePublicDisplayName('')).toBe(DEFAULT_PUBLIC_DISPLAY_NAME);
    expect(normalizePublicDisplayName(undefined)).toBe(DEFAULT_PUBLIC_DISPLAY_NAME);
    expect(isSafePublicDisplayName('Ada Lovelace')).toBe(true);
    expect(isSafePublicDisplayName('ada@example.test')).toBe(false);
  });

  it('repairs only display names while preserving user identities and relationships', async () => {
    mocks.run.mockResolvedValueOnce({
      records: [{ get: () => ({ toNumber: () => 3 }) }],
    });

    await expect(sanitizeLegacyPublicDisplayNames()).resolves.toBe(3);

    const [cypher, params] = mocks.run.mock.calls[0];
    expect(String(cypher)).toContain("u.name CONTAINS '@'");
    expect(String(cypher)).toContain('SET u.name = $fallback');
    expect(String(cypher)).not.toContain('DETACH DELETE');
    expect(params).toEqual({ fallback: DEFAULT_PUBLIC_DISPLAY_NAME });
    expect(mocks.close).toHaveBeenCalledOnce();
  });
});
