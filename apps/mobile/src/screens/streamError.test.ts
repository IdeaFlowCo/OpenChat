import { describe, expect, it } from 'vitest';
import { streamErrorMessage } from './streamError';

describe('Stream fetch error display', () => {
  it('uses Stream wording for API failures on both Stream views', () => {
    expect(streamErrorMessage(new Error('500: Failed to fetch thoughts'), 'Failed to load'))
      .toBe('Failed to load Stream');
    expect(streamErrorMessage(new Error('Failed to fetch conversation thoughts'), 'Failed to load'))
      .toBe("Failed to load this chat's Stream");
  });

  it('maps caught mutation errors while preserving status and ownership details', () => {
    for (const [apiMessage, displayMessage] of [
      ['500: Failed to create thought', '500: Failed to create Stream entry'],
      ['500: Failed to update thought', '500: Failed to update Stream entry'],
      ['500: Failed to delete thought', '500: Failed to delete Stream entry'],
      ['500: Failed to pin thought', '500: Failed to pin Stream entry'],
      ['500: Failed to unpin thought', '500: Failed to unpin Stream entry'],
      ['404: Thought not found or not owned by you', '404: Stream entry not found or not owned by you'],
      ['404: Thought or conversation not found (or not yours)', '404: Stream entry or conversation not found (or not yours)'],
    ]) {
      try {
        throw new Error(apiMessage);
      } catch (error) {
        expect(streamErrorMessage(error, 'Failed to save Stream entry')).toBe(displayMessage);
      }
    }
  });

  it('keeps other errors and falls back when no message is available', () => {
    expect(streamErrorMessage(new Error('Network request failed'), 'Failed to load Stream'))
      .toBe('Network request failed');
    expect(streamErrorMessage(null, 'Failed to load Stream'))
      .toBe('Failed to load Stream');
  });
});
