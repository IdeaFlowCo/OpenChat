/** A short app-wide notice ("Path copied…"), shown by <GlobalNotice /> wherever it was raised. */
import { useSyncExternalStore } from 'react';

let current: { id: number; message: string } | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(listener => listener());

export function showNotice(message: string, duration = 3000): void {
  current = { id: (current?.id ?? 0) + 1, message };
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { current = null; emit(); }, duration + 600);
  emit();
}
export function useNotice(): { id: number; message: string } | null {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => current, () => current);
}
