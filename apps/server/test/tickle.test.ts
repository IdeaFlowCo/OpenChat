import { beforeEach, describe, expect, it } from 'vitest';
import { TICKLE_COOLDOWN_MS, resetTickleCooldowns, tickleAllowed, tickleContent } from '../src/services/tickle.js';

describe('tickleAllowed', () => {
  beforeEach(() => resetTickleCooldowns());

  it('allows the first tickle and blocks a repeat inside the cooldown', () => {
    expect(tickleAllowed('a', 'b', 1000)).toBe(true);
    expect(tickleAllowed('a', 'b', 1000 + TICKLE_COOLDOWN_MS - 1)).toBe(false);
    expect(tickleAllowed('a', 'b', 1000 + TICKLE_COOLDOWN_MS)).toBe(true);
  });

  it('tracks each sender/target pair separately', () => {
    expect(tickleAllowed('a', 'b', 1000)).toBe(true);
    expect(tickleAllowed('b', 'a', 1000)).toBe(true);
    expect(tickleAllowed('a', 'c', 1000)).toBe(true);
    expect(tickleAllowed('a', 'b', 1001)).toBe(false);
  });
});

describe('tickleContent', () => {
  it('reads as a plain sentence for previews and old clients', () => {
    expect(tickleContent('Jacob', 'Alice')).toBe('Jacob tickled Alice');
  });
});
