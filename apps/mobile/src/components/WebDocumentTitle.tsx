import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Platform } from 'react-native';
import { useChat } from '../contexts/ChatContext';
import { navigationRef } from '../navigation/conversationNavigation';
import {
  getConversationTitlesSnapshot,
  resolveDocumentTitle,
  subscribeConversationTitles,
} from '../utils/documentTitle';

/**
 * Keeps the browser tab title on the open view (OpenChat-mrl2). Replaces
 * React Navigation's built-in document title, which only sees option titles
 * and so showed an empty title for conversations and "Chats" for every chat
 * opened in the desktop pane. Render inside NavigationContainer; web only.
 */
export function WebDocumentTitle() {
  const { unreadByConv, activeConversationId } = useChat();
  const [navVersion, setNavVersion] = useState(0);
  const published = useSyncExternalStore(subscribeConversationTitles, getConversationTitlesSnapshot, getConversationTitlesSnapshot);
  const unreadTotal = useMemo(
    () => Array.from(unreadByConv.values()).reduce((sum, n) => sum + n, 0),
    [unreadByConv],
  );

  useEffect(() => {
    if (Platform.OS !== 'web') return undefined;
    const bump = () => setNavVersion(v => v + 1);
    const offState = navigationRef.addListener('state', bump);
    const offOptions = navigationRef.addListener('options', bump);
    const offReady = navigationRef.addListener('ready', bump);
    return () => { offState(); offOptions(); offReady(); };
  }, []);

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;
    const ready = navigationRef.isReady();
    const route = ready ? navigationRef.getCurrentRoute() : undefined;
    const options = ready ? navigationRef.getCurrentOptions() as { title?: unknown } | undefined : undefined;
    const params = route?.params as { conversationId?: unknown } | undefined;
    const title = resolveDocumentTitle({
      routeName: route?.name,
      optionTitle: options?.title,
      routeConversationId: typeof params?.conversationId === 'string' ? params.conversationId : undefined,
      activeConversationId,
      unreadTotal,
    });
    if (document.title !== title) document.title = title;
  }, [navVersion, published, activeConversationId, unreadTotal]);

  return null;
}
