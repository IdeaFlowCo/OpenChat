/**
 * The conversation side panel: one place beside a chat for the things kept
 * about it (private to-dos, its Stream, details about the person or group).
 *
 * Wide layouts dock it as a third column; mid-width layouts slide it over the
 * chat; phones open the same tabs as a pushed screen. The chat asks for the
 * panel through this module so it does not need to know which of the three
 * it is getting.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { DEFAULT_PANEL_PREFS, parsePanelPrefs, type ConversationPanelPrefs, type ConversationPanelTab } from '../utils/conversationPanel';

export {
  CONVERSATION_PANEL_TABS, DEFAULT_PANEL_PREFS, PANEL_MIN_CHAT_WIDTH, PANEL_WIDTH,
  conversationPanelTitle, nextPanelPrefs, panelPlacement, parsePanelPrefs,
  type ConversationPanelPrefs, type ConversationPanelTab,
} from '../utils/conversationPanel';

const STORAGE_KEY = 'openchat_conversation_panel_v1';

export async function loadPanelPrefs(): Promise<ConversationPanelPrefs> {
  try { return parsePanelPrefs(await AsyncStorage.getItem(STORAGE_KEY)); } catch { return DEFAULT_PANEL_PREFS; }
}

export function savePanelPrefs(prefs: ConversationPanelPrefs): void {
  AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(prefs)).catch(() => { /* a lost preference is not worth an error */ });
}

// ── Requests from inside a chat ────────────────────────────────────────────
export interface PanelRequest {
  conversationId: string; tab: ConversationPanelTab; focusTodoId?: string;
  /** Show it only where that costs nothing: a docked panel opens, a drawer is not thrown over the chat. */
  passive?: boolean;
}
type Listener = (request: PanelRequest) => void;
const listeners = new Set<Listener>();

/** The wide layout subscribes; returns the unsubscribe. */
export function onPanelRequest(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** True when a mounted wide layout took the request; false means the caller should push the panel screen. */
export function requestPanel(request: PanelRequest): boolean {
  if (!listeners.size) return false;
  for (const listener of listeners) listener(request);
  return true;
}

// ── To-do changes (so a chat's markers and the panel list stay in step) ─────
const todoListeners = new Set<(conversationId: string) => void>();
export function onTodosChanged(listener: (conversationId: string) => void): () => void {
  todoListeners.add(listener);
  return () => { todoListeners.delete(listener); };
}
export function announceTodosChanged(conversationId: string): void {
  for (const listener of todoListeners) listener(conversationId);
}

// ── Jump to a message (a to-do's source quote) ──────────────────────────────
type JumpListener = (conversationId: string, messageId: string) => void;
const jumpListeners = new Set<JumpListener>();
export function onMessageJump(listener: JumpListener): () => void {
  jumpListeners.add(listener);
  return () => { jumpListeners.delete(listener); };
}
export function requestMessageJump(conversationId: string, messageId: string): void {
  for (const listener of jumpListeners) listener(conversationId, messageId);
}
