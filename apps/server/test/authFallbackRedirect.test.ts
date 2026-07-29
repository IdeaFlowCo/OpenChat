import { describe, expect, it } from 'vitest';
import { getAuthFallbackRedirect } from '../src/routes/auth.js';

describe('getAuthFallbackRedirect', () => {
  it('uses OPENCHAT_URL before CORS_ORIGIN', () => {
    expect(
      getAuthFallbackRedirect(
        'https://chat.globalbr.ai',
        'https://social.globalbr.ai',
      ),
    ).toBe('https://chat.globalbr.ai/auth/callback');
  });

  it('uses the first configured CORS origin when OPENCHAT_URL is unset', () => {
    expect(
      getAuthFallbackRedirect(
        undefined,
        ' https://social.globalbr.ai, https://chat.globalbr.ai ',
      ),
    ).toBe('https://social.globalbr.ai/auth/callback');
  });

  it('keeps the localhost fallback when no CORS origin is configured', () => {
    expect(getAuthFallbackRedirect(undefined, ' , ')).toBe(
      'http://localhost:5173/auth/callback',
    );
  });
});
