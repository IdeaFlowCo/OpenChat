import { useEffect } from 'react';
import { StackActions, useNavigation, useRoute } from '@react-navigation/native';
import { useChat } from '../contexts/ChatContext';
import { useIsDesktop } from '../theme/breakpoints';
import { ChatScreen } from './ChatScreen';
import type { NavProp, RouteProps } from '../navigation/types';
import { openConversation } from '../navigation/conversationNavigation';

export function ChatScreenRouter() {
  const isDesktop = useIsDesktop();
  const route = useRoute<RouteProps<'Chat'>>();
  const navigation = useNavigation<NavProp<'Chat'>>();
  const { setActiveConversation } = useChat();
  const { conversationId, lane } = route.params;

  useEffect(() => {
    if (!isDesktop) return;
    const { routeNames } = navigation.getState();
    if (!routeNames.includes('Conversations')) {
      navigation.dispatch(StackActions.popTo(routeNames[0]));
      openConversation(route.params);
      return;
    }
    setActiveConversation(conversationId, { lane });
    navigation.popTo('Conversations');
  }, [isDesktop, conversationId, lane, route.params, setActiveConversation, navigation]);

  if (isDesktop) return null;
  return <ChatScreen />;
}
