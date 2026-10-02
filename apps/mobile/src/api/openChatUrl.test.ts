import { describe, expect, it } from 'vitest';
import { resolveOpenChatUrl } from './openChatUrl';

describe('resolveOpenChatUrl', () => {
  it('keeps API requests on either production chat origin', () => {
    expect(resolveOpenChatUrl(undefined, 'https://chat.ideaflow.app')).toBe('https://chat.ideaflow.app');
    expect(resolveOpenChatUrl(undefined, 'https://chat.globalbr.ai')).toBe('https://chat.globalbr.ai');
  });

  it('uses the serving legacy host outside the production chat origins until the cutover', () => {
    expect(resolveOpenChatUrl(undefined, 'http://localhost:8081')).toBe('https://chat.globalbr.ai');
    expect(resolveOpenChatUrl(undefined, 'https://preview.example.com')).toBe('https://chat.globalbr.ai');
    expect(resolveOpenChatUrl()).toBe('https://chat.globalbr.ai');
  });

  it('honors an explicit development URL', () => {
    expect(resolveOpenChatUrl('http://localhost:9000', 'http://localhost:8081')).toBe('http://localhost:9000');
  });
});
