import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useChat } from './ChatContext';
import { DEFAULT_TRANSLATION, readTranslationPreferences, TranslationQueue, type TranslationPreference, type TranslationPreferences } from '../services/translation';

interface TranslationContextValue {
  preferences: TranslationPreferences;
  ready: boolean;
  error: string | null;
  update: (patch: Partial<TranslationPreference>, conversationId?: string) => void;
  resetChat: (conversationId: string) => void;
  queue: TranslationQueue;
}
const Context = createContext<TranslationContextValue | null>(null);
export function TranslationProvider({ children }: { children: ReactNode }) {
  const { currentUser } = useChat();
  return <AccountTranslation key={currentUser?.userId || 'signed-out'} userId={currentUser?.userId}>{children}</AccountTranslation>;
}
function AccountTranslation({ userId, children }: { userId?: string; children: ReactNode }) {
  const storageKey = `openchat.translation.v1:${userId}`;
  const [preferences, setPreferences] = useState<TranslationPreferences>(DEFAULT_TRANSLATION);
  const latest = useRef(preferences);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [queue] = useState(() => new TranslationQueue());
  const writes = useRef(Promise.resolve());
  useEffect(() => {
    let mounted = true;
    if (!userId) return;
    AsyncStorage.getItem(storageKey).then(raw => {
      if (mounted) { latest.current = readTranslationPreferences(raw); setPreferences(latest.current); }
    }).catch(() => { if (mounted) setError('Could not load translation preferences.'); })
      .finally(() => { if (mounted) setReady(true); });
    return () => { mounted = false; };
  }, [storageKey, userId]);
  const save = (next: TranslationPreferences) => {
    if (!ready || !userId) return;
    latest.current = next;
    setPreferences(next);
    setError(null);
    writes.current = writes.current.catch(() => undefined).then(() => AsyncStorage.setItem(storageKey, JSON.stringify(next)))
      .catch(() => setError('This change works now, but could not be saved on this device. Try selecting it again.'));
  };
  return <Context.Provider value={{ preferences, ready, error, queue,
    update: (patch, id) => save(id ? { ...latest.current, chats: { ...latest.current.chats, [id]: { ...latest.current.chats[id], ...patch } } } : { ...latest.current, ...patch }),
    resetChat: id => { const chats = { ...latest.current.chats }; delete chats[id]; save({ ...latest.current, chats }); },
  }}>{children}</Context.Provider>;
}
export const useTranslation = () => useContext(Context);
export function useChatTranslation(conversationId?: string) {
  const context = useTranslation();
  const preferences = context?.preferences || DEFAULT_TRANSLATION;
  return { context, preference: { mode: preferences.mode, language: preferences.language, ...(conversationId ? preferences.chats[conversationId] : {}) } };
}
