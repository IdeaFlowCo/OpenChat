import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ detail: vi.fn(), list: vi.fn(), track: vi.fn(), update: vi.fn(), user: 'alice', change: vi.fn() }));
vi.mock('react-native', () => ({ Text: 'Text', View: 'View', TouchableOpacity: 'TouchableOpacity' }));
vi.mock('../../mobile/src/contexts/ThemeContext', () => ({ useTheme: () => ({ scheme: 'light' }) }));
vi.mock('../../mobile/src/contexts/ChatContext', () => ({ useChat: () => ({ currentUser: { userId: mocks.user } }) }));
vi.mock('../../mobile/src/api/client', () => ({ api: { getContextIntention: mocks.detail, getContextIntentions: mocks.list, trackContextIntention: mocks.track, updateContextIntention: mocks.update } }));
import { ContextIntentionControls, IntentionLifecycleControls } from '../../mobile/src/components/ContextIntentionControls';
const intent = { intentId: 'same-intent', revision: 4, lifecycleState: 'open', searchStatus: 'paused', kind: 'ask', goal: 'Owner private intention', seeks: [], brings: [], contextPosts: [{ postId: 'p1' }, { postId: 'p2' }], stories: [{ id: 's1' }] };
const post: any = { id: 'post', revision: 7, authorId: 'alice', kind: 'ask', text: 'Already shared ask' };
let tree: ReactTestRenderer;
const rendered = () => JSON.stringify(tree.toJSON());
const button = (label: string) => tree.root.findAllByType('TouchableOpacity' as any).find(node => node.props.accessibilityLabel === label)!;
const press = async (label: string) => { await act(async () => button(label).props.onPress()); };
beforeEach(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; vi.clearAllMocks(); mocks.user = 'alice'; mocks.list.mockResolvedValue({ intentions: [intent] }); mocks.detail.mockResolvedValue({ intention: intent }); mocks.track.mockResolvedValue({ intention: intent }); mocks.update.mockResolvedValue({ intention: intent }); });
afterEach(async () => { if (tree) await act(async () => tree.unmount()); });
it('tracking requires an explicit owner action and retries with the same identity', async () => {
  mocks.track.mockRejectedValueOnce(new Error('Network lost'));
  await act(async () => { tree = create(React.createElement(ContextIntentionControls, { post, conversationId: 'room', onChange: mocks.change })); });
  expect(mocks.track).not.toHaveBeenCalled(); await press('Track ask'); await press('Track ask');
  expect(mocks.track.mock.calls[0]).toEqual(mocks.track.mock.calls[1]); expect(mocks.track.mock.calls[0][2]).toMatchObject({ sourceRevision: 7 });
});
it('linking previews an owned intention and submits only its existing identity, never private details', async () => {
  await act(async () => { tree = create(React.createElement(ContextIntentionControls, { post, conversationId: 'room', onChange: mocks.change })); });
  await press('Link existing intention'); await press('Ask: Owner private intention'); expect(mocks.track).not.toHaveBeenCalled();
  expect(rendered()).toContain('does not copy its private details'); await press('Confirm intention link');
  expect(mocks.track).toHaveBeenCalledWith('room', 'post', { intentId: 'same-intent', sourceRevision: 7, clientRequestId: expect.any(String) });
});
it('other participants can see lifecycle state but cannot link or manage another owner’s intention', async () => {
  mocks.user = 'bob'; await act(async () => { tree = create(React.createElement(ContextIntentionControls, { post: { ...post, intention: { intentId: 'same-intent', revision: 4, lifecycleState: 'fulfilled' } }, conversationId: 'room', onChange: mocks.change })); });
  expect(rendered()).toContain('fulfilled'); expect(tree.root.findAllByType('TouchableOpacity' as any)).toHaveLength(0); expect(mocks.list).not.toHaveBeenCalled();
});
it('fulfillment reviews all linked projections and confirms the current revision without enabling search', async () => {
  await act(async () => { tree = create(React.createElement(IntentionLifecycleControls, { intention: intent as any, onChange: mocks.change })); });
  await press('Mark fulfilled'); expect(mocks.update).not.toHaveBeenCalled(); expect(rendered()).toContain('withdraws linked Stories');
  await press('Confirm intention change'); expect(mocks.update).toHaveBeenCalledWith('same-intent', { expectedRevision: 4, lifecycleState: 'fulfilled' });
});
it('stale lifecycle approval requires another explicit review and reopen does not promise resumed search', async () => {
  mocks.detail.mockResolvedValue({ intention: { ...intent, lifecycleState: 'fulfilled' } }); mocks.update.mockRejectedValue(Object.assign(new Error('Intention changed; reload'), { status: 409 }));
  await act(async () => { tree = create(React.createElement(IntentionLifecycleControls, { intention: { ...intent, lifecycleState: 'fulfilled' } as any, onChange: mocks.change })); });
  await press('Reopen intention'); expect(rendered()).toContain('Matching stays paused'); await press('Confirm intention change');
  expect(button('Confirm intention change')).toBeUndefined(); expect(rendered()).toContain('Intention changed'); expect(mocks.update).toHaveBeenCalledTimes(1);
});

it('reviews the selected older intention directly even when absent from the latest inventory', async () => {
  mocks.list.mockResolvedValue({ intentions: [] });
  mocks.detail.mockResolvedValue({ intention: { ...intent, revision: 9 } });
  await act(async () => { tree = create(React.createElement(IntentionLifecycleControls, { intention: intent as any, onChange: mocks.change })); });
  await press('Mark fulfilled');
  expect(mocks.list).not.toHaveBeenCalled(); expect(mocks.detail).toHaveBeenCalledWith('same-intent');
  await press('Confirm intention change');
  expect(mocks.update).toHaveBeenCalledWith('same-intent', { expectedRevision: 9, lifecycleState: 'fulfilled' });
});
it('does not offer confirmation when the selected intention is no longer owned or available', async () => {
  mocks.detail.mockRejectedValue(Object.assign(new Error('Intention not found'), { status: 404 }));
  await act(async () => { tree = create(React.createElement(IntentionLifecycleControls, { intention: intent as any, onChange: mocks.change })); });
  await press('Mark fulfilled'); expect(button('Confirm intention change')).toBeUndefined();
  expect(rendered()).toContain('Intention not found'); expect(mocks.update).not.toHaveBeenCalled();
});
