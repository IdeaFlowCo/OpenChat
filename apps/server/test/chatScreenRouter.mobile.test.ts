import React from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { CommonActions, StackActions, StackRouter, TabRouter } from '@react-navigation/routers';
import type { AsksStackParamList, RootStackParamList } from '../../mobile/src/navigation/types';
const mocks = vi.hoisted(() => ({
  select: vi.fn(), desktop: true, navigation: {} as any, dispatch: vi.fn(),
  destination: { conversationId: 'room', lane: 'context', entryId: 'entry' } as any,
}));
vi.mock('@react-navigation/native', async () => {
  const { CommonActions, StackActions } = await import('@react-navigation/routers');
  return {
    CommonActions, StackActions,
    useRoute: () => ({ params: mocks.destination }),
    useNavigation: () => mocks.navigation,
    createNavigationContainerRef: () => ({
      isReady: () => true,
      getRootState: () => ({ index: 0, routes: [{ name: 'Main' }] }),
      dispatch: mocks.dispatch,
    }),
  };
});
vi.mock('../../mobile/src/contexts/ChatContext', () => ({ useChat: () => ({ setActiveConversation: mocks.select }) }));
vi.mock('../../mobile/src/theme/breakpoints', () => ({ useIsDesktop: () => mocks.desktop }));
vi.mock('../../mobile/src/screens/ChatScreen', () => ({ ChatScreen: () => React.createElement('CompactChat') }));
import { ChatScreenRouter } from '../../mobile/src/screens/ChatScreenRouter';
let root: ReturnType<typeof create>;
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  vi.clearAllMocks();
  mocks.desktop = true;
});
const chatsRoutes = ['Conversations', 'Chat', 'AgentOverlay'] satisfies (keyof RootStackParamList)[];
const asksRoutes = ['AsksList', 'AgentOverlay', 'StoryComposer', 'StoryViewer', 'SocialReview', 'Chat'] satisfies (keyof AsksStackParamList)[];

function stack(routeNames: string[], cold: boolean) {
  const router = StackRouter({ initialRouteName: routeNames[0] });
  const options = { routeNames, routeParamList: {}, routeGetIdList: {} };
  let state = router.getInitialState(options);
  if (cold) {
    state = router.getRehydratedState({ stale: true, routes: [{ name: 'Chat', params: mocks.destination }] }, options);
  } else {
    state = router.getStateForAction(state, StackActions.push('AgentOverlay'), options)!;
    state = router.getStateForAction(state, StackActions.replace('Chat', mocks.destination), options)!;
  }
  const dispatch = vi.fn((action: Parameters<typeof router.getStateForAction>[1]) => {
    const next = router.getStateForAction(state, action, options);
    expect(next, `Unhandled ${action.type} in ${routeNames[0]}`).not.toBeNull();
    state = next!;
  });
  return {
    navigation: {
      getState: () => state,
      dispatch,
      canGoBack: () => state.index > 0,
      popToTop: () => dispatch(StackActions.popToTop()),
      popTo: (name: string) => dispatch(StackActions.popTo(name)),
    },
    names: () => state.routes.map(route => route.name),
  };
}

it.each([false, true])('opens the desktop conversation pane from Chats with cold entry=%s', async cold => {
  const chats = stack(chatsRoutes, cold);
  mocks.navigation = chats.navigation;
  await act(async () => { root = create(React.createElement(ChatScreenRouter)); });
  expect(mocks.select).toHaveBeenCalledWith('room', { lane: 'context' });
  expect(chats.names()).toEqual(['Conversations']);
  expect(mocks.dispatch).not.toHaveBeenCalled();
});

it.each([
  [false, 'chat'], [false, 'context'], [true, 'chat'], [true, 'context'],
] as const)('hands off Asks to Chats with cold entry=%s and lane=%s', async (cold, lane) => {
  mocks.destination = { conversationId: 'room', lane, entryId: 'entry' };
  const asks = stack(asksRoutes, cold);
  mocks.navigation = asks.navigation;
  await act(async () => { root = create(React.createElement(ChatScreenRouter)); });
  expect(asks.names()).toEqual(['AsksList']);
  expect(mocks.select).not.toHaveBeenCalled();
  expect(mocks.dispatch).toHaveBeenCalledExactlyOnceWith(CommonActions.navigate({
    name: 'Main', params: { screen: 'ChatsTab', params: { screen: 'Chat', params: mocks.destination } },
  }));

  const rootRouter = StackRouter({ initialRouteName: 'Main' });
  const rootOptions = { routeNames: ['Login', 'Onboarding', 'Main'], routeParamList: {}, routeGetIdList: {} };
  const main = rootRouter.getStateForAction(rootRouter.getInitialState(rootOptions), mocks.dispatch.mock.calls[0][0], rootOptions)!;
  const mainParams = main.routes[main.index].params as any;
  const tabRouter = TabRouter({ initialRouteName: 'AsksTab' });
  const tabOptions = { routeNames: ['ChatsTab', 'AsksTab', 'ThoughtsTab'], routeParamList: {}, routeGetIdList: {} };
  const tabs = tabRouter.getStateForAction(tabRouter.getInitialState(tabOptions), CommonActions.navigate(mainParams.screen, mainParams.params), tabOptions)!;
  expect(tabs.routes[tabs.index].name).toBe('ChatsTab');
  const chatParams = tabs.routes[tabs.index].params as any;
  const chatRouter = StackRouter({ initialRouteName: 'Conversations' });
  const chatOptions = { routeNames: chatsRoutes, routeParamList: {}, routeGetIdList: {} };
  const chatState = chatRouter.getStateForAction(chatRouter.getInitialState(chatOptions), CommonActions.navigate(chatParams.screen, chatParams.params), chatOptions)!;
  expect(chatState.routes[chatState.index]).toMatchObject({ name: 'Chat', params: mocks.destination });

  await act(async () => root.unmount());
  const chats = stack(chatsRoutes, true);
  mocks.navigation = chats.navigation;
  mocks.destination = chatState.routes[chatState.index].params;
  await act(async () => { root = create(React.createElement(ChatScreenRouter)); });
  expect(chats.names()).toEqual(['Conversations']);
  expect(mocks.select).toHaveBeenCalledExactlyOnceWith('room', { lane });
  const returnedTabs = tabRouter.getStateForAction(tabs, CommonActions.navigate('AsksTab'), tabOptions)!;
  expect(returnedTabs.routes[returnedTabs.index].name).toBe('AsksTab');
  expect(asks.names()).toEqual(['AsksList']);
});

it.each([{ routeNames: chatsRoutes }, { routeNames: asksRoutes }])('keeps compact Chat visible without a desktop handoff in $routeNames', async ({ routeNames }) => {
  mocks.desktop = false;
  const origin = stack(routeNames, false);
  mocks.navigation = origin.navigation;
  await act(async () => { root = create(React.createElement(ChatScreenRouter)); });
  expect(root.toJSON()).toMatchObject({ type: 'CompactChat' });
  expect(origin.names()).toEqual([routeNames[0], 'Chat']);
  expect(origin.navigation.dispatch).not.toHaveBeenCalled();
  expect(mocks.dispatch).not.toHaveBeenCalled();
  expect(mocks.select).not.toHaveBeenCalled();
});
