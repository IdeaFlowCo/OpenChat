/**
 * The conversation side panel's rules, free of storage and React Native so
 * they can be tested directly (see services/conversationPanel.ts for the
 * persisted preference and the requests a chat makes of the panel).
 */
export type ConversationPanelTab = 'todos' | 'stream' | 'details';
export const CONVERSATION_PANEL_TABS: { id: ConversationPanelTab; label: string }[] = [
  { id: 'todos', label: 'To-dos' },
  { id: 'stream', label: 'Stream' },
  { id: 'details', label: 'Details' },
];

/** Docked column width, and the least chat width worth keeping beside it. */
export const PANEL_WIDTH = 360;
export const PANEL_MIN_CHAT_WIDTH = 460;

export interface ConversationPanelPrefs { open: boolean; tab: ConversationPanelTab }
export const DEFAULT_PANEL_PREFS: ConversationPanelPrefs = { open: true, tab: 'todos' };

const isTab = (value: unknown): value is ConversationPanelTab => value === 'todos' || value === 'stream' || value === 'details';

export function parsePanelPrefs(raw: string | null | undefined): ConversationPanelPrefs {
  if (!raw) return DEFAULT_PANEL_PREFS;
  try {
    const value = JSON.parse(raw) as Partial<ConversationPanelPrefs> | null;
    return { open: value?.open !== false, tab: isTab(value?.tab) ? value.tab : DEFAULT_PANEL_PREFS.tab };
  } catch {
    return DEFAULT_PANEL_PREFS;
  }
}

/** How the panel sits in the room left after the chat list: beside the chat, or over it. */
export function panelPlacement(availableWidth: number): 'docked' | 'drawer' {
  return availableWidth >= PANEL_MIN_CHAT_WIDTH + PANEL_WIDTH ? 'docked' : 'drawer';
}

/** A header tab button: pressing the tab that is showing hides the panel; any other shows that tab. */
export function nextPanelPrefs(current: ConversationPanelPrefs, pressed: ConversationPanelTab): ConversationPanelPrefs {
  return current.open && current.tab === pressed ? { ...current, open: false } : { open: true, tab: pressed };
}

/** Screen (and browser tab) title for the panel as a phone screen: the open tab, then the chat. */
export function conversationPanelTitle(tab: ConversationPanelTab | undefined, chatTitle: string | undefined): string {
  const label = CONVERSATION_PANEL_TABS.find(item => item.id === (tab ?? 'stream'))?.label ?? 'Stream';
  if (chatTitle) return `${label} · ${chatTitle}`;
  return label === 'Stream' ? 'Chat Stream' : label;
}
