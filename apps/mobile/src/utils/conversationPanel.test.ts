import { describe, expect, it } from 'vitest';
import { DEFAULT_PANEL_PREFS, PANEL_MIN_CHAT_WIDTH, PANEL_WIDTH, conversationPanelTitle, nextPanelPrefs, panelPlacement, parsePanelPrefs } from './conversationPanel';

describe('side panel preference', () => {
  it('opens on To-dos the first time and survives a damaged value', () => {
    expect(parsePanelPrefs(null)).toEqual(DEFAULT_PANEL_PREFS);
    expect(parsePanelPrefs('not json')).toEqual(DEFAULT_PANEL_PREFS);
    expect(parsePanelPrefs('null')).toEqual(DEFAULT_PANEL_PREFS);
    expect(parsePanelPrefs('{"open":false,"tab":"links"}')).toEqual({ open: false, tab: 'todos' });
    expect(parsePanelPrefs('{"open":false,"tab":"details"}')).toEqual({ open: false, tab: 'details' });
  });

  it('hides when the showing tab is pressed and switches otherwise', () => {
    expect(nextPanelPrefs({ open: true, tab: 'stream' }, 'stream')).toEqual({ open: false, tab: 'stream' });
    expect(nextPanelPrefs({ open: true, tab: 'stream' }, 'todos')).toEqual({ open: true, tab: 'todos' });
    expect(nextPanelPrefs({ open: false, tab: 'stream' }, 'stream')).toEqual({ open: true, tab: 'stream' });
  });
});

describe('side panel placement', () => {
  it('docks only when the chat keeps a usable width beside it', () => {
    expect(panelPlacement(PANEL_MIN_CHAT_WIDTH + PANEL_WIDTH)).toBe('docked');
    expect(panelPlacement(PANEL_MIN_CHAT_WIDTH + PANEL_WIDTH - 1)).toBe('drawer');
    // A 1440px window with the 320px chat list docks; a 1024px one does not.
    expect(panelPlacement(1440 - 320)).toBe('docked');
    expect(panelPlacement(1024 - 320)).toBe('drawer');
  });
});

describe('panel screen title', () => {
  it('names the open tab first, then the chat', () => {
    expect(conversationPanelTitle(undefined, 'Weekend crew')).toBe('Stream · Weekend crew');
    expect(conversationPanelTitle('todos', 'Weekend crew')).toBe('To-dos · Weekend crew');
    expect(conversationPanelTitle(undefined, undefined)).toBe('Chat Stream');
    expect(conversationPanelTitle('details', undefined)).toBe('Details');
  });
});
