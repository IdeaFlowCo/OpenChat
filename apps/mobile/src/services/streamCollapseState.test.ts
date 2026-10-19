import { expect, it } from 'vitest';
import { StreamCollapseState } from './streamCollapseState';

it('isolates viewers and yields to changed authoritative state', () => {
  const state = new StreamCollapseState();
  state.set('a', 'entry', true, false);
  expect(state.read('a', 'entry', false)).toBe(true);
  expect(state.read('b', 'entry', false)).toBe(false);
  expect(state.read('a', 'entry', true)).toBe(true);
  expect(state.read('a', 'entry', false)).toBe(false);
});

it('reconciles socket overrides after observing their baseline', () => {
  const state = new StreamCollapseState();
  state.set('a', 'entry', true);
  expect(state.read('a', 'entry', false)).toBe(true);
  expect(state.read('a', 'entry', true)).toBe(true);
  expect(state.read('a', 'entry', false)).toBe(false);
});
