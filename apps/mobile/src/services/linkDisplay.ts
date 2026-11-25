/**
 * "Show links as typed": a device preference, off by default. When on, message
 * and Stream text is shown exactly as written, with nothing turned into a link.
 */
import { useCallback, useSyncExternalStore } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'openchat.links.asTyped';
let asTyped = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(listener => listener());
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

void AsyncStorage.getItem(KEY).then(stored => { if (stored === 'true' && !asTyped) { asTyped = true; emit(); } }).catch(() => undefined);

export function useLinksAsTyped(): [boolean, (next: boolean) => void] {
  const value = useSyncExternalStore(subscribe, () => asTyped, () => asTyped);
  const set = useCallback((next: boolean) => {
    asTyped = next; emit();
    void AsyncStorage.setItem(KEY, String(next)).catch(() => undefined);
  }, []);
  return [value, set];
}
