import { describe, expect, it } from 'vitest';
import { SWIPE_REVEAL, isSidewaysDrag, swipeOffset, swipeOutcome } from './messageSwipe';

describe('message swipe', () => {
  it('leaves vertical and diagonal drags to the list', () => {
    expect(isSidewaysDrag(40, 4)).toBe(true);
    expect(isSidewaysDrag(-40, 10)).toBe(true);
    expect(isSidewaysDrag(10, 0)).toBe(false);
    expect(isSidewaysDrag(30, 30)).toBe(false);
    expect(isSidewaysDrag(4, 80)).toBe(false);
  });

  it('follows the finger left to the actions, resists beyond them, and caps the reply pull', () => {
    expect(swipeOffset(-60, false)).toBe(-60);
    expect(swipeOffset(-SWIPE_REVEAL - 100, false)).toBe(-SWIPE_REVEAL - 20);
    expect(swipeOffset(500, false)).toBe(84);
    // An open row starts from its open position, so a pull right closes it.
    expect(swipeOffset(0, true)).toBe(-SWIPE_REVEAL);
    expect(swipeOffset(SWIPE_REVEAL, true)).toBe(0);
  });

  it('replies on a firm pull right, opens on a pull left, and otherwise rests', () => {
    expect(swipeOutcome(60)).toBe('reply');
    expect(swipeOutcome(30)).toBe('rest');
    expect(swipeOutcome(-30)).toBe('rest');
    expect(swipeOutcome(-50)).toBe('open');
    expect(swipeOutcome(swipeOffset(SWIPE_REVEAL - 20, true))).toBe('rest');
  });
});
