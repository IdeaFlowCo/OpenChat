import { useEffect, useRef } from 'react';
import { useEntryContext } from '../contexts/EntryContext';
import { useChat } from '../contexts/ChatContext';
import { navigationRef } from '../services/notifications';
import { routeEntryIntentIfReady } from './entryNavigation';

export function EntryRouter() {
  const { isAuthed } = useChat();
  const { entryIntent, isReady } = useEntryContext();
  const lastRoutedIntent = useRef<string | null>(null);

  useEffect(() => {
    if (!isReady || !isAuthed || !entryIntent) {
      lastRoutedIntent.current = null;
      return;
    }

    const tryNavigate = () => {
      routeEntryIntentIfReady(navigationRef, entryIntent, lastRoutedIntent);
    };

    const unsubscribeReady = navigationRef.addListener('ready', tryNavigate);
    const unsubscribeState = navigationRef.addListener('state', tryNavigate);
    tryNavigate();
    return () => {
      unsubscribeReady();
      unsubscribeState();
    };
  }, [isAuthed, isReady, entryIntent]);

  return null;
}
