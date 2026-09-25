import { useEffect } from 'react';
import { useEntryContext } from '../contexts/EntryContext';
import { useChat } from '../contexts/ChatContext';
import { navigationRef } from '../services/notifications';

export function EntryRouter() {
  const { isAuthed } = useChat();
  const { entryIntent, isReady } = useEntryContext();

  useEffect(() => {
    if (!isReady || !isAuthed || !entryIntent) return;

    const navigate = () => {
      if (entryIntent.target.kind === 'group') {
        navigationRef.navigate('GroupInvitePreview', { token: entryIntent.target.token });
      } else if (entryIntent.target.kind === 'person') {
        navigationRef.navigate('PersonEntry', { userId: entryIntent.target.userId });
      } else if (entryIntent.target.kind === 'card') {
        navigationRef.navigate('CardEntry', { token: entryIntent.target.token });
      }
    };

    if (navigationRef.isReady()) {
      // Defer slightly to ensure navigators have mounted their state
      setTimeout(navigate, 100);
    }
  }, [isAuthed, isReady, entryIntent]);

  return null;
}