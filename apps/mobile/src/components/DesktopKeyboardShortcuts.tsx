import { useEffect } from 'react';
import { Platform } from 'react-native';
import { CommonActions } from '@react-navigation/native';
import { navigationRef } from '../navigation/conversationNavigation';
import { useIsDesktop } from '../theme/breakpoints';
import { dispatchDesktopKeyboardHandler } from '../services/desktopKeyboard';

/** One desktop listener survives navigation to screens without a split layout. */
export function DesktopKeyboardShortcuts({ enabled }: { enabled: boolean }) {
  const desktop = useIsDesktop();
  useEffect(() => {
    if (!enabled || !desktop || Platform.OS !== 'web' || typeof document === 'undefined') return;
    const pendingEscapes = new Set<ReturnType<typeof setTimeout>>();
    const handleKey = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229 || event.defaultPrevented || !navigationRef.isReady()) return;
      if (dispatchDesktopKeyboardHandler(event)) return;
      const meta = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      const screen = meta ? key === 'k' ? 'Search'
        : key === 'n' || (event.shiftKey && key === 'o') ? 'NewConversation'
        : key === ',' ? 'Settings'
        : key === '/' ? 'KeyboardShortcuts' : undefined : undefined;
      if (screen) {
        event.preventDefault();
        navigationRef.dispatch(CommonActions.navigate({
          name: 'Main', params: { screen: 'ChatsTab', params: { screen } },
        }));
      } else if (event.key === 'Escape' && navigationRef.canGoBack()) {
        event.preventDefault();
        navigationRef.goBack();
      }
    };
    const onKey = (event: KeyboardEvent) => {
      // Let local capture handlers (e.g. the chat hashtag picker) consume
      // Escape first. TextInput may stop bubbling, so retain this capture
      // listener and check defaultPrevented after local handlers have run.
      if (event.key === 'Escape') {
        // A microtask can run between trusted DOM event listeners, before
        // local capture. A task waits until the entire key event finishes.
        const timer = setTimeout(() => { pendingEscapes.delete(timer); handleKey(event); }, 0);
        pendingEscapes.add(timer);
      } else handleKey(event);
    };
    // RN-web TextInput stops keydown bubbling. Capture keeps Escape and
    // global shortcuts available while Search or a composer owns focus.
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      pendingEscapes.forEach(clearTimeout);
    };
  }, [enabled, desktop]);
  return null;
}
