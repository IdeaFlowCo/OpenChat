import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from '../api/client';
import { useChat } from './ChatContext';

interface PrivateNamesValue {
  names: Record<string, string | null>;
  refresh: (id: string) => Promise<void>;
  save: (id: string, name: string | null) => Promise<void>;
}
const Context = createContext<PrivateNamesValue | null>(null);

// Remount all private state on account changes. Late responses remain in the
// retired account's component and cannot populate the new account's UI.
export function PrivateNamesProvider({ children }: { children: ReactNode }) {
  const { currentUser } = useChat();
  return <AccountPrivateNames key={currentUser?.userId || 'signed-out'}>{children}</AccountPrivateNames>;
}
function AccountPrivateNames({ children }: { children: ReactNode }) {
  const [names, setNames] = useState<Record<string, string | null>>({});
  const revisions = useRef<Record<string, number>>({});
  const refresh = useCallback(async (id: string) => {
    const version = (revisions.current[id] || 0) + 1;
    revisions.current[id] = version;
    try {
      const result = await api.getPrivateName(id);
      if ((revisions.current[id] || 0) === version) setNames(current => ({ ...current, [id]: result.name }));
    } catch {
      if ((revisions.current[id] || 0) === version) setNames(current => ({ ...current, [id]: null }));
    }
  }, []);
  const save = useCallback(async (id: string, name: string | null) => {
    revisions.current[id] = (revisions.current[id] || 0) + 1;
    const result = name === null ? await api.clearPrivateName(id) : await api.setPrivateName(id, name);
    revisions.current[id] = (revisions.current[id] || 0) + 1;
    setNames(current => ({ ...current, [id]: result.name }));
  }, []);
  const value = useMemo(() => ({ names, refresh, save }), [names, refresh, save]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function usePrivateName(userId?: string) {
  const context = useContext(Context);
  // Screens rendered in isolated tests without the app provider retain their
  // official label. Every actual app surface lives under the provider.
  const refresh = context?.refresh;
  useEffect(() => { if (userId && refresh) void refresh(userId); }, [userId, refresh]);
  return {
    name: userId ? context?.names[userId] || null : null,
    save: async (name: string | null) => {
      if (!context || !userId) throw new Error('Person unavailable');
      await context.save(userId, name);
    },
  };
}
