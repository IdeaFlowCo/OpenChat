import { expect, it, vi } from 'vitest';
import { StreamCollapseState } from './streamCollapseState';

it('keeps shared current state when mounted cards retain stale props', () => {
  const changed = vi.fn();
  const state = new StreamCollapseState(changed);
  state.ingest('a', [{ id: 'entry', collapsed: false }]);
  state.set('a', 'entry', true);
  state.ingest('a', [{ id: 'entry', collapsed: true }]);
  expect(state.read('a', 'entry', false)).toBe(true);
  expect(state.read('a', 'entry', true)).toBe(true);
  expect(changed).toHaveBeenCalledTimes(2);
  state.ingest('a', [{ id: 'entry', collapsed: false }]);
  expect(state.read('a', 'entry', true)).toBe(false);
  expect(changed).toHaveBeenCalledTimes(3);
});

it('isolates viewers and uses props only for entries never ingested', () => {
  const changed = vi.fn();
  const state = new StreamCollapseState(changed);
  expect(state.read('a', 'entry', true)).toBe(true);
  expect(state.read('a', 'entry', false)).toBe(false);
  expect(changed).not.toHaveBeenCalled();
  state.ingest('a', [{ id: 'entry', collapsed: true }]);
  expect(state.read('b', 'entry', false)).toBe(false);
  state.ingest('a', [{ id: 'entry' }]);
  expect(state.read('a', 'entry', false)).toBe(true);
  state.set('b', 'entry', false);
  expect(state.read('a', 'entry', false)).toBe(true);
  expect(state.read('b', 'entry', true)).toBe(false);
});
