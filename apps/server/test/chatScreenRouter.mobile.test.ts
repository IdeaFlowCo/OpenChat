import React from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { StackActions, StackRouter } from '@react-navigation/routers';
const mocks = vi.hoisted(() => ({ select: vi.fn(), desktop: true, navigation: {} as any }));
vi.mock('@react-navigation/native', () => ({
  useRoute: () => ({ params: { conversationId: 'room', lane: 'context' } }),
  useNavigation: () => mocks.navigation,
}));
vi.mock('../../mobile/src/contexts/ChatContext', () => ({ useChat: () => ({ setActiveConversation: mocks.select }) }));
vi.mock('../../mobile/src/theme/breakpoints', () => ({ useIsDesktop: () => mocks.desktop }));
vi.mock('../../mobile/src/screens/ChatScreen', () => ({ ChatScreen: () => React.createElement('CompactChat') }));
import { ChatScreenRouter } from '../../mobile/src/screens/ChatScreenRouter';
let root: ReturnType<typeof create>;
afterEach(async () => { if (root) await act(async () => root.unmount()); vi.clearAllMocks(); });
it.each([false, true])('opens the desktop conversation pane with an existing host=%s', async hasHost => {
  const router = StackRouter({ initialRouteName: hasHost ? 'Conversations' : 'Chat' });
  const options = { routeNames: ['Conversations', 'Chat'], routeParamList: {}, routeGetIdList: {} };
  let state = router.getInitialState(options);
  if (hasHost) state = router.getStateForAction(state, StackActions.push('Chat'), options)!;
  mocks.navigation = {
    canGoBack: () => state.index > 0,
    popToTop: () => { state = router.getStateForAction(state, StackActions.popToTop(), options)!; },
    popTo: (name: string) => { state = router.getStateForAction(state, StackActions.popTo(name), options)!; },
  };
  await act(async () => { root = create(React.createElement(ChatScreenRouter)); });
  expect(mocks.select).toHaveBeenCalledWith('room', { lane: 'context' });
  expect(state.routes.map(route => route.name)).toEqual(['Conversations']);
});
