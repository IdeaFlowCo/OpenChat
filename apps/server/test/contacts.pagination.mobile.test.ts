import React from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ listPrivateThings: vi.fn(), listFriends: vi.fn() }));
vi.mock('../../mobile/src/api/client', () => ({ api }));
vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  ActivityIndicator: 'ActivityIndicator', ScrollView: 'ScrollView', Text: 'Text', TextInput: 'TextInput', TouchableOpacity: 'TouchableOpacity', View: 'View',
}));
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
  expect(api.listPrivateThings).toHaveBeenLastCalledWith('', 'person', { after: 'page-2', limit: 100 });
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
  expect(api.listPrivateThings).toHaveBeenLastCalledWith('', 'person', { after: 'last', limit: 100 });
  expect(state.people.map(row => row.id)).toEqual(['1', '2']);
  expect(state.complete).toBe(true);
});

it('renders the complete saved-person count and the final page on the People screen', async () => {
  api.listFriends.mockResolvedValue({ friends: [], incoming: [], outgoing: [] });
  api.listPrivateThings.mockImplementation(async (_query, _kind, { after }) => after
    ? { things: [person(101)], total: 101, nextCursor: null }
    : { things: Array.from({ length: 100 }, (_, index) => person(index + 1)), total: 101, nextCursor: 'last' });
  await act(async () => { root = create(React.createElement(FriendsScreen)); });
  const texts = root.root.findAllByType('Text').map(node => node.props.children).flat().join('\n');
  expect(texts).toContain('101 saved people');
  expect(texts).toContain('Synthetic 101');
  expect(api.listPrivateThings).toHaveBeenCalledTimes(2);
});
