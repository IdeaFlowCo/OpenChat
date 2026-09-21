import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';

export type EntryTarget =
  | { kind: 'group'; token: string }
  | { kind: 'person'; userId: string }
  | { kind: 'card'; token: string };

export type EntryPhase =
  | 'preview'
  | 'auth'
  | 'profile'
  | 'ready'
  | 'accepting'
  | 'opening'
  | 'completed'
  | 'dismissed';

export type EntryIntent = {
  version: 2;
  clientIntentId: string;
  target: EntryTarget;
  capturedAt: string;
  continuation: 'web' | 'install' | 'native';
  ownerUserId?: string;
  serverId?: string;
  phase: EntryPhase;
};

const STORAGE_KEY = 'openchat:entry_intents';

export async function saveEntryIntent(intent: EntryIntent): Promise<void> {
  const all = await loadAllEntryIntents();
  const index = all.findIndex(i => i.clientIntentId === intent.clientIntentId);
  if (index !== -1) {
    all[index] = intent;
  } else {
    // Check for duplicate target and update if present, or add new
    const duplicateIndex = all.findIndex(i =>
      (i.target.kind === intent.target.kind) &&
      (
        (i.target.kind === 'group' && intent.target.kind === 'group' && i.target.token === intent.target.token) ||
        (i.target.kind === 'person' && intent.target.kind === 'person' && i.target.userId === intent.target.userId) ||
        (i.target.kind === 'card' && intent.target.kind === 'card' && i.target.token === intent.target.token)
      )
    );
    if (duplicateIndex !== -1) {
       // Replace duplicate
       all[duplicateIndex] = intent;
    } else {
       all.push(intent);
    }
  }
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(all));
}

export async function loadAllEntryIntents(): Promise<EntryIntent[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as EntryIntent[];
    return [];
  } catch {
    return [];
  }
}

export async function getActiveEntryIntent(userId?: string): Promise<EntryIntent | null> {
  const all = await loadAllEntryIntents();
  // Filter by user if provided, otherwise only unbound entries
  let valid = all.filter(i => {
    if (userId) return !i.ownerUserId || i.ownerUserId === userId;
    return !i.ownerUserId;
  });
  
  // Exclude completed or dismissed
  valid = valid.filter(i => i.phase !== 'completed' && i.phase !== 'dismissed');
  
  if (valid.length === 0) return null;
  // Sort by capturedAt desc
  valid.sort((a, b) => new Date(b.capturedAt).getTime() - new Date(a.capturedAt).getTime());
  return valid[0];
}

export function createEntryIntent(target: EntryTarget, continuation: 'web' | 'install' | 'native'): EntryIntent {
  return {
    version: 2,
    clientIntentId: Crypto.randomUUID(),
    target,
    capturedAt: new Date().toISOString(),
    continuation,
    phase: 'preview',
  };
}

export async function clearEntryIntents(): Promise<void> {
  await AsyncStorage.removeItem(STORAGE_KEY);
}
