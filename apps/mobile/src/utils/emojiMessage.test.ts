import { describe, expect, it } from 'vitest';
import {
  DEFAULT_QUICK_EMOJI, HOLD_LEVEL_MS, MAX_EMOJI_SIZE, QUICK_EMOJI_CHOICES, clampEmojiSize, emojiFontSize,
  holdLevelForDuration, holdScaleForDuration, isSingleEmoji, parseTicklePayload, tickleLine,
} from './emojiMessage';

describe('isSingleEmoji', () => {
  it('accepts every picker choice and the default', () => {
    for (const e of [DEFAULT_QUICK_EMOJI, ...QUICK_EMOJI_CHOICES]) expect(isSingleEmoji(e), e).toBe(true);
  });
  it('accepts modifiers, ZWJ families and flags', () => {
    for (const e of ['👍🏽', '👨‍👩‍👧‍👦', '🇯🇵', ' ❤️ ', '1️⃣']) expect(isSingleEmoji(e), e).toBe(true);
  });
  it('rejects text, several emoji and digits', () => {
    for (const e of ['', 'hi', '🍓🍓', '🍓 ok', '1', '#', 'a🍓', undefined]) expect(isSingleEmoji(e), String(e)).toBe(false);
  });
});

describe('sizes', () => {
  it('clamps to 1..MAX and grows the font with each level', () => {
    expect(clampEmojiSize(undefined)).toBe(1);
    expect(clampEmojiSize(99)).toBe(MAX_EMOJI_SIZE);
    expect(clampEmojiSize(2.4)).toBe(2);
    const sizes = [1, 2, 3, 4].map(emojiFontSize);
    for (let i = 1; i < sizes.length; i++) expect(sizes[i]).toBeGreaterThan(sizes[i - 1]);
  });
  it('maps hold duration to levels at the documented thresholds', () => {
    expect(holdLevelForDuration(0)).toBe(1);
    expect(holdLevelForDuration(HOLD_LEVEL_MS[1] - 1)).toBe(1);
    expect(holdLevelForDuration(HOLD_LEVEL_MS[1])).toBe(2);
    expect(holdLevelForDuration(HOLD_LEVEL_MS[2])).toBe(3);
    expect(holdLevelForDuration(HOLD_LEVEL_MS[3])).toBe(4);
    expect(holdLevelForDuration(60_000)).toBe(MAX_EMOJI_SIZE);
  });
  it('scales the held button smoothly and never past its ceiling', () => {
    expect(holdScaleForDuration(0)).toBe(1);
    expect(holdScaleForDuration(HOLD_LEVEL_MS[3])).toBeCloseTo(2.8);
    expect(holdScaleForDuration(99_999)).toBeCloseTo(2.8);
  });
});

describe('tickle cards', () => {
  const card = { cardKind: 'tickle', cardPayload: JSON.stringify({ fromUserId: 'a', toUserId: 'b', fromName: 'Ana', toName: 'Bo' }) };
  it('parses a well-formed payload and ignores anything else', () => {
    expect(parseTicklePayload(card)).toEqual({ fromUserId: 'a', toUserId: 'b', fromName: 'Ana', toName: 'Bo' });
    expect(parseTicklePayload({ cardKind: 'match_status', cardPayload: card.cardPayload })).toBeNull();
    expect(parseTicklePayload({ cardKind: 'tickle', cardPayload: '{nope' })).toBeNull();
    expect(parseTicklePayload({ cardKind: 'tickle', cardPayload: '{"fromUserId":"a"}' })).toBeNull();
  });
  it('phrases the line from the viewer\'s side', () => {
    const p = parseTicklePayload(card)!;
    expect(tickleLine(p, 'a')).toBe('You tickled Bo');
    expect(tickleLine(p, 'b')).toBe('Ana tickled you');
    expect(tickleLine(p, 'c')).toBe('Ana tickled Bo');
    expect(tickleLine(p, undefined)).toBe('Ana tickled Bo');
  });
});
