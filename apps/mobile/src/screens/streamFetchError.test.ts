import { describe, expect, it } from 'vitest';
import { streamFetchErrorMessage } from './streamFetchError';

describe('Stream fetch error display', () => {
  it('uses Stream wording for API failures on both Stream views', () => {
    expect(streamFetchErrorMessage(new Error('500: Failed to fetch thoughts'), 'Failed to load'))
      .toBe('Failed to load Stream');
    expect(streamFetchErrorMessage(new Error('Failed to fetch conversation thoughts'), 'Failed to load'))
      .toBe("Failed to load this chat's Stream");
  });

  it('keeps other errors and falls back when no message is available', () => {
    expect(streamFetchErrorMessage(new Error('Network request failed'), 'Failed to load Stream'))
      .toBe('Network request failed');
    expect(streamFetchErrorMessage(null, 'Failed to load Stream'))
      .toBe('Failed to load Stream');
  });
});
