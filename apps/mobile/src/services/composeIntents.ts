import AsyncStorage from '@react-native-async-storage/async-storage';
import { isUnlinkedEmbed } from './unlinkedEmbed';
import type { ComposeIntent } from '../utils/composeIntent';
import { parseComposeIntent } from '../utils/composeIntent';
const KEY = 'openchat:compose_intent';
const listeners = new Set<() => void>();
export type PendingComposeIntent = { intent: ComposeIntent; revision: string };
let sequence = 0;
// Each embedded tab owns its pending recipient, even when browser storage is
// blocked. Never consume a standalone tab's pending compose request.
let embeddedPending: string | null = null;
const readPending = () => isUnlinkedEmbed() ? Promise.resolve(embeddedPending) : AsyncStorage.getItem(KEY);
const writePending = async (value: string) => {
  if (isUnlinkedEmbed()) embeddedPending = value;
  else await AsyncStorage.setItem(KEY, value);
};
const removePending = async () => {
  if (isUnlinkedEmbed()) embeddedPending = null;
  else await AsyncStorage.removeItem(KEY);
};
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
  await serialize(() => writePending(JSON.stringify({ intent, capturedAt: Date.now(), revision: `${Date.now()}-${++sequence}-${Math.random().toString(36).slice(2)}` })));
  listeners.forEach(listener => listener());
}
export function loadPendingComposeIntent(): Promise<PendingComposeIntent | null> {
  return serialize(async () => parseSaved(await readPending()));
}
export async function loadComposeIntent(): Promise<ComposeIntent | null> {
  return (await loadPendingComposeIntent())?.intent ?? null;
}
/** Consume only the capture which was actually routed, never a newer request. */
export function consumeComposeIntent(revision: string): Promise<boolean> {
  return serialize(async () => {
    const pending = parseSaved(await readPending());
    if (!pending || pending.revision !== revision) return false;
    await removePending();
    return true;
  });
}
export function onComposeCaptured(listener: () => void): () => void {
  listeners.add(listener); return () => { listeners.delete(listener); };
}
