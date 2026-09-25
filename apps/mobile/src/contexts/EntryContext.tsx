import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { getActiveEntryIntent, clearEntryIntents, EntryIntent, onEntryIntentCaptured, saveEntryIntent } from '../services/entryIntents';
import { useChat } from './ChatContext';
import { api } from '../api/client';

interface EntryContextValue {
  entryIntent: EntryIntent | null;
  refreshEntryIntent: () => Promise<void>;
  clearEntry: () => Promise<void>;
  isReady: boolean;
}

const EntryContext = createContext<EntryContextValue | null>(null);

export function EntryProvider({ children }: { children: ReactNode }) {
  const [entryIntent, setEntryIntent] = useState<EntryIntent | null>(null);
  const [isReady, setIsReady] = useState(false);
  const { isAuthed, currentUser } = useChat();

  const refreshEntryIntent = async () => {
    const userId = currentUser?.userId;
    let active = await getActiveEntryIntent(userId);
    
    // Fallback to server if none locally and authed
    if (!active && isAuthed && userId) {
      try {
        const serverEntries = await api.getEntryIntents();
        if (serverEntries.length > 0) {
          const entry = serverEntries[0];
          active = {
            version: 2,
            clientIntentId: entry.clientIntentId,
            target: entry.target,
            capturedAt: entry.createdAt,
            continuation: entry.continuation,
            phase: 'preview',
            ownerUserId: userId,
            serverId: entry.id,
          };
          await saveEntryIntent(active);
        }
      } catch (err) {
        // ignore
      }
    }
    setEntryIntent(active);
  };

  useEffect(() => {
    let active = true;
    const init = async () => {
      let intent = await getActiveEntryIntent(currentUser?.userId);
      
      // Push local unbound intent to server
      if (intent && !intent.ownerUserId && isAuthed && currentUser?.userId) {
        try {
          const res = await api.saveEntryIntent({
            clientIntentId: intent.clientIntentId,
            target: intent.target,
            continuation: intent.continuation,
          });
          intent.ownerUserId = currentUser.userId;
          intent.serverId = res.id;
          await saveEntryIntent(intent);
        } catch (err) { }
      }

      if (!intent && isAuthed && currentUser?.userId) {
        try {
          const serverEntries = await api.getEntryIntents();
          if (serverEntries.length > 0) {
            const entry = serverEntries[0];
            intent = {
              version: 2,
              clientIntentId: entry.clientIntentId,
              target: entry.target,
              capturedAt: entry.createdAt,
              continuation: entry.continuation,
              phase: 'preview',
              ownerUserId: currentUser.userId,
              serverId: entry.id,
            };
            await saveEntryIntent(intent);
          }
        } catch (err) { }
      }
      if (active) {
        setEntryIntent(intent);
        setIsReady(true);
      }
    };
    init();
    return () => { active = false; };
  }, [currentUser?.userId, isAuthed]);

  useEffect(() => onEntryIntentCaptured(() => {
    void getActiveEntryIntent(currentUser?.userId).then(setEntryIntent);
  }), [currentUser?.userId]);

  const clearEntry = async () => {
    if (entryIntent?.serverId && isAuthed) {
      try {
        await api.completeEntryIntent(entryIntent.serverId);
      } catch (e) { }
    }
    await clearEntryIntents();
    setEntryIntent(null);
  };

  return (
    <EntryContext.Provider value={{ entryIntent, refreshEntryIntent, clearEntry, isReady }}>
      {children}
    </EntryContext.Provider>
  );
}

export function useEntryContext() {
  const ctx = useContext(EntryContext);
  if (!ctx) throw new Error('useEntryContext must be used within an EntryProvider');
  return ctx;
}