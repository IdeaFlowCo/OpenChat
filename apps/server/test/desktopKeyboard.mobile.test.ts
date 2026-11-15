import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  platform: { OS: 'web' }, desktop: true,
  navigation: { isReady: () => true, canGoBack: () => true, goBack: vi.fn(), dispatch: vi.fn() },
}));
vi.mock('react-native', () => ({ Platform: mocks.platform }));
vi.mock('@react-navigation/native', () => ({ CommonActions: { navigate: (payload: unknown) => payload } }));
vi.mock('../../mobile/src/navigation/conversationNavigation', () => ({ navigationRef: mocks.navigation }));
vi.mock('../../mobile/src/theme/breakpoints', () => ({ useIsDesktop: () => mocks.desktop }));
import { DesktopKeyboardShortcuts } from '../../mobile/src/components/DesktopKeyboardShortcuts';
import { registerDesktopKeyboardHandler } from '../../mobile/src/services/desktopKeyboard';

let tree: ReactTestRenderer | undefined;
let listeners: Set<(event: KeyboardEvent) => void>;
let captureListener = false;
const disposers: (() => void)[] = [];
beforeEach(() => {
  mocks.platform.OS = 'web'; mocks.desktop = true; vi.clearAllMocks();
  listeners = new Set(); captureListener = false;
  vi.stubGlobal('document', {
    addEventListener: (type: string, handler: (e: KeyboardEvent) => void, capture: boolean) => { if (type === 'keydown') { listeners.add(handler); captureListener = capture; } },
    removeEventListener: (type: string, handler: (e: KeyboardEvent) => void, capture: boolean) => { if (type === 'keydown' && capture === captureListener) listeners.delete(handler); },
  });
});
afterEach(async () => {
  if (tree) await act(async () => tree!.unmount()); tree = undefined;
  disposers.splice(0).forEach(dispose => dispose()); vi.unstubAllGlobals();
});
async function mount(enabled = true) {
  await act(async () => { tree = create(React.createElement(DesktopKeyboardShortcuts, { enabled })); });
}
const finishKey = () => new Promise(resolve => setTimeout(resolve, 0));
function key(value: string, meta = false, isComposing = false) {
  const event = { key: value, metaKey: meta, ctrlKey: false, shiftKey: false, isComposing, defaultPrevented: false, preventDefault: vi.fn(() => { event.defaultPrevented = true; }) };
  listeners.forEach(handler => handler(event as unknown as KeyboardEvent)); return event;
}

it('keeps one shell listener when Chats blurs to Search, so Escape and global shortcuts still work', async () => {
  await mount();
  expect(captureListener).toBe(true); // RN-web inputs stop bubble-phase keydown.
  key('Escape', false, true);
  await finishKey();
  expect(mocks.navigation.goBack).not.toHaveBeenCalled();
  key('k', true, true);
  expect(mocks.navigation.dispatch).not.toHaveBeenCalled();
  const chatHandler = vi.fn(); const blur = registerDesktopKeyboardHandler(chatHandler); disposers.push(blur);
  key('k', true); expect(chatHandler).toHaveBeenCalledTimes(1);
  expect(mocks.navigation.dispatch).not.toHaveBeenCalled(); expect(listeners.size).toBe(1);
  blur(); // Search and the other unwrapped routes have no layout registration.
  const escape = key('Escape');
  await finishKey();
  expect(mocks.navigation.goBack).toHaveBeenCalledTimes(1); expect(escape.preventDefault).toHaveBeenCalled();
  key('k', true);
  expect(mocks.navigation.dispatch).toHaveBeenCalledWith({ name: 'Main', params: { screen: 'ChatsTab', params: { screen: 'Search' } } });
  expect(listeners.size).toBe(1);
});

it('uses only the most recently focused layout and removes the listener on sign-out', async () => {
  await mount(); const chats = vi.fn(), settings = vi.fn();
  disposers.push(registerDesktopKeyboardHandler(chats));
  const blurSettings = registerDesktopKeyboardHandler(settings); disposers.push(blurSettings);
  key('Escape'); await finishKey(); expect(settings).toHaveBeenCalledTimes(1); expect(chats).not.toHaveBeenCalled();
  blurSettings(); key('Escape'); await finishKey(); expect(chats).toHaveBeenCalledTimes(1);
  expect(listeners.size).toBe(1);
  await act(async () => tree!.update(React.createElement(DesktopKeyboardShortcuts, { enabled: false })));
  expect(listeners.size).toBe(0);
});

it('lets local Escape handlers dismiss a picker without navigating away', async () => {
  await mount();
  const event = key('Escape');
  event.preventDefault(); // Local input capture runs after document capture.
  await finishKey();
  expect(mocks.navigation.goBack).not.toHaveBeenCalled();
});

it('cancels a pending Escape when the authenticated shell is disabled', async () => {
  await mount(); key('Escape');
  await act(async () => tree!.update(React.createElement(DesktopKeyboardShortcuts, { enabled: false })));
  await finishKey();
  expect(mocks.navigation.goBack).not.toHaveBeenCalled();
});

it('leaves phone and native keyboard behavior unchanged', async () => {
  mocks.desktop = false; await mount(); expect(listeners.size).toBe(0);
  await act(async () => tree!.unmount()); tree = undefined;
  mocks.desktop = true; mocks.platform.OS = 'ios'; await mount(); expect(listeners.size).toBe(0);
});
