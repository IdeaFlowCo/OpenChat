import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  listener: undefined as undefined | ((response: any) => void),
  initial: vi.fn(), clear: vi.fn(async () => {}), remove: vi.fn(),
  ready: false, root: 'Login', dispatch: vi.fn(),
}));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('expo-device', () => ({}));
vi.mock('expo-constants', () => ({ default: {} }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: {} }));
vi.mock('../../mobile/src/api/client', () => ({ api: {} }));
vi.mock('@react-navigation/native', () => ({
  CommonActions: { navigate: (payload: unknown) => ({ type: 'NAVIGATE', payload }) },
  createNavigationContainerRef: () => ({
    isReady: () => mocks.ready,
    getRootState: () => ({ index: 0, routes: [{ name: mocks.root }] }),
    dispatch: mocks.dispatch,
  }),
}));
vi.mock('expo-notifications', () => ({
  DEFAULT_ACTION_IDENTIFIER: 'default',
  getLastNotificationResponseAsync: mocks.initial,
  clearLastNotificationResponseAsync: mocks.clear,
  addNotificationResponseReceivedListener: (fn: any) => { mocks.listener = fn; return { remove: mocks.remove }; },
}));
import { addNotificationTapListener } from '../../mobile/src/services/notifications';
import { flushConversationNavigation, openConversation } from '../../mobile/src/navigation/conversationNavigation';
const response = (id: string) => ({ actionIdentifier: 'default', notification: { request: { identifier: id, content: { data: { conversationId: id } } } } });
const destination = (conversationId: string, lane = 'chat') => ({ type: 'NAVIGATE', payload: {
  name: 'Main', params: { screen: 'ChatsTab', params: { screen: 'Chat', params: { conversationId, lane } } },
} });
beforeEach(() => { vi.clearAllMocks(); mocks.ready = true; mocks.root = 'Main'; flushConversationNavigation(); mocks.dispatch.mockClear(); mocks.ready = false; mocks.root = 'Login'; mocks.initial.mockResolvedValue(null); });

it('retains a cold-start notification through mounting, login and onboarding', async () => {
  mocks.initial.mockResolvedValue(response('harrison'));
  const sub = addNotificationTapListener(); await Promise.resolve();
  expect(mocks.dispatch).not.toHaveBeenCalled();
  mocks.ready = true; flushConversationNavigation();
  mocks.root = 'Onboarding'; flushConversationNavigation();
  expect(mocks.dispatch).not.toHaveBeenCalled();
  mocks.root = 'Main'; flushConversationNavigation(); flushConversationNavigation();
  expect(mocks.dispatch).toHaveBeenCalledExactlyOnceWith(destination('harrison'));
  expect(mocks.clear).toHaveBeenCalledOnce(); sub!.remove();
});
it('does not let an old launch response replace a newer tap', async () => {
  let resolve!: (value: any) => void;
  mocks.initial.mockReturnValue(new Promise(r => { resolve = r; }));
  const sub = addNotificationTapListener();
  mocks.listener!(response('new')); resolve(response('old')); await Promise.resolve();
  mocks.ready = true; mocks.root = 'Main'; flushConversationNavigation();
  expect(mocks.dispatch).toHaveBeenCalledExactlyOnceWith(destination('new')); sub!.remove();
});
it('routes a Context destination through the Chats stack and preserves its lane', () => {
  openConversation({ conversationId: 'room', lane: 'context' });
  mocks.ready = true; mocks.root = 'Main'; flushConversationNavigation();
  expect(mocks.dispatch).toHaveBeenCalledExactlyOnceWith(destination('room', 'context'));
});
it('ignores duplicate taps and a response delivered after disposal', async () => {
  mocks.ready = true; mocks.root = 'Main';
  let resolve!: (value: any) => void;
  mocks.initial.mockReturnValue(new Promise(r => { resolve = r; }));
  const sub = addNotificationTapListener();
  mocks.listener!(response('one')); mocks.listener!(response('one'));
  sub!.remove(); resolve(response('disposed')); await Promise.resolve();
  expect(mocks.dispatch).toHaveBeenCalledExactlyOnceWith(destination('one'));
});
