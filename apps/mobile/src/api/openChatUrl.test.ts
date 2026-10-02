import { describe, expect, it } from 'vitest';
import { resolveOpenChatUrl } from './openChatUrl';

describe('resolveOpenChatUrl', () => {
  it('keeps API requests on either production chat origin', () => {
    expect(resolveOpenChatUrl(undefined, 'https://chat.ideaflow.app')).toBe('https://chat.ideaflow.app');
    expect(resolveOpenChatUrl(undefined, 'https://chat.globalbr.ai')).toBe('https://chat.globalbr.ai');
  });

  it('uses the public host outside the production chat origins', () => {
    expect(resolveOpenChatUrl(undefined, 'http://localhost:8081')).toBe('https://chat.ideaflow.app');
    expect(resolveOpenChatUrl(undefined, 'https://preview.example.com')).toBe('https://chat.ideaflow.app');
    expect(resolveOpenChatUrl()).toBe('https://chat.ideaflow.app');
  });

  it('honors an explicit development URL', () => {
    expect(resolveOpenChatUrl('http://localhost:9000', 'http://localhost:8081')).toBe('http://localhost:9000');
  });
});
