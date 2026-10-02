import React from 'react';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// OpenChat-3ag.12: "you sign in with Ideaflow". On web with Ideaflow ID enabled
// the login screen offers only Continue with Ideaflow; legacy methods stay
// reachable behind "Other sign-in options"; native is unchanged.

const mocks = vi.hoisted(() => ({
  platform: { OS: 'web' as string },
  alert: vi.fn(),
  bootstrap: vi.fn(),
  config: { enabled: true } as Record<string, unknown> | 'reject' | 'hang',
  authorizeUrl: 'https://id.ideaflow.app/api/auth/oauth2/authorize?client_id=openchat-web',
  fetch: vi.fn(),
}));

vi.mock('react-native', () => ({
  Platform: mocks.platform,
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Alert: { alert: mocks.alert },
  Linking: { openURL: vi.fn() },
  Share: { share: vi.fn() },
  View: 'View', Text: 'Text', TextInput: 'TextInput', TouchableOpacity: 'TouchableOpacity',
  KeyboardAvoidingView: 'KeyboardAvoidingView', ScrollView: 'ScrollView', ActivityIndicator: 'ActivityIndicator',
}));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
vi.mock('react-native-qrcode-svg', () => ({ default: () => null }));
vi.mock('expo-auth-session/providers/google', () => ({ useAuthRequest: () => [null, null, vi.fn()] }));
vi.mock('expo-web-browser', () => ({ maybeCompleteAuthSession: vi.fn() }));
vi.mock('expo-apple-authentication', () => ({
  AppleAuthenticationButton: 'AppleAuthenticationButton',
  AppleAuthenticationButtonType: { SIGN_IN: 'sign_in' },
  AppleAuthenticationButtonStyle: { BLACK: 'black' },
}));
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: '1.0.1' } } }));
vi.mock('expo-updates', () => ({ isEnabled: false, isEmbeddedLaunch: true, updateId: null }));
vi.mock('../../mobile/src/contexts/ThemeContext', () => ({ useTheme: () => ({ scheme: 'light' }) }));
vi.mock('../../mobile/src/contexts/ChatContext', () => ({ useChat: () => ({ bootstrapIfAuthed: mocks.bootstrap }) }));
vi.mock('../../mobile/src/contexts/EntryContext', () => ({ useEntryContext: () => ({ entryIntent: null, refreshEntryIntent: vi.fn() }) }));
vi.mock('../../mobile/src/components/EntryHeader', () => ({ EntryHeader: () => null }));
vi.mock('../../mobile/src/api/client', () => ({
  OPENCHAT_URL: 'https://chat.ideaflow.app',
  GOOGLE_CLIENT_ID: 'web.apps.googleusercontent.com',
  GOOGLE_IOS_CLIENT_ID: 'ios.apps.googleusercontent.com',
  GOOGLE_ANDROID_CLIENT_ID: 'android.apps.googleusercontent.com',
  api: {},
}));
vi.mock('expo-clipboard', () => ({ getStringAsync: vi.fn() }));
vi.mock('../../mobile/src/utils/parseOpenChatUrl', () => ({ parseOpenChatUrl: vi.fn() }));
vi.mock('../../mobile/src/services/entryIntents', () => ({ createEntryIntent: vi.fn(), saveEntryIntent: vi.fn() }));

import { LoginScreen } from '../../mobile/src/screens/LoginScreen';

let screen: ReturnType<typeof create> | undefined;
let fakeWindow: {
  location: { search: string; pathname: string; origin: string; href: string };
  history: { replaceState: ReturnType<typeof vi.fn> };
  sessionStorage: Map<string, string> & { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void };
};

function makeStorage() {
  const store = new Map<string, string>() as any;
  store.getItem = (k: string) => (store.has(k) ? store.get(k) : null);
  store.setItem = (k: string, v: string) => { store.set(k, v); };
  store.removeItem = (k: string) => { store.delete(k); };
  return store;
}

const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });

async function render() {
  await act(async () => { screen = create(React.createElement(LoginScreen)); });
}

function textOf(node: ReactTestInstance): string {
  return node.children.map(c => (typeof c === 'string' ? c : textOf(c))).join('');
}
const labels = () => screen!.root
  .findAll(n => n.type === 'TouchableOpacity' && typeof n.props.accessibilityLabel === 'string')
  .map(n => n.props.accessibilityLabel as string);
const button = (label: string) => screen!.root.find(n => n.type === 'TouchableOpacity' && n.props.accessibilityLabel === label);
const inputs = () => screen!.root.findAll(n => n.type === 'TextInput').map(n => n.props.placeholder);
const hasText = (text: string) => screen!.root.findAll(n => n.type === 'Text' && textOf(n).includes(text)).length > 0;
const requestedUrls = () => mocks.fetch.mock.calls.map(([url]) => new URL(String(url)));

beforeEach(() => {
  vi.clearAllMocks();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.platform.OS = 'web';
  mocks.config = { enabled: true };
  mocks.bootstrap.mockResolvedValue(undefined);
  mocks.fetch.mockImplementation(async (input: string) => {
    const url = new URL(input);
    if (url.pathname === '/api/auth/ideaflow/config') {
      if (mocks.config === 'reject') throw new Error('offline');
      if (mocks.config === 'hang') return new Promise(() => {});
      return new Response(JSON.stringify(mocks.config), { status: 200 });
    }
    if (url.pathname === '/api/auth/ideaflow/url') {
      return new Response(JSON.stringify({ url: mocks.authorizeUrl }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  });
  fakeWindow = {
    location: { search: '', pathname: '/app/', origin: 'https://chat.ideaflow.app', href: 'https://chat.ideaflow.app/app/' },
    history: { replaceState: vi.fn() },
    sessionStorage: makeStorage(),
  };
  vi.stubGlobal('fetch', mocks.fetch);
  vi.stubGlobal('window', fakeWindow);
  vi.stubGlobal('sessionStorage', fakeWindow.sessionStorage);
});

afterEach(async () => {
  await act(async () => { screen?.unmount(); });
  screen = undefined;
  vi.unstubAllGlobals();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

describe('web login with Ideaflow ID enabled', () => {
  it('renders no sign-in method until the capability check resolves, so Google never flashes', async () => {
    mocks.config = 'hang';
    await render();
    expect(labels()).not.toContain('Continue with Google');
    expect(labels()).not.toContain('Continue with Ideaflow');
    expect(inputs()).toEqual([]);
    expect(screen!.root.findAll(n => n.props.accessibilityLabel === 'Loading sign-in options').length).toBeGreaterThan(0);
  });

  it('shows only Continue with Ideaflow plus the secondary links, and drops the outdated footer', async () => {
    await render();
    await settle();
    expect(labels()).toEqual(['Continue with Ideaflow', 'Use another Ideaflow account', 'Other sign-in options']);
    expect(inputs()).toEqual([]);
    expect(hasText('Continue with Google')).toBe(false);
    expect(hasText('Uses your Noos credentials')).toBe(false);
    expect(hasText('Phone sign-in coming soon')).toBe(false);
  });

  it('reveals Google and email/password behind "Other sign-in options" and can hide them again', async () => {
    await render();
    await settle();
    const toggle = button('Other sign-in options');
    expect(toggle.props.accessibilityState).toEqual({ expanded: false });
    await act(async () => { toggle.props.onPress(); });

    expect(labels()).toContain('Continue with Google');
    expect(labels()[0]).toBe('Continue with Ideaflow');
    expect(inputs()).toEqual(['Email', 'Password']);
    expect(hasText("Don't have an account? Create one")).toBe(true);
    expect(hasText('Uses your Noos credentials')).toBe(false);

    await act(async () => { button('Hide other sign-in options').props.onPress(); });
    expect(labels()).not.toContain('Continue with Google');
    expect(inputs()).toEqual([]);
  });

  it('starts ordinary Ideaflow sign-in without any prompt so SSO stays silent', async () => {
    await render();
    await settle();
    await act(async () => { await button('Continue with Ideaflow').props.onPress(); });
    await settle();

    const start = requestedUrls().find(u => u.pathname === '/api/auth/ideaflow/url')!;
    expect(start).toBeDefined();
    expect(start.searchParams.has('prompt')).toBe(false);
    expect(start.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(fakeWindow.location.href).toBe(mocks.authorizeUrl);
    const stored = JSON.parse(fakeWindow.sessionStorage.getItem('openchat_ideaflow_web')!);
    expect(stored.state).toBe(start.searchParams.get('state'));
    expect(stored.nonce).toBe(start.searchParams.get('nonce'));
    expect(stored.codeVerifier).toMatch(/^[A-Za-z0-9_-]{64}$/);
  });

  it('asks for the Ideaflow account chooser only from "Use another Ideaflow account"', async () => {
    await render();
    await settle();
    await act(async () => { await button('Use another Ideaflow account').props.onPress(); });
    await settle();

    const starts = requestedUrls().filter(u => u.pathname === '/api/auth/ideaflow/url');
    expect(starts).toHaveLength(1);
    expect(starts[0].searchParams.getAll('prompt')).toEqual(['select_account']);
    expect(fakeWindow.location.href).toBe(mocks.authorizeUrl);
  });

  it('opens the other options when returning from a legacy Google redirect', async () => {
    fakeWindow.location.search = '?code=google-code&state=s';
    await render();
    await settle();
    expect(labels()).toContain('Continue with Google');
    expect(button('Hide other sign-in options').props.accessibilityState).toEqual({ expanded: true });
  });
});

describe('web Ideaflow failures are visible (RN-web Alert is a no-op)', () => {
  const inlineErrors = () => screen!.root.findAll(n => n.type === 'Text' && n.props.accessibilityRole === 'alert').map(textOf);

  it('shows a stale or mismatched callback inline', async () => {
    fakeWindow.location.search = '?provider=ideaflow&code=c&state=unknown-state';
    await render();
    await settle();
    expect(inlineErrors()).toEqual(['Session expired or state mismatch — please try again.']);
    expect(labels()[0]).toBe('Continue with Ideaflow');
  });

  it('explains a cancelled account choice', async () => {
    fakeWindow.sessionStorage.setItem('openchat_ideaflow_web', JSON.stringify({ state: 'S', nonce: 'n', codeVerifier: 'v' }));
    fakeWindow.location.search = '?provider=ideaflow&error=access_denied&state=S';
    await render();
    await settle();
    expect(inlineErrors()).toEqual(['Sign-in was cancelled. Choose an account to continue.']);
  });

  it('shows a start failure inline and clears it on retry', async () => {
    mocks.fetch.mockImplementation(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/api/auth/ideaflow/config') return new Response(JSON.stringify({ enabled: true }), { status: 200 });
      return new Response('{}', { status: 502 });
    });
    await render();
    await settle();
    await act(async () => { await button('Continue with Ideaflow').props.onPress(); });
    expect(inlineErrors()).toEqual(['Could not start Ideaflow sign-in (502)']);
    expect(button('Continue with Ideaflow').props.disabled).toBe(false);
    expect(fakeWindow.location.href).toBe('https://chat.ideaflow.app/app/');
  });
});

describe('web login when Ideaflow ID is unavailable', () => {
  it.each([
    ['disabled by the server kill switch', { enabled: false }],
    ['unreachable', 'reject'],
  ] as const)('falls back to the legacy methods when %s', async (_label, config) => {
    mocks.config = config as typeof mocks.config;
    await render();
    await settle();
    expect(labels()).not.toContain('Continue with Ideaflow');
    expect(labels()).not.toContain('Other sign-in options');
    expect(labels()).toContain('Continue with Google');
    expect(inputs()).toEqual(['Email', 'Password']);
    expect(hasText('Uses your Noos credentials')).toBe(false);
  });
});

describe('native login is unchanged', () => {
  it.each(['ios', 'android'])('%s keeps Google, email/password and the footer without asking the server', async os => {
    mocks.platform.OS = os;
    vi.stubGlobal('window', undefined);
    await render();
    await settle();
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(labels()).toContain('Continue with Google');
    expect(labels()).not.toContain('Continue with Ideaflow');
    expect(labels()).not.toContain('Other sign-in options');
    expect(labels()).not.toContain('Use another Ideaflow account');
    expect(inputs()).toEqual(['Email', 'Password']);
    expect(hasText('Uses your Noos credentials. Phone sign-in coming soon.')).toBe(true);
  });
});
