import { afterEach, describe, expect, it, vi } from 'vitest';
import { markIdeaflowAccountChoice, takeIdeaflowAccountChoice } from './ideaflowAccountChoice';

function fakeStorage(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    clear: () => values.clear(),
    key: () => null,
    get length() { return values.size; },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('Ideaflow account choice after sign-out', () => {
  it('asks once after an explicit sign-out, then reuses the provider session', () => {
    vi.stubGlobal('window', { localStorage: fakeStorage() });
    expect(takeIdeaflowAccountChoice()).toBe(false);
    markIdeaflowAccountChoice();
    expect(takeIdeaflowAccountChoice()).toBe(true);
    expect(takeIdeaflowAccountChoice()).toBe(false);
  });

  it('is a no-op without browser storage (native)', () => {
    vi.stubGlobal('window', undefined);
    expect(() => markIdeaflowAccountChoice()).not.toThrow();
    expect(takeIdeaflowAccountChoice()).toBe(false);
  });
});
