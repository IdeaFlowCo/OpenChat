/**
 * Stream display preferences shared by every Stream surface (OpenChat-q60e).
 *
 * - Collapse: the viewer's saved per-entry preference. The server is the source
 *   of truth (`Thought.collapsed`); local overrides make a toggle show up at once
 *   in every open Stream view and are fed by the 'thought:collapsed' socket event.
 * - Compact view: a device preference, in the spirit of NoteStream Vision's
 *   Compact view. Long entries show their first lines until expanded.
 */

import { useCallback, useSyncExternalStore } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { api } from '../api/client';

const COMPACT_KEY = 'openchat.stream.compact';
/** Entries at least this long condense in Compact view. */
export const COMPACT_MIN_LINES = 6;
export const COMPACT_MIN_CHARS = 400;
export const COMPACT_VISIBLE_LINES = 4;

const collapseOverrides = new Map<string, boolean>();
let compact = true;
let version = 0;
const listeners = new Set<() => void>();
const emit = () => { version += 1; listeners.forEach((listener) => listener()); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const getVersion = () => version;

void AsyncStorage.getItem(COMPACT_KEY).then((stored) => {
  if (stored === 'false' && compact) { compact = false; emit(); }
}).catch(() => undefined);

export function isLongStreamText(text: string): boolean {
  return text.length >= COMPACT_MIN_CHARS || text.split('\n').length >= COMPACT_MIN_LINES;
}

/** Applies a collapse change made elsewhere (socket event from another screen or device). */
export function applyCollapsed(thoughtId: string, collapsed: boolean): void {
  if (collapseOverrides.get(thoughtId) === collapsed) return;
  collapseOverrides.set(thoughtId, collapsed);
  emit();
}

export function useStreamCompact(): [boolean, (next: boolean) => void] {
  useSyncExternalStore(subscribe, getVersion);
  const set = useCallback((next: boolean) => {
    compact = next;
    emit();
    void AsyncStorage.setItem(COMPACT_KEY, String(next)).catch(() => undefined);
  }, []);
  return [compact, set];
}

/** Collapsed state for one entry plus a saved toggle that rolls back on failure. */
export function useThoughtCollapsed(id: string, serverCollapsed: boolean | undefined): [boolean, () => Promise<void>] {
  useSyncExternalStore(subscribe, getVersion);
  const collapsed = collapseOverrides.get(id) ?? serverCollapsed === true;
  const toggle = useCallback(async () => {
    const previous = collapseOverrides.get(id) ?? serverCollapsed === true;
    collapseOverrides.set(id, !previous);
    emit();
    try {
      await api.setThoughtCollapsed(id, !previous);
    } catch (e) {
      collapseOverrides.set(id, previous);
      emit();
      throw e;
    }
  }, [id, serverCollapsed]);
  return [collapsed, toggle];
}
