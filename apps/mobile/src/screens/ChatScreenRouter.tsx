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
  const { setActiveConversation } = useChat();
  const { conversationId } = route.params;

  useEffect(() => {
    if (!isDesktop) return;
    setActiveConversation(conversationId);
    if (navigation.canGoBack()) navigation.popToTop();
  }, [isDesktop, conversationId, setActiveConversation, navigation]);

  if (isDesktop) return null;
  return <ChatScreen />;
}
