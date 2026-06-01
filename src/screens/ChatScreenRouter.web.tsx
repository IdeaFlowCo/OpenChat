/**
 * ChatScreenRouter — WEB variant (OpenChat-601).
 *
 * On NARROW web (<900 px) it renders the full ChatScreen with its native-
 * stack header — same as native.
 *
 * On DESKTOP web (>=900 px) it intercepts the route: rather than render a
 * full screen on top of the master-detail, it sets the active conversation
 * in ChatContext and pops back to the home (master-detail) route. This is
 * how callers like NewConversationScreen.replace('Chat', …) and
 * SearchScreen.replace('Chat', …) translate into "switch the right pane"
 * on desktop without each call site needing to know the layout mode.
 *
 * The redirect happens inside useEffect so it runs after the navigator
 * has committed this route, and we render null in the meantime to avoid a
 * flash of the mobile chat screen.
 *
 * NOTE: feature parity gap — on /d/ master-detail the right pane uses
 * ChatPane.web.tsx which is older than the current ChatScreen. Refactoring
 * ChatScreen to extract a shared ChatPane body is filed as a follow-up
 * (see OpenChat-601 acceptance criteria + final-summary section).
 */

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
    // popToTop avoids leaving any modal/replace chain behind. The home
    // route picks up the new activeConversationId from context.
    if (navigation.canGoBack()) navigation.popToTop();
  }, [isDesktop, conversationId, setActiveConversation, navigation]);

  if (isDesktop) return null;
  return <ChatScreen />;
}
