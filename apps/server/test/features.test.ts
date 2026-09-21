import { describe, expect, it } from 'vitest';
import { isOpenUserDirectoryEnabled } from '../src/config/features.js';

describe('OPENCHAT_OPEN_USER_DIRECTORY', () => {
  it('defaults on for the friends-only beta', () => {
    expect(isOpenUserDirectoryEnabled({})).toBe(true);
  });

  it.each(['0', 'false', 'FALSE', 'no', 'off'])(
    'can be disabled with %s',
    value => {
      expect(isOpenUserDirectoryEnabled({ OPENCHAT_OPEN_USER_DIRECTORY: value })).toBe(false);
    },
  );

  it.each(['1', 'true', 'yes', 'on'])(
    'is enabled with %s',
    value => {
      expect(isOpenUserDirectoryEnabled({ OPENCHAT_OPEN_USER_DIRECTORY: value })).toBe(true);
    },
  );
});
