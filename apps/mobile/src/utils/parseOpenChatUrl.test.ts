import { describe, expect, it } from 'vitest';
import { conversationUrl, messageUrl, originalMessageUrl, parseOpenChatUrl } from './parseOpenChatUrl';

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

  it('parses a conversation web link (group default chat)', () => {
    expect(parseOpenChatUrl('https://chat.ideaflow.app/app/chat/conv_group_1')).toEqual({ type: 'conversation', conversationId: 'conv_group_1' });
    expect(parseOpenChatUrl('https://chat.ideaflow.app/app/chat/../x')).toEqual({ type: 'unknown' });
    expect(conversationUrl('conv_group_1')).toBe('https://chat.ideaflow.app/app/chat/conv_group_1');
  });
});

describe('message permalinks', () => {
  it('round-trips stable web links and supports the native message shape', () => {
    expect(parseOpenChatUrl('https://chat.ideaflow.app/app/message/old-message_1')).toEqual({ type: 'message', messageId: 'old-message_1' });
    expect(parseOpenChatUrl('https://chat.globalbr.ai/app/message/old-message_1/')).toEqual({ type: 'message', messageId: 'old-message_1' });
    expect(parseOpenChatUrl('openchat://message/old-message_1')).toEqual({ type: 'message', messageId: 'old-message_1' });
  });
  it('does not accept a lookalike origin, malformed ID or extra path', () => {
    for (const raw of ['https://evil.invalid/app/message/old-message', 'https://chat.ideaflow.app/app/message/bad%ZZid', 'openchat://message/id/extra', 'https://chat.ideaflow.app/app/message/']) expect(parseOpenChatUrl(raw)).toEqual({ type: 'unknown' });
  });
});

it('round-trips opaque persisted message IDs without changing or double-decoding them', () => {
  for (const id of ['client:legacy-1', 'a/b?c#d%2F', 'unicode-東京', 'a b', 'a'.repeat(300), '.', '..']) {
    expect(parseOpenChatUrl(messageUrl(id))).toEqual({ type: 'message', messageId: id });
    expect(parseOpenChatUrl(`openchat://message?${new URLSearchParams({id})}`)).toEqual({ type: 'message', messageId: id });
  }
});
