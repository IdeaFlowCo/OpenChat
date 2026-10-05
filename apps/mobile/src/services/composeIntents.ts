import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ComposeIntent } from '../utils/composeIntent';
import { parseComposeIntent } from '../utils/composeIntent';
const KEY = 'openchat:compose_intent';
const listeners = new Set<() => void>();
export type PendingComposeIntent = { intent: ComposeIntent; revision: string };
let sequence = 0;
// AsyncStorage has no compare-and-delete primitive. Serialize reads and writes
// so an incoming capture cannot slip between a revision check and removal.
let operations: Promise<unknown> = Promise.resolve();
function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const result = operations.then(operation);
  operations = result.catch(() => undefined);
  return result;
}
function parseSaved(raw: string | null): PendingComposeIntent | null {
  if (!raw) return null;
  try {
    const saved = JSON.parse(raw);
    if (!Number.isFinite(saved.capturedAt) || Date.now() - saved.capturedAt > 60 * 60 * 1000) return null;
    const params = new URLSearchParams({ intent: 'compose', ...saved.intent });
    const intent = parseComposeIntent(new URL(`https://chat.ideaflow.app/app/?${params}`));
    if (!intent) return null;
    // Older captures remain replayable after the client updates.
    return { intent, revision: typeof saved.revision === 'string' ? saved.revision : `legacy:${raw}` };
  } catch { return null; }
}
export async function captureComposeIntent(intent: ComposeIntent): Promise<void> {
  await serialize(() => AsyncStorage.setItem(KEY, JSON.stringify({ intent, capturedAt: Date.now(), revision: `${Date.now()}-${++sequence}-${Math.random().toString(36).slice(2)}` })));
  listeners.forEach(listener => listener());
}
export function loadPendingComposeIntent(): Promise<PendingComposeIntent | null> {
  return serialize(async () => parseSaved(await AsyncStorage.getItem(KEY)));
}
export async function loadComposeIntent(): Promise<ComposeIntent | null> {
  return (await loadPendingComposeIntent())?.intent ?? null;
}
/** Consume only the capture which was actually routed, never a newer request. */
export function consumeComposeIntent(revision: string): Promise<boolean> {
  return serialize(async () => {
    const pending = parseSaved(await AsyncStorage.getItem(KEY));
    if (!pending || pending.revision !== revision) return false;
    await AsyncStorage.removeItem(KEY);
    return true;
  });
}
export function onComposeCaptured(listener: () => void): () => void {
  listeners.add(listener); return () => { listeners.delete(listener); };
}
