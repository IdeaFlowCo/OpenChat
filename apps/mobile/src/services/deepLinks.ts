import { Linking, Platform } from 'react-native';
import { parseOpenChatUrl } from '../utils/parseOpenChatUrl';
import { createEntryIntent, saveEntryIntent, EntryTarget } from './entryIntents';
import { navigationRef } from './notifications';
import { getToken } from '../api/client';

export function installDeepLinkHandling(): () => void {
  let disposed = false;

  async function handleIncomingUrl(url: string): Promise<void> {
    const parsed = parseOpenChatUrl(url);
    if (parsed.type === 'unknown') return;

    if (parsed.type === 'context') {
      try {
        const token = await getToken();
        if (token) {
          // Give navigation a moment to mount on cold start
          setTimeout(() => {
            if (navigationRef.isReady()) {
              navigationRef.navigate('Chat', { conversationId: parsed.conversationId, lane: 'context', entryId: parsed.entryId });
            }
          }, 300);
        }
      } catch { }
      return;
    }

    let target: EntryTarget | null = null;
    if (parsed.type === 'invite') {
      target = { kind: 'group', token: parsed.token };
    } else if (parsed.type === 'user') {
      target = { kind: 'person', userId: parsed.userId };
    }

    if (target) {
      const continuation = Platform.OS === 'web' ? 'web' : 'native';
      const intent = createEntryIntent(target, continuation);
      await saveEntryIntent(intent);
    }
  }

  void Linking.getInitialURL().then((url) => {
    if (disposed) return;
    if (url) void handleIncomingUrl(url);
  });

  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    try {
      const here = window.location.href;
      void handleIncomingUrl(here);
    } catch { }
  }

  const sub = Linking.addEventListener('url', (event) => {
    if (disposed) return;
    if (event?.url) void handleIncomingUrl(event.url);
  });

  return () => {
    disposed = true;
    sub.remove();
  };
}
