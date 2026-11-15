import React, { useLayoutEffect, useRef, useState } from 'react';
import { useNavigation, useRoute } from '@react-navigation/native';
import { ConversationPanel } from '../components/ConversationPanel';
import { conversationPanelTitle, type ConversationPanelTab } from '../services/conversationPanel';
import type { NavProp, RouteProps } from '../navigation/types';

/**
 * The conversation side panel on a phone: the same To-dos, Stream and Details
 * tabs that sit beside the chat on a wide screen. It opens on the chat's
 * Stream unless a tab is asked for, which keeps the header's Stream door
 * doing what it always did.
 */
export function ConversationThoughtsScreen() {
  const route = useRoute<RouteProps<'ConversationThoughts'>>();
  const navigation = useNavigation<NavProp<'ConversationThoughts'>>();
  const { conversationId, title, focusTodoId } = route.params;
  const [tab, setTab] = useState<ConversationPanelTab>(route.params.tab ?? 'stream');
  // The route title already names the tab it opened on; follow the reader when they switch.
  const initialTab = useRef(tab);
  useLayoutEffect(() => {
    if (tab === initialTab.current) return;
    initialTab.current = tab;
    navigation.setOptions({ title: conversationPanelTitle(tab, title) });
  }, [navigation, tab, title]);
  return (
    <ConversationPanel
      conversationId={conversationId}
      tab={tab}
      onTabChange={setTab}
      focusTodoId={focusTodoId}
      onOpenedSource={() => navigation.goBack()}
    />
  );
}
