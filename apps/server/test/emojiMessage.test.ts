import { describe, expect, it } from 'vitest';
import { isSingleEmoji, parseEmojiSize, MAX_EMOJI_SIZE } from '../src/services/emojiMessage.js';

describe('isSingleEmoji', () => {
  it('accepts one emoji, with modifiers, ZWJ sequences and flags', () => {
    for (const e of ['🍓', '❤️', '👍🏽', '👨‍👩‍👧‍👦', '🇯🇵', ' 🙏 ', '1️⃣', '🏳️‍🌈']) {
      expect(isSingleEmoji(e), e).toBe(true);
    }
  });
  it('rejects text, several emoji, digits and empty input', () => {
    for (const e of ['', 'hi', '🍓🍓', '🍓 ok', '1', '#', 'a🍓', '  ', undefined, 3]) {
      expect(isSingleEmoji(e), String(e)).toBe(false);
    }
  });
});

describe('parseEmojiSize', () => {
  it('stores nothing when omitted', () => {
    expect(parseEmojiSize(undefined, '🍓')).toEqual({ ok: true, size: null });
    expect(parseEmojiSize(null, '🍓')).toEqual({ ok: true, size: null });
  });
  it('keeps a valid size on a single emoji', () => {
    expect(parseEmojiSize(3, '🍓')).toEqual({ ok: true, size: 3 });
    expect(parseEmojiSize(MAX_EMOJI_SIZE, '👍🏽')).toEqual({ ok: true, size: MAX_EMOJI_SIZE });
  });
  it('ignores a size on ordinary text', () => {
    expect(parseEmojiSize(3, 'hello 🍓')).toEqual({ ok: true, size: null });
  });
  it('rejects out-of-range or non-integer sizes', () => {
    for (const v of [0, MAX_EMOJI_SIZE + 1, 1.5, '2', true]) {
      expect(parseEmojiSize(v, '🍓').ok, String(v)).toBe(false);
    }
  });
});
