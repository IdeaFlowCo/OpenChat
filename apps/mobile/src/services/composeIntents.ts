import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ComposeIntent } from '../utils/composeIntent';
import { parseComposeIntent } from '../utils/composeIntent';
const KEY = 'openchat:compose_intent';
const listeners = new Set<() => void>();
export async function captureComposeIntent(intent: ComposeIntent): Promise<void> {
  await AsyncStorage.setItem(KEY, JSON.stringify({ intent, capturedAt: Date.now() }));
  listeners.forEach(listener => listener());
}
export async function loadComposeIntent(): Promise<ComposeIntent | null> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw);
    if (!Number.isFinite(saved.capturedAt) || Date.now() - saved.capturedAt > 60 * 60 * 1000) return null;
    const params = new URLSearchParams({ intent: 'compose', ...saved.intent });
    return parseComposeIntent(new URL(`https://chat.ideaflow.app/app/?${params}`));
  } catch { return null; }
}
export async function clearComposeIntent(): Promise<void> { await AsyncStorage.removeItem(KEY); }
export function onComposeCaptured(listener: () => void): () => void {
  listeners.add(listener); return () => { listeners.delete(listener); };
}
