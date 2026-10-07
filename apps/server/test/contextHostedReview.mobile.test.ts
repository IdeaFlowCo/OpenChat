import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ preferences: vi.fn(), setPreferences: vi.fn(), requests: vi.fn(), detail: vi.fn(), revise: vi.fn(), publish: vi.fn(), decline: vi.fn(), cancel: vi.fn(), user: 'alice', platform: 'ios' }));
vi.mock('react-native', () => ({
  Platform: { get OS() { return mocks.platform; } },
  StyleSheet: { create: (value: any) => value, hairlineWidth: 1 }, AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
  View: 'View', Text: 'Text', TouchableOpacity: 'TouchableOpacity', TextInput: 'TextInput', ActivityIndicator: 'ActivityIndicator',
  FlatList: ({ data, renderItem, ListEmptyComponent, ListHeaderComponent }: any) => React.createElement('List', {}, ListHeaderComponent, data.length ? data.map((item: any) => React.createElement(React.Fragment, { key: item.id }, renderItem({ item }))) : ListEmptyComponent),
}));
vi.mock('@react-navigation/native', () => ({ useFocusEffect: (fn: any) => React.useEffect(fn, [fn]) }));
vi.mock('../../mobile/src/contexts/ThemeContext', () => ({ useTheme: () => ({ scheme: 'light' }) }));
vi.mock('../../mobile/src/contexts/ChatContext', () => ({ useChat: () => ({ currentUser: { userId: mocks.user } }) }));
vi.mock('../../mobile/src/api/client', () => ({ api: {
  getHostedContextPreferences: mocks.preferences, setHostedContextPreferences: mocks.setPreferences, getHostedContextRequests: mocks.requests,
  getHostedContextRequest: mocks.detail, reviseHostedContextRequest: mocks.revise, publishHostedContextRequest: mocks.publish,
  declineHostedContextRequest: mocks.decline, cancelHostedContextRequest: mocks.cancel,
} }));
import { ContextReviewScreen } from '../../mobile/src/screens/ContextReviewScreen';
import type { HostedContextRequest } from '../../mobile/src/types/contextHosted';
const request = (extra: Partial<HostedContextRequest> = {}): HostedContextRequest => ({
  id: 'request-a', conversationId: 'room', conversationTitle: 'Harrison and Jacob', postId: 'question', sourceRevision: 4, status: 'review',
  source: { text: 'Could you help with the launch?', author: { id: 'harrison', name: 'Harrison' } },
  audience: [{ id: 'alice', name: 'Jacob' }, { id: 'harrison', name: 'Harrison' }], expiresAt: '2099-01-01T00:00:00Z',
  privateInputIncluded: true, privateText: 'Private source for Alice', privateInputSummary: 'Private text supplied for this request',
  draft: { id: 'draft-a', text: 'I can help with the launch on Friday.', approvalDigest: 'digest-a', createdAt: '2026-10-07T00:00:00Z' }, ...extra,
});
const deferred = () => { let resolve!: (value: any) => void; const promise = new Promise<any>(done => { resolve = done; }); return { promise, resolve }; };
let tree: ReactTestRenderer;
const findButton = (label: string) => tree.root.findAllByType('TouchableOpacity' as any).find(node => node.props.accessibilityLabel === label || node.findAllByType('Text' as any).some(text => text.children.join('') === label));
const press = async (label: string) => { const button = findButton(label)!; expect(button).toBeTruthy(); expect(button.props.disabled).not.toBe(true); await act(async () => button.props.onPress()); };
const rendered = () => JSON.stringify(tree.toJSON());
const mount = async () => { await act(async () => { tree = create(React.createElement(ContextReviewScreen)); }); };
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  for (const value of Object.values(mocks)) if (typeof value === 'function') value.mockReset();
  mocks.user = 'alice'; mocks.platform = 'ios'; mocks.preferences.mockResolvedValue({ enabled: true, available: true }); mocks.requests.mockResolvedValue({ requests: [request()] });
  mocks.publish.mockResolvedValue(request({ status: 'published', draft: undefined, privateText: undefined }));
  mocks.decline.mockResolvedValue(request({ status: 'declined', draft: undefined, privateText: undefined }));
  mocks.cancel.mockResolvedValue(request({ status: 'cancelled', draft: undefined, privateText: undefined }));
});
afterEach(async () => { if (tree) await act(async () => tree.unmount()); delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT; });
it('keeps hosted operation off until explicit enable and does not repeatedly fetch after render', async () => {
  mocks.preferences.mockResolvedValue({ enabled: false, available: true }); mocks.requests.mockResolvedValue({ requests: [] });
  mocks.setPreferences.mockResolvedValue({ enabled: true, available: true }); await mount();
  expect(mocks.setPreferences).not.toHaveBeenCalled(); expect(mocks.requests).toHaveBeenCalledTimes(1);
  await press('Hosted Context agent'); expect(mocks.setPreferences).toHaveBeenCalledWith(true);
  expect(mocks.publish).not.toHaveBeenCalled(); expect(rendered()).toContain('Ask agents on a Context post');
});
it('shows exact reply, destination, audience and private provenance before explicit publish', async () => {
  await mount(); for (const text of ['Harrison and Jacob', 'Current audience', 'Harrison', 'revision ', 'Private source for Alice', 'I can help with the launch on Friday.']) expect(rendered()).toContain(text);
  expect(mocks.publish).not.toHaveBeenCalled(); await press('Publish to Context');
  expect(mocks.publish).toHaveBeenCalledWith('request-a', { draftId: 'draft-a', approvalDigest: 'digest-a', text: 'I can help with the launch on Friday.' });
  expect(findButton('Publish to Context')).toBeUndefined(); expect(rendered()).toContain('No chat message or notification');
});
it('editing removes Publish until an immutable revised draft is saved and reviewed again', async () => {
  mocks.revise.mockResolvedValue(request({ draft: { id: 'draft-b', text: 'Edited reply', approvalDigest: 'digest-b', createdAt: '2026-10-07T00:00:00Z' } }));
  await mount(); await press('Edit reply');
  await act(async () => tree.root.findByProps({ accessibilityLabel: 'Edit proposed Context reply' }).props.onChangeText('Edited reply'));
  expect(findButton('Publish to Context')).toBeUndefined(); await press('Save for review');
  expect(mocks.revise).toHaveBeenCalledWith('request-a', { text: 'Edited reply' }); expect(mocks.publish).not.toHaveBeenCalled();
  await press('Publish to Context'); expect(mocks.publish).toHaveBeenCalledWith('request-a', { draftId: 'draft-b', approvalDigest: 'digest-b', text: 'Edited reply' });
});
it('preserves a failed edit and blocks stale approval until explicit reload', async () => {
  mocks.revise.mockRejectedValue(Object.assign(new Error('Audience changed; review again'), { status: 409 }));
  mocks.detail.mockResolvedValue(request({ status: 'unavailable', draft: undefined, privateText: undefined }));
  await mount(); await press('Edit reply');
  await act(async () => tree.root.findByProps({ accessibilityLabel: 'Edit proposed Context reply' }).props.onChangeText('Keep my draft'));
  await press('Save for review'); expect(tree.root.findByProps({ accessibilityLabel: 'Edit proposed Context reply' }).props.value).toBe('Keep my draft');
  expect(findButton('Save for review')!.props.disabled).toBe(true); expect(mocks.publish).not.toHaveBeenCalled();
  await press('Reload review'); expect(findButton('Publish to Context')).toBeUndefined(); expect(rendered()).toContain('Use Ask agents again');
});
it('permission loss clears sensitive previews and cannot silently retry publication', async () => {
  mocks.publish.mockRejectedValue(Object.assign(new Error('Permission changed'), { status: 403 })); await mount(); await press('Publish to Context');
  expect(rendered()).not.toContain('Private source for Alice'); expect(rendered()).not.toContain('I can help with the launch on Friday.');
  expect(findButton('Publish to Context')).toBeUndefined(); expect(mocks.publish).toHaveBeenCalledTimes(1); expect(findButton('Reload review')).toBeTruthy();
});
it('private input requires explicit generation and never triggers publication', async () => {
  mocks.revise.mockResolvedValue(request({ status: 'queued', draft: undefined, privateText: 'Only Friday is free' }));
  await mount(); await press('Add private context'); expect(rendered()).toContain('sent to Anthropic');
  await act(async () => tree.root.findByProps({ accessibilityLabel: 'Private context for this request' }).props.onChangeText('Only Friday is free'));
  expect(findButton('Publish to Context')).toBeUndefined(); await press('Prepare private draft');
  expect(mocks.revise).toHaveBeenCalledWith('request-a', { privateText: 'Only Friday is free' }); expect(mocks.publish).not.toHaveBeenCalled();
});
it('account switches immediately unmount private previews and discard old async reads', async () => {
  const old = deferred(); mocks.requests.mockReturnValueOnce(old.promise); await mount();
  mocks.user = 'bob'; mocks.requests.mockResolvedValue({ requests: [] }); await act(async () => tree.update(React.createElement(ContextReviewScreen)));
  await act(async () => old.resolve({ requests: [request()] })); expect(rendered()).not.toContain('Private source for Alice');
  expect(rendered()).not.toContain('Harrison and Jacob'); expect(findButton('Publish to Context')).toBeUndefined();
});
it('turning the hosted agent off clears unpublished drafts after server confirmation', async () => {
  mocks.setPreferences.mockResolvedValue({ enabled: false, available: true }); await mount(); await press('Hosted Context agent');
  expect(mocks.setPreferences).toHaveBeenCalledWith(false); expect(rendered()).not.toContain('Private source for Alice'); expect(rendered()).toContain('were cancelled');
});
it('network failure keeps the exact reviewed draft available for an explicit retry', async () => {
  mocks.publish.mockRejectedValueOnce(new Error('Network unavailable')).mockResolvedValueOnce(request({ status: 'published', draft: undefined }));
  await mount(); await press('Publish to Context'); expect(mocks.publish).toHaveBeenCalledTimes(1);
  await press('Publish to Context'); expect(mocks.publish.mock.calls[0]).toEqual(mocks.publish.mock.calls[1]);
});

it('discarding private input queues a fresh draft without publishing or retaining the source', async () => {
  mocks.revise.mockResolvedValue(request({ status: 'queued', draft: undefined, privateText: undefined, privateInputIncluded: false }));
  await mount(); await press('Regenerate without private text');
  expect(mocks.revise).toHaveBeenCalledWith('request-a', { privateText: '' });
  expect(rendered()).not.toContain('Private source for Alice'); expect(mocks.publish).not.toHaveBeenCalled();
});
it('account changes remove visible drafts while ignoring an old in-flight publication response', async () => {
  const old = deferred(); mocks.publish.mockReturnValueOnce(old.promise); await mount();
  expect(rendered()).toContain('Private source for Alice');
  await press('Publish to Context'); mocks.user = 'bob';
  const newInbox = deferred(); mocks.requests.mockReturnValueOnce(newInbox.promise);
  await act(async () => tree.update(React.createElement(ContextReviewScreen)));
  expect(rendered()).not.toContain('Private source for Alice'); expect(rendered()).not.toContain('Harrison and Jacob');
  await act(async () => old.resolve(request({ status: 'published' })));
  expect(rendered()).not.toContain('Published the reviewed reply'); expect(rendered()).not.toContain('Harrison and Jacob');
  await act(async () => newInbox.resolve({ requests: [] }));
});
it('declining and cancelling keep generated output private', async () => {
  await mount(); await press('Decline draft'); expect(mocks.decline).toHaveBeenCalledWith('request-a');
  expect(rendered()).toContain('Draft declined'); expect(mocks.publish).not.toHaveBeenCalled();
  mocks.requests.mockResolvedValue({ requests: [request({ status: 'processing', draft: undefined })] });
  await press('Refresh'); await press('Cancel request');
  expect(mocks.cancel).toHaveBeenCalledWith('request-a'); expect(rendered()).toContain('Request cancelled'); expect(mocks.publish).not.toHaveBeenCalled();
});

it('permission loss clears locally typed private input even before any draft exists', async () => {
  mocks.requests.mockResolvedValue({ requests: [request({ status: 'processing', draft: undefined, privateInputIncluded: false, privateText: undefined })] });
  mocks.revise.mockRejectedValue(Object.assign(new Error('Access removed'), { status: 403 }));
  await mount(); await press('Add private context');
  await act(async () => tree.root.findByProps({ accessibilityLabel: 'Private context for this request' }).props.onChangeText('Unsubmitted private secret'));
  await press('Prepare private draft');
  expect(rendered()).not.toContain('Unsubmitted private secret');
  expect(tree.root.findAllByProps({ accessibilityLabel: 'Private context for this request' })).toHaveLength(0);
});
it('an expired draft cannot be published while awaiting a refresh', async () => {
  mocks.requests.mockResolvedValue({ requests: [request({ expiresAt: '2000-01-01T00:00:00Z' })] });
  await mount(); expect(findButton('Publish to Context')?.props.disabled).toBe(true); expect(mocks.publish).not.toHaveBeenCalled();
});

it('web exposes on and off switch states while native retains its existing accessibility state', async () => {
  mocks.platform = 'web'; mocks.preferences.mockResolvedValue({ enabled: false, available: true });
  mocks.setPreferences.mockResolvedValue({ enabled: true, available: true }); await mount();
  expect(findButton('Hosted Context agent')!.props['aria-checked']).toBe(false);
  await press('Hosted Context agent'); expect(findButton('Hosted Context agent')!.props['aria-checked']).toBe(true);
  mocks.platform = 'ios'; await act(async () => tree.update(React.createElement(ContextReviewScreen)));
  expect(findButton('Hosted Context agent')!.props['aria-checked']).toBeUndefined();
  expect(findButton('Hosted Context agent')!.props.accessibilityState.checked).toBe(true);
});
