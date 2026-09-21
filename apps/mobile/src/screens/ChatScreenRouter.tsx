import { useEffect } from 'react';
import { useNavigation, useRoute } from '@react-navigation/native';
import { useChat } from '../contexts/ChatContext';
import { useIsDesktop } from '../theme/breakpoints';
import { ChatScreen } from './ChatScreen';
import type { NavProp, RouteProps } from '../navigation/types';

export function ChatScreenRouter() {
  const isDesktop = useIsDesktop();
  const route = useRoute<RouteProps<'Chat'>>();
  const navigation = useNavigation<NavProp<'Chat'>>();
  const { setActiveConversation, setActiveConversationLane } = useChat();
  const { conversationId, lane } = route.params;

  useEffect(() => {
    if (!isDesktop) return;
    setActiveConversation(conversationId, { lane });
    if (navigation.canGoBack()) navigation.popToTop();
  }, [isDesktop, conversationId, lane, setActiveConversation, navigation]);

  if (isDesktop) return null;
  return <ChatScreen />;
}
