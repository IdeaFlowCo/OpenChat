import React from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ listPrivateThings: vi.fn(), listFriends: vi.fn() }));
vi.mock('../../mobile/src/api/client', () => ({ api }));
vi.mock('react-native', async () => {
  const { FlatList } = await import('react-native-web');
  return ({
  FlatList,
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  ActivityIndicator: 'ActivityIndicator', ScrollView: 'ScrollView', Text: 'Text', TextInput: 'TextInput', TouchableOpacity: 'TouchableOpacity', View: 'View',
}); });
vi.mock('@react-navigation/native', async () => {
  const React = await import('react');
  return { useNavigation: () => ({ navigate: vi.fn() }), useRoute: () => ({ params: {} }), useFocusEffect: (effect: () => void) => React.useEffect(effect, [effect]) };
});
vi.mock('../../mobile/src/contexts/ChatContext', () => ({ useChat: () => ({ currentUser: { userId: 'owner-a' } }) }));
vi.mock('../../mobile/src/contexts/ThemeContext', () => ({ useTheme: () => ({ scheme: 'light' }) }));
vi.mock('../../mobile/src/components/Avatar', () => ({ Avatar: () => null }));
vi.mock('../../mobile/src/components/AppIcon', () => ({ AppIcon: () => null }));
import { useSavedPeople } from '../../mobile/src/hooks/useSavedPeople.js';
import { FriendsScreen } from '../../mobile/src/screens/FriendsScreen.js';

let state: ReturnType<typeof useSavedPeople>;
let root: ReturnType<typeof create>;
function Probe({ ownerId }: { ownerId: string }) {
  state = useSavedPeople(ownerId);
  return null;
}
const person = (id: number) => ({ id: String(id), kind: 'person', name: `Synthetic ${id}` });
const mount = async (ownerId = 'owner-a') => { await act(async () => { root = create(React.createElement(Probe, { ownerId })); }); };
beforeEach(() => { vi.resetAllMocks(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(async () => { await act(async () => { root?.unmount(); }); delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT; });

it('enumerates 5007 saved people in bounded pages with no duplicates', async () => {
  api.listPrivateThings.mockImplementation(async (_query, _kind, { after, limit }) => {
    expect(limit).toBe(100);
    expect(api.listPrivateThings.mock.lastCall?.[2].summary).toBe(true);
    const offset = Number(after ?? 0), end = Math.min(offset + limit, 5007);
    return { things: Array.from({ length: end - offset }, (_, index) => person(offset + index)), total: 5007, nextCursor: end < 5007 ? String(end) : null };
  });
  await mount();
  await act(async () => { await state.refresh(); });
  expect(state).toMatchObject({ loaded: 5007, total: 5007, complete: true, loading: false, error: '' });
  expect(state.people).toHaveLength(5007);
  expect(new Set(state.people.map(row => row.id)).size).toBe(5007);
  expect(api.listPrivateThings).toHaveBeenCalledTimes(51);
});

it('keeps prior people on an incomplete refresh and resumes the failed cursor before replacing', async () => {
  api.listPrivateThings.mockResolvedValueOnce({ things: [person(1), person(2)], total: 2, nextCursor: null });
  await mount();
  await act(async () => { await state.refresh(); });
  api.listPrivateThings.mockResolvedValueOnce({ things: [person(1), person(3)], total: 3, nextCursor: 'page-2' }).mockRejectedValueOnce(new Error('offline'));
  await act(async () => { await state.refresh(); });
  expect(state.complete).toBe(false);
  expect(state.error).toBeTruthy();
  expect(state.loaded).toBe(2);
  expect(state.people.map(row => row.id).sort()).toEqual(['1', '2', '3']);
  api.listPrivateThings.mockResolvedValueOnce({ things: [person(3), person(4)], total: 3, nextCursor: null });
  await act(async () => { await state.refresh(); });
  expect(api.listPrivateThings).toHaveBeenLastCalledWith('', 'person', { after: 'page-2', limit: 100, summary: true });
  expect(state.people.map(row => row.id).sort()).toEqual(['1', '3', '4']);
  expect(state).toMatchObject({ complete: true, loaded: 3, error: '' });
});

it('hides the previous owner immediately and rejects their in-flight response', async () => {
  let finish!: (page: unknown) => void;
  api.listPrivateThings.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await mount();
  let pending!: Promise<void>;
  await act(async () => { pending = state.refresh(); });
  await act(async () => { root.update(React.createElement(Probe, { ownerId: 'owner-b' })); });
  expect(state.people).toEqual([]);
  api.listPrivateThings.mockResolvedValueOnce({ things: [person(2)], total: 1, nextCursor: null });
  await act(async () => { await state.refresh(); finish({ things: [person(1)], total: 1, nextCursor: null }); await pending; });
  expect(state.people.map(row => row.id)).toEqual(['2']);
  expect(api.listPrivateThings).toHaveBeenLastCalledWith('', 'person', { after: undefined, limit: 100, summary: true });
});

it('stops a repeated cursor without declaring the partial list complete', async () => {
  api.listPrivateThings.mockResolvedValue({ things: [person(1)], total: 2, nextCursor: 'same' });
  await mount();
  await act(async () => { await state.refresh(); });
  expect(api.listPrivateThings).toHaveBeenCalledTimes(2);
  expect(state).toMatchObject({ complete: false, loading: false, loaded: 1 });
  expect(state.error).toBeTruthy();
});

it('cancels a blurred load and resumes without accepting its late response', async () => {
  let finish!: (page: unknown) => void;
  api.listPrivateThings.mockResolvedValueOnce({ things: [person(1)], total: 2, nextCursor: 'last' })
    .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await mount();
  let pending!: Promise<void>;
  await act(async () => { pending = state.refresh(); });
  await act(async () => { state.cancel(); finish({ things: [person(99)], total: 2, nextCursor: null }); await pending; });
  expect(state.complete).toBe(false);
  expect(state.people.map(row => row.id)).toEqual(['1']);
  api.listPrivateThings.mockResolvedValueOnce({ things: [person(2)], total: 2, nextCursor: null });
  await act(async () => { await state.refresh(); });
  expect(api.listPrivateThings).toHaveBeenLastCalledWith('', 'person', { after: 'last', limit: 100, summary: true });
  expect(state.people.map(row => row.id)).toEqual(['1', '2']);
  expect(state.complete).toBe(true);
});

it('renders the complete count with a bounded window of 5007 saved people and reachable final rows', async () => {
  api.listFriends.mockResolvedValue({ friends: [], incoming: [], outgoing: [] });
  api.listPrivateThings.mockImplementation(async (_query, _kind, { after, limit }) => {
    const start = Number(after ?? 0), end = Math.min(start + limit, 5007);
    return { things: Array.from({ length: end - start }, (_, i) => person(start + i)), total: 5007, nextCursor: end < 5007 ? String(end) : null };
  });
  await act(async () => { root = create(React.createElement(FriendsScreen)); });
  const texts = root.root.findAllByType('Text').map(node => node.props.children).flat().join('\n');
  expect(texts).toContain('5007 saved people');
  expect(texts).toContain('Synthetic 0');
  const mountedRows = root.root.findAllByType('TouchableOpacity').filter(node => String(node.props.accessibilityLabel).startsWith('Saved profile for'));
  expect(mountedRows.length).toBeGreaterThan(0);
  expect(mountedRows.length).toBeLessThan(100);
  // Execute the real virtualized list's public row renderer for the final
  // item, rather than eagerly mounting thousands of profiles in this test.
  const { FlatList } = await import('react-native-web');
  const list = root.root.findByType(FlatList);
  const last = list.props.data.at(-1);
  expect(last.id).toBe('5006');
  const rendered = list.props.renderItem({ item: last, index: 5006, separators: {} });
  expect(rendered.props.accessibilityLabel).toBe('Saved profile for Synthetic 5006');
  expect(api.listPrivateThings).toHaveBeenCalledTimes(51);
});


it('restarts from the beginning when an insert before the cursor changes total', async () => {
  const first = Array.from({ length: 100 }, (_, i) => person(i + 1));
  api.listPrivateThings.mockResolvedValueOnce({ things: first, total: 101, nextCursor: 'last' })
    .mockResolvedValueOnce({ things: [person(101)], total: 102, nextCursor: null });
  let finish!: (page: unknown) => void;
  api.listPrivateThings.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await mount();
  let pending!: Promise<void>;
  await act(async () => { pending = state.refresh(); });
  expect(state).toMatchObject({ complete: false, loaded: 101, total: 102 });
  expect(api.listPrivateThings).toHaveBeenLastCalledWith('', 'person', { after: undefined, limit: 100, summary: true });
  await act(async () => { finish({ things: [person(0), ...first, person(101)], total: 102, nextCursor: null }); await pending; });
  expect(state).toMatchObject({ complete: true, loaded: 102, total: 102, error: '' });
  expect(state.people.map(row => row.id)).toContain('0');
});

it('retains known people and retries from start if reconciliation stays inconsistent', async () => {
  api.listPrivateThings.mockResolvedValueOnce({ things: [person(9)], total: 1, nextCursor: null });
  await mount();
  await act(async () => { await state.refresh(); });
  api.listPrivateThings.mockResolvedValue({ things: [person(1)], total: 2, nextCursor: null });
  await act(async () => { await state.refresh(); });
  expect(state).toMatchObject({ complete: false, loading: false, loaded: 1, total: 2 });
  expect(state.error).toBeTruthy();
  expect(state.people.map(row => row.id).sort()).toEqual(['1', '9']);
  api.listPrivateThings.mockResolvedValueOnce({ things: [person(1), person(2)], total: 2, nextCursor: null });
  await act(async () => { await state.refresh(); });
  expect(api.listPrivateThings).toHaveBeenLastCalledWith('', 'person', { after: undefined, limit: 100, summary: true });
  expect(state).toMatchObject({ complete: true, loaded: 2 });
  expect(state.people.map(row => row.id)).toEqual(['1', '2']);
});

it('reconciles a deletion from the beginning before detaching a previously saved row', async () => {
  api.listPrivateThings.mockResolvedValueOnce({ things: [person(1), person(2), person(3)], total: 3, nextCursor: null });
  await mount();
  await act(async () => { await state.refresh(); });
  let finish!: (page: unknown) => void;
  api.listPrivateThings.mockResolvedValueOnce({ things: [person(1), person(2)], total: 3, nextCursor: 'last' })
    .mockResolvedValueOnce({ things: [], total: 2, nextCursor: null })
    .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  let pending!: Promise<void>;
  await act(async () => { pending = state.refresh(); });
  expect(state).toMatchObject({ complete: false, total: 2 });
  expect(state.people.map(row => row.id)).toEqual(['1', '2', '3']);
  expect(api.listPrivateThings).toHaveBeenLastCalledWith('', 'person', { after: undefined, limit: 100, summary: true });
  await act(async () => { finish({ things: [person(1), person(2)], total: 2, nextCursor: null }); await pending; });
  expect(state).toMatchObject({ complete: true, total: 2, loaded: 2, error: '' });
  expect(state.people.map(row => row.id)).toEqual(['1', '2']);
});
