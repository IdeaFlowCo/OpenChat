import { describe, expect, it } from 'vitest';
import { parseCorsOrigins } from '../src/config/cors.js';

describe('parseCorsOrigins', () => {
  it('preserves a single-origin configuration', () => {
    expect(parseCorsOrigins('https://chat.globalbr.ai')).toEqual([
      'https://chat.globalbr.ai',
    ]);
  });

  it('splits, trims, and drops empty comma-separated entries', () => {
    expect(
      parseCorsOrigins(
        ' https://chat.globalbr.ai, ,https://social.globalbr.ai,',
      ),
    ).toEqual([
      'https://chat.globalbr.ai',
      'https://social.globalbr.ai',
    ]);
  });

  it('returns an empty allowlist when unset', () => {
    expect(parseCorsOrigins(undefined)).toEqual([]);
  });
});
