import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn(), edit: vi.fn(), remove: vi.fn(), ask: vi.fn(), report: vi.fn() }));
vi.mock('react-native', () => ({
  Platform: { select: () => ({}) }, StyleSheet: { create: (s: any) => s, hairlineWidth: 1 },
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
  View: 'View', Text: 'Text', TouchableOpacity: 'TouchableOpacity', TextInput: 'TextInput', ActivityIndicator: 'ActivityIndicator',
  FlatList: ({ data, renderItem, ListEmptyComponent, ListFooterComponent }: any) => React.createElement('List', {}, data.length ? data.map((item: any) => React.createElement(React.Fragment, { key: item.post.id }, renderItem({ item }))) : ListEmptyComponent, ListFooterComponent),
}));
vi.mock('@react-navigation/native', () => ({ useFocusEffect: (fn: any) => React.useEffect(fn, [fn]) }));
vi.mock('../../mobile/src/contexts/ThemeContext', () => ({ useTheme: () => ({ scheme: 'light' }) }));
vi.mock('../../mobile/src/contexts/ChatContext', () => ({ useChat: () => ({ currentUser: { userId: 'me' } }) }));
vi.mock('../../mobile/src/services/clientLogger', () => ({ logError: vi.fn() }));
vi.mock('../../mobile/src/api/client', () => ({ api: { listContextPosts: mocks.list, createContextPost: mocks.create, updateContextPost: mocks.edit, deleteContextPost: mocks.remove, askContextAgents: mocks.ask, reportContextPost: mocks.report } }));
import { ContextLane, contextThreads } from '../../mobile/src/components/ContextLane';
import { ContextComposer } from '../../mobile/src/components/ContextComposer';
import { ContextLaneManager, contextLaneManager } from '../../mobile/src/services/contextLane';
const post = (id: string, extra = {}) => ({ id, conversationId: 'room', text: id, authorId: 'me', author: { id: 'me', name: 'Jacob' }, kind: 'note', lane: 'context' as const, revision: 1, createdAt: '2026-10-07T00:00:00Z', updatedAt: '2026-10-07T00:00:00Z', clientRequestId: id, ...extra });
const deferred = () => { let resolve!: (value: any) => void; const promise = new Promise<any>(r => { resolve = r; }); return { promise, resolve }; };
let tree: ReactTestRenderer | undefined;
beforeEach(() => { Object.values(mocks).forEach(m => m.mockReset()); mocks.list.mockResolvedValue({ posts: [] }); contextLaneManager.clearAll(); });
afterEach(async () => { if (tree) await act(async () => tree!.unmount()); tree = undefined; });
const button = (label: string) => tree!.root.findAllByType('TouchableOpacity' as any).find(n => n.findAllByType('Text' as any).some(t => t.children.join('') === label))!;

it('discards reads and mutations from a previous account, even for the same conversation', async () => {
  const manager = new ContextLaneManager(); manager.setAccount('first');
  const read = deferred(), write = deferred(); mocks.list.mockReturnValueOnce(read.promise); mocks.create.mockReturnValueOnce(write.promise);
  const loading = manager.loadInitial('room'), writing = manager.addPost('room', 'secret', 'retry');
  manager.setAccount('second'); read.resolve({ posts: [post('private')] }); write.resolve(post('private-write'));
  await Promise.all([loading, writing]); expect(manager.getState('room').posts).toEqual([]);
});
it('keeps search responses isolated and deduplicates retry results without stale refresh erasing posts', async () => {
  const manager = new ContextLaneManager(); const first = deferred(); mocks.list.mockReturnValueOnce(first.promise).mockResolvedValueOnce({ posts: [post('found')] });
  const stale = manager.loadInitial('room'); await manager.loadInitial('room', 'found'); first.resolve({ posts: [post('wrong')] }); await stale;
  expect(manager.getState('room').posts.map(p => p.id)).toEqual(['found']);
  await manager.loadInitial('room', ''); const refresh = deferred(); mocks.list.mockReturnValueOnce(refresh.promise); const reading = manager.loadInitial('room');
  mocks.create.mockResolvedValue(post('new')); await manager.addPost('room', 'new', 'same'); await manager.addPost('room', 'new', 'same'); refresh.resolve({ posts: [] }); await reading;
  expect(manager.getState('room').posts.map(p => p.id)).toEqual(['new']); expect(manager.getState('room').isLoading).toBe(false);
});
it('preserves loaded posts on network failure, but clears them when membership is denied', async () => {
  const manager = new ContextLaneManager(); mocks.list.mockResolvedValueOnce({ posts: [post('one')] }); await manager.loadInitial('room');
  mocks.list.mockRejectedValueOnce(new Error('offline')); await manager.loadInitial('room'); expect(manager.getState('room').posts).toHaveLength(1);
  mocks.list.mockRejectedValueOnce(Object.assign(new Error('forbidden'), { status: 403 })); await manager.loadInitial('room'); expect(manager.getState('room').posts).toHaveLength(0);
});
it('groups nested replies beneath their loaded root and retains orphan threads', () => {
  const rows = contextThreads([post('third', { replyToId: 'second' }), post('second', { replyToId: 'first' }), post('first'), post('orphan', { replyToId: 'older' })]);
  expect(rows.map(r => r.post.id)).toEqual(['first', 'third', 'second', 'orphan']); expect(rows.map(r => r.reply)).toEqual([false, true, true, true]);
});
it('shows agent attribution, sends a threaded reply, and preserves a conflicting edit draft', async () => {
  mocks.list.mockResolvedValue({ posts: [post('root', { agent: { id: 'agent', name: 'Hermes' }, kind: 'ask' })] });
  mocks.create.mockResolvedValue(post('reply', { replyToId: 'root' }));
  await act(async () => { tree = create(React.createElement(ContextLane, { conversationId: 'room' })); });
  expect(JSON.stringify(tree!.toJSON())).toContain('Hermes');
  await act(async () => button('Reply').props.onPress());
  await act(async () => tree!.root.findByProps({ accessibilityLabel: 'Reply in context' }).props.onChangeText('Following up'));
  const reply = tree!.root.findByProps({ accessibilityLabel: 'Post to context' });
  await act(async () => reply.props.onPress()); expect(mocks.create).toHaveBeenCalledWith('room', 'Following up', expect.any(String), 'note', 'root');
  await act(async () => tree!.unmount());
  mocks.edit.mockRejectedValue(Object.assign(new Error('conflict'), { status: 409 }));
  await act(async () => { tree = create(React.createElement(ContextComposer, { conversationId: 'room', editing: post('root') })); });
  await act(async () => tree!.root.findByType('TextInput' as any).props.onChangeText('My edit'));
  await act(async () => button('Save').props.onPress()); expect(tree!.root.findByType('TextInput' as any).props.value).toBe('My edit');
  expect(tree!.root.findByProps({ accessibilityRole: 'alert' }).children.join('')).toContain('This post changed');
});
it('queues agent help only from an explicit Ask agents action', async () => {
  mocks.list.mockResolvedValue({ posts: [post('question', { kind: 'ask' })] }); mocks.ask.mockResolvedValue({ queued: 2, available: 2 });
  await act(async () => { tree = create(React.createElement(ContextLane, { conversationId: 'room' })); });
  expect(mocks.ask).not.toHaveBeenCalled(); await act(async () => button('Ask agents').props.onPress());
  expect(mocks.ask).toHaveBeenCalledWith('room', 'question'); expect(JSON.stringify(tree!.toJSON())).toContain('Requested help from 2 agents');
});
