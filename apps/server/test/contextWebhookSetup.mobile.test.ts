import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ list: vi.fn(), keys: vi.fn(), rooms: vi.fn(), preferences: vi.fn(), create: vi.fn(), remove: vi.fn(), copy: vi.fn() }));
vi.mock('react-native', () => ({ StyleSheet: { create: (x: any) => x, hairlineWidth: 1 }, Clipboard: { setString: mocks.copy }, View: 'View', Text: 'Text', TextInput: 'TextInput', TouchableOpacity: 'TouchableOpacity' }));
vi.mock('../../mobile/src/contexts/ThemeContext', () => ({ useTheme: () => ({ scheme: 'light' }) }));
vi.mock('../../mobile/src/api/client', () => ({ api: { getContextWebhooks: mocks.list, listAgentKeys: mocks.keys, getConversations: mocks.rooms, getContextAgentPreferences: mocks.preferences, createContextWebhook: mocks.create, deleteContextWebhook: mocks.remove } }));
import { ContextWebhookSetup } from '../../mobile/src/components/ContextWebhookSetup';
let tree: ReactTestRenderer;
const button = (label: string) => tree.root.findAllByType('TouchableOpacity' as any).find(node => node.props.accessibilityLabel === label)!;
const press = async (label: string) => { expect(button(label)).toBeTruthy(); expect(button(label).props.disabled).not.toBe(true); await act(async () => button(label).props.onPress()); };
const text = () => JSON.stringify(tree.toJSON());
const endpoint = async (url = 'https://receiver.example/') => { await act(async () => tree.root.findByType('TextInput' as any).props.onChangeText(url)); };
const select = async () => { await press('Set up webhooks'); await press('Hermes'); await press('Test room'); await endpoint(); };
const saved = (extra = {}) => ({ id: 'sub', url: 'https://receiver.example/', agentKeyId: 'key', conversationId: 'room', enabled: true, routingStatus: 'ready', ...extra });
const disable = 'Disable receiver for Hermes in Test room';
const deferred = () => { let resolve!: (value: any) => void; const promise = new Promise<any>(done => { resolve = done; }); return { promise, resolve }; };
beforeEach(async () => {
 (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; Object.values(mocks).forEach(fn => fn.mockReset());
 mocks.list.mockResolvedValue({ available: true, subscriptions: [] });
 mocks.keys.mockResolvedValue([{ id: 'key', name: 'Hermes', scopes: ['read', 'write'] }, { id: 'other', name: 'Other agent', scopes: ['read', 'write'] }]);
 mocks.rooms.mockResolvedValue([{ id: 'room', title: 'Test room' }, { id: 'other-room', title: 'Other room' }]);
 mocks.preferences.mockResolvedValue({ enabled: true }); mocks.create.mockResolvedValue({ subscription: saved(), secret: 'fixture-secret' }); mocks.remove.mockImplementation(async () => { mocks.list.mockResolvedValue({ available: true, subscriptions: [] }); return { deleted: true }; });
 await act(async () => { tree = create(React.createElement(ContextWebhookSetup, { hostedEnabled: false })); });
});
afterEach(async () => { await act(async () => tree.unmount()); delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT; });
it('shows the exact receiver, chat and endpoint before separate consent and saves that same key', async () => {
 expect(mocks.list).not.toHaveBeenCalled(); await select();
 for (const value of ['Hermes', 'Test room', 'https://receiver.example/', 'as my external Context receiver in', 'does not replay existing requests']) expect(text()).toContain(value);
 expect(button('Save receiving agent').props.disabled).toBe(true); expect(mocks.create).not.toHaveBeenCalled();
 await press('Approve this receiver and endpoint'); await press('Save receiving agent');
 expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://receiver.example/', agentKeyId: 'key', conversationId: 'room', consent: true }));
 expect(text()).toContain('Ready for future eligible requests');
 await press('Copy signing secret'); expect(mocks.copy).toHaveBeenCalledWith('fixture-secret');
 await press(disable); expect(mocks.remove).toHaveBeenCalledWith('sub'); expect(text()).not.toContain('fixture-secret');
});
it('invalidates approval when the key, chat, endpoint or refreshed eligibility changes', async () => {
 await select();
 for (const change of [() => press('Other agent'), () => press('Other room'), () => endpoint('https://different.example/')]) {
  await press('Approve this receiver and endpoint'); await change(); expect(button('Save receiving agent').props.disabled).toBe(true);
 }
 await press('Approve this receiver and endpoint'); mocks.preferences.mockResolvedValue({ enabled: false }); await press('Refresh webhook setup');
 expect(button('Save receiving agent').props.disabled).toBe(true); expect(button('Approve this receiver and endpoint').props.disabled).toBe(true); expect(mocks.create).not.toHaveBeenCalled();
});
it('blocks silent replacement in the same chat but permits a different chat after explicit consent', async () => {
 mocks.list.mockResolvedValue({ available: true, subscriptions: [saved()] }); await select(); await press('Other agent');
 expect(text()).toContain('Disable it above before choosing another'); expect(button('Approve this receiver and endpoint').props.disabled).toBe(true); expect(mocks.create).not.toHaveBeenCalled();
 await press('Other room'); await press('Approve this receiver and endpoint'); await press('Save receiving agent');
 expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ agentKeyId: 'other', conversationId: 'other-room' })); expect(mocks.remove).not.toHaveBeenCalled();
});
it('hosted precedence says waiting and refreshes authoritative status after the hosted setting changes', async () => {
 mocks.create.mockResolvedValue({ subscription: saved({ routingStatus: 'hosted_precedence' }), secret: 'fixture-secret' });
 await act(async () => tree.update(React.createElement(ContextWebhookSetup, { hostedEnabled: true })));
 await select(); await press('Approve this receiver and endpoint'); await press('Save receiving agent');
 expect(text()).toContain('this receiver waits while your hosted agent is on'); expect(text()).not.toContain('Ready for future eligible requests');
 mocks.list.mockResolvedValue({ available: true, subscriptions: [saved()] });
 await act(async () => tree.update(React.createElement(ContextWebhookSetup, { hostedEnabled: false })));
 expect(mocks.list).toHaveBeenCalledTimes(2); expect(text()).toContain('Ready for future eligible requests'); expect(text()).not.toContain('this receiver waits'); expect(mocks.create).toHaveBeenCalledTimes(1);
});
it('a hosted toggle invalidates unsaved approval without creating a receiver', async () => {
 await select(); await press('Approve this receiver and endpoint');
 await act(async () => tree.update(React.createElement(ContextWebhookSetup, { hostedEnabled: true })));
 expect(button('Save receiving agent').props.disabled).toBe(true); expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.list).toHaveBeenCalledTimes(2);
});
it('keeps a saved ineligible key visible without silently selecting another eligible key', async () => {
 mocks.keys.mockResolvedValue([{ id: 'key', name: 'Hermes', revokedAt: '2026-10-07', scopes: ['read', 'write'] }, { id: 'other', name: 'Other agent', scopes: ['read', 'write'] }]);
 mocks.list.mockResolvedValue({ available: true, subscriptions: [saved({ routingStatus: 'key_ineligible' })] }); await press('Set up webhooks');
 expect(text()).toContain('Hermes'); expect(text()).toContain('Suspended. This key is no longer eligible'); expect(text()).toContain('No other key is selected automatically');
 expect(button('Hermes')).toBeUndefined(); expect(button('Other agent')).toBeTruthy(); expect(text()).not.toContain('Selected · Other agent'); expect(mocks.create).not.toHaveBeenCalled();
});
it('a preference failure does not hide saved cards or other eligible keys', async () => {
 mocks.list.mockResolvedValue({ available: true, subscriptions: [saved({ routingStatus: 'key_ineligible' })] });
 mocks.preferences.mockImplementation(async id => { if (id === 'key') throw Object.assign(new Error('Key gone'), { status: 404 }); return { enabled: true }; });
 await press('Set up webhooks'); expect(button(disable)).toBeTruthy(); expect(button('Other agent')).toBeTruthy(); expect(text()).toContain('Some keys could not be checked');
});
it('shows conflicts and inaccessible conversations without promising delivery or choosing another key', async () => {
 mocks.list.mockResolvedValue({ available: true, subscriptions: [saved({ routingStatus: 'conflict' }), saved({ id: 'sub2', agentKeyId: 'other', conversationId: 'lost-room', routingStatus: 'conversation_unavailable' })] });
 await press('Set up webhooks'); expect(text()).toContain('More than one receiver is saved'); expect(text()).toContain('You no longer have access'); expect(text()).toContain('Conversation unavailable'); expect(mocks.create).not.toHaveBeenCalled();
});
it('shows a server-disabled saved state and prevents approval', async () => {
 mocks.list.mockResolvedValue({ available: false, subscriptions: [saved({ routingStatus: 'server_disabled' })] }); await select();
 expect(text()).toContain('Webhook delivery is disabled on this server'); expect(button('Approve this receiver and endpoint').props.disabled).toBe(true); expect(mocks.create).not.toHaveBeenCalled();
});
it('preserves the retry identity after a network failure without automatically submitting twice', async () => {
 mocks.create.mockRejectedValueOnce(new Error('Connection lost')); await select(); await press('Approve this receiver and endpoint'); await press('Save receiving agent');
 expect(mocks.create).toHaveBeenCalledTimes(1); expect(text()).toContain('Connection lost');
 await press('Save receiving agent'); expect(mocks.create.mock.calls[1]).toEqual(mocks.create.mock.calls[0]);
});
it('a create conflict refreshes the current receiver and requires review instead of replacing it', async () => {
 mocks.create.mockRejectedValue(Object.assign(new Error('A receiver already exists'), { status: 409 }));
 await select(); await press('Approve this receiver and endpoint'); mocks.list.mockResolvedValue({ available: true, subscriptions: [saved({ agentKeyId: 'other' })] });
 await press('Save receiving agent'); expect(mocks.list).toHaveBeenCalledTimes(2); expect(text()).toContain('Review the current receiver'); expect(button('Disable receiver for Other agent in Test room')).toBeTruthy();
 expect(button('Save receiving agent').props.disabled).toBe(true); expect(mocks.create).toHaveBeenCalledTimes(1); expect(mocks.remove).not.toHaveBeenCalled();
});
it('failed disable keeps the receiver visible for an explicit retry', async () => {
 mocks.list.mockResolvedValue({ available: true, subscriptions: [saved()] }); mocks.remove.mockRejectedValueOnce(new Error('Network unavailable'));
 await press('Set up webhooks'); await press(disable); expect(button(disable)).toBeTruthy();
 await press(disable); expect(button(disable)).toBeUndefined(); expect(mocks.remove).toHaveBeenCalledTimes(2);
});
it('failed refresh stops claiming a saved receiver is ready', async () => {
 mocks.list.mockResolvedValueOnce({ available: true, subscriptions: [saved()] }); await press('Set up webhooks'); expect(text()).toContain('Ready for future');
 mocks.list.mockRejectedValue(new Error('Connection lost')); await press('Refresh webhook setup'); expect(text()).not.toContain('Ready for future'); expect(text()).toContain('Receiver status could not be refreshed');
});
it('account-keyed replacement ignores the previous account’s late secret response', async () => {
 const later = deferred(); mocks.create.mockReturnValue(later.promise); await select(); await press('Approve this receiver and endpoint');
 await act(async () => { button('Save receiving agent').props.onPress(); });
 await act(async () => tree.update(React.createElement(ContextWebhookSetup, { key: 'next-account', hostedEnabled: false })));
 await act(async () => { later.resolve({ subscription: saved(), secret: 'old-account-secret' }); });
 expect(text()).not.toContain('old-account-secret'); expect(text()).not.toContain('https://receiver.example/'); expect(button('Set up webhooks')).toBeTruthy();
});
it('every visible action is at least 44px tall with a spoken label', async () => {
 await select(); for (const node of tree.root.findAllByType('TouchableOpacity' as any)) { expect(node.props.accessibilityLabel).toBeTruthy(); expect(Object.assign({}, ...node.props.style).minHeight).toBeGreaterThanOrEqual(44); }
});

it('uses distinct voice labels for the same key in different chats and refreshes remaining status after disabling', async () => {
 mocks.list.mockResolvedValue({ available: true, subscriptions: [saved(), saved({ id: 'sub2', conversationId: 'other-room' })] });
 await press('Set up webhooks'); expect(button(disable)).toBeTruthy(); expect(button('Disable receiver for Hermes in Other room')).toBeTruthy();
 mocks.remove.mockImplementation(async () => { mocks.list.mockResolvedValue({ available: true, subscriptions: [saved()] }); return { deleted: true }; });
 await press('Disable receiver for Hermes in Other room'); expect(mocks.remove).toHaveBeenCalledWith('sub2'); expect(mocks.list).toHaveBeenCalledTimes(2); expect(button(disable)).toBeTruthy(); expect(button('Disable receiver for Hermes in Other room')).toBeUndefined();
});
