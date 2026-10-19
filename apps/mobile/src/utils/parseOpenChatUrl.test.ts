import { describe, expect, it } from 'vitest';
import { originalMessageUrl, parseOpenChatUrl } from './parseOpenChatUrl';

describe('parseOpenChatUrl AddMe cards', () => {
  const token = 'AbCdEfGhIjKlMnOpQrStUvWx';

  it('parses the QR (https) form', () => {
    expect(parseOpenChatUrl(`https://chat.ideaflow.app/c/${token}`)).toEqual({ type: 'card', token });
    expect(parseOpenChatUrl(`https://chat.globalbr.ai/c/${token}`)).toEqual({ type: 'card', token });
  });

  it('parses the native scheme and the post-auth web intent', () => {
    expect(parseOpenChatUrl(`openchat://card/${token}`)).toEqual({ type: 'card', token });
    expect(parseOpenChatUrl(`https://chat.globalbr.ai/app/?intent=card&token=${token}`)).toEqual({ type: 'card', token });
    expect(parseOpenChatUrl(`https://chat.ideaflow.app/app/?intent=card&token=${token}`)).toEqual({ type: 'card', token });
  });

  it('leaves existing person and invite links unchanged', () => {
    expect(parseOpenChatUrl('https://chat.globalbr.ai/u/user123')).toEqual({ type: 'user', userId: 'user123' });
    expect(parseOpenChatUrl('https://chat.globalbr.ai/i/tok')).toEqual({ type: 'invite', token: 'tok' });
    expect(parseOpenChatUrl('https://chat.ideaflow.app/u/user123')).toEqual({ type: 'user', userId: 'user123' });
    expect(parseOpenChatUrl('https://chat.ideaflow.app/i/tok')).toEqual({ type: 'invite', token: 'tok' });
    expect(parseOpenChatUrl('https://example.com/c/abc')).toEqual({ type: 'unknown' });
  });
});

describe('Stream original-message links', () => {
  it('round-trips the shareable link to the original message', () => {
    const url = originalMessageUrl('VASum6BCBCg594zj-lXkH');
    expect(url).toBe('https://chat.ideaflow.app/app/original/VASum6BCBCg594zj-lXkH');
    expect(parseOpenChatUrl(url)).toEqual({ type: 'original', thoughtId: 'VASum6BCBCg594zj-lXkH' });
    expect(parseOpenChatUrl('https://chat.ideaflow.app/app/original/')).toEqual({ type: 'unknown' });
  });
});
