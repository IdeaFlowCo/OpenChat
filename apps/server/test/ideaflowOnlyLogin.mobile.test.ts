import React from 'react';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// OpenChat-3ag.12 / code-xbh.3: on web with Ideaflow ID enabled the login
// screen offers exactly one control, "Sign in with Ideaflow" (Google,
// email/password and sign-up happen on id.ideaflow.app). Legacy methods remain
// only as the kill-switch fallback; native is unchanged.

const mocks = vi.hoisted(() => ({
  platform: { OS: 'web' as string },
  alert: vi.fn(),
  bootstrap: vi.fn(),
  config: { enabled: true } as Record<string, unknown> | 'reject' | 'hang',
  authorizeUrl: 'https://id.ideaflow.app/api/auth/oauth2/authorize?client_id=openchat-web',
  fetch: vi.fn(),
  exchange: vi.fn(),
  linkWithPassword: vi.fn(),
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
  ideaflowExchange: mocks.exchange,
  linkIdeaflowWithPassword: mocks.linkWithPassword,
  IdeaflowPasswordProofRequiredError: class extends Error {
    constructor(public readonly email: string, public readonly linkTicket: string) { super('proof'); }
  },
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
import { IdeaflowPasswordProofRequiredError } from '../../mobile/src/api/client';

let screen: ReturnType<typeof create> | undefined;
let fakeWindow: {
  location: { search: string; pathname: string; origin: string; href: string };
  history: { replaceState: ReturnType<typeof vi.fn> };
  sessionStorage: Map<string, string> & { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void };
  localStorage: Map<string, string> & { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void };
};

function makeStorage() {
  const store = new Map<string, string>() as any;
  store.getItem = (k: string) => (store.has(k) ? store.get(k) : null);
  store.setItem = (k: string, v: string) => { store.set(k, v); };
  store.removeItem = (k: string) => { store.delete(k); };
  return store;
}

const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
/** Presses fire-and-forget async handlers (PKCE digest, fetch), so wait for the effect. */
async function settleUntil(condition: () => boolean, attempts = 50) {
  for (let i = 0; i < attempts && !condition(); i++) await settle();
}

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
    localStorage: makeStorage(),
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
    expect(labels()).not.toContain('Sign in with Ideaflow');
    expect(inputs()).toEqual([]);
    expect(screen!.root.findAll(n => n.props.accessibilityLabel === 'Loading sign-in options').length).toBeGreaterThan(0);
  });

  it('shows exactly one sign-in control, Sign in with Ideaflow, plus the new-account hint', async () => {
    await render();
    await settle();
    expect(labels()).toEqual(['Sign in with Ideaflow']);
    expect(hasText('Sign in with Ideaflow')).toBe(true);
    expect(hasText('New here? You can create an account on the next screen.')).toBe(true);
    expect(inputs()).toEqual([]);
    for (const gone of [
      'Continue with Ideaflow', 'Continue with Google', 'Other sign-in options', 'Use another Ideaflow account',
      "Don't have an account? Create one", 'Create account', 'Uses your Noos credentials', 'Phone sign-in coming soon',
    ]) {
      expect(hasText(gone)).toBe(false);
    }
  });

  it('starts ordinary Ideaflow sign-in without any prompt so SSO stays silent', async () => {
    await render();
    await settle();
    await act(async () => { await button('Sign in with Ideaflow').props.onPress(); });
    await settleUntil(() => fakeWindow.location.href === mocks.authorizeUrl);

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

  it('asks for the Ideaflow account chooser once after an explicit sign-out', async () => {
    fakeWindow.localStorage.setItem('openchat_ideaflow_choose_account', '1');
    await render();
    await settle();
    await act(async () => { await button('Sign in with Ideaflow').props.onPress(); });
    await settleUntil(() => fakeWindow.location.href === mocks.authorizeUrl);

    const starts = requestedUrls().filter(u => u.pathname === '/api/auth/ideaflow/url');
    expect(starts).toHaveLength(1);
    expect(starts[0].searchParams.getAll('prompt')).toEqual(['select_account']);
    expect(fakeWindow.localStorage.getItem('openchat_ideaflow_choose_account')).toBeNull();
  });
});

describe('web Ideaflow failures are visible (RN-web Alert is a no-op)', () => {
  const inlineErrors = () => screen!.root.findAll(n => n.type === 'Text' && n.props.accessibilityRole === 'alert').map(textOf);

  it('shows a stale or mismatched callback inline with fixed copy', async () => {
    fakeWindow.location.search = '?provider=ideaflow&code=c&state=unknown-state';
    await render();
    await settle();
    expect(inlineErrors()).toEqual(['That sign-in took too long or was interrupted. Please try again.']);
    expect(labels()).toEqual(['Sign in with Ideaflow']);
  });

  it('explains a cancelled sign-in without echoing provider text', async () => {
    fakeWindow.sessionStorage.setItem('openchat_ideaflow_web', JSON.stringify({ state: 'S', nonce: 'n', codeVerifier: 'v' }));
    fakeWindow.location.search = '?provider=ideaflow&error=access_denied&error_description=raw+provider+text&state=S';
    await render();
    await settle();
    expect(inlineErrors()).toEqual(['Sign-in was cancelled. You can try again.']);
    expect(hasText('raw provider text')).toBe(false);
  });

  it('shows a start failure inline and clears it on retry', async () => {
    mocks.fetch.mockImplementation(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === '/api/auth/ideaflow/config') return new Response(JSON.stringify({ enabled: true }), { status: 200 });
      return new Response('{}', { status: 502 });
    });
    await render();
    await settle();
    await act(async () => { await button('Sign in with Ideaflow').props.onPress(); });
    await settleUntil(() => inlineErrors().length > 0);
    expect(inlineErrors()).toEqual(["Couldn't reach Ideaflow. Please try again in a moment."]);
    expect(button('Sign in with Ideaflow').props.disabled).toBe(false);
    expect(fakeWindow.location.href).toBe('https://chat.ideaflow.app/app/');
  });
});

describe('password proof before linking an unverified password account (code-xbh.7)', () => {
  async function returnFromIdeaflow() {
    fakeWindow.sessionStorage.setItem('openchat_ideaflow_web', JSON.stringify({ state: 'S', nonce: 'n', codeVerifier: 'v' }));
    fakeWindow.location.search = '?provider=ideaflow&code=c&state=S';
    mocks.exchange.mockRejectedValue(new IdeaflowPasswordProofRequiredError('person@example.test', 'ticket-1'));
    await render();
    await settleUntil(() => labels().includes('Connect account'));
  }

  it('asks for the existing account password instead of signing in or showing legacy options', async () => {
    await returnFromIdeaflow();
    expect(labels()).toEqual(['Connect account', 'Cancel']);
    expect(inputs()).toEqual(['Password for this account']);
    expect(hasText('You already have an OpenChat account for person@example.test')).toBe(true);
    expect(hasText('Continue with Google')).toBe(false);
    expect(mocks.bootstrap).not.toHaveBeenCalled();
  });

  it('links with the password and signs in', async () => {
    mocks.linkWithPassword.mockResolvedValue({ user: {}, token: 't' });
    await returnFromIdeaflow();
    const field = screen!.root.find(n => n.type === 'TextInput');
    await act(async () => { field.props.onChangeText('pw'); });
    await act(async () => { await button('Connect account').props.onPress(); });
    await settleUntil(() => mocks.bootstrap.mock.calls.length > 0);
    expect(mocks.linkWithPassword).toHaveBeenCalledWith('ticket-1', 'person@example.test', 'pw');
    expect(mocks.bootstrap).toHaveBeenCalled();
  });

  it('shows a wrong password inline and keeps the step open; Cancel returns to the single button', async () => {
    mocks.linkWithPassword.mockRejectedValue(new Error("That password didn't work. Please try again."));
    await returnFromIdeaflow();
    const field = screen!.root.find(n => n.type === 'TextInput');
    await act(async () => { field.props.onChangeText('bad'); });
    await act(async () => { await button('Connect account').props.onPress(); });
    await settleUntil(() => hasText("That password didn't work."));
    expect(labels()).toContain('Connect account');
    await act(async () => { button('Cancel').props.onPress(); });
    expect(labels()).toEqual(['Sign in with Ideaflow']);
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
    expect(labels()).not.toContain('Sign in with Ideaflow');
    expect(labels()).not.toContain('Other sign-in options');
    expect(labels()).toContain('Continue with Google');
    expect(inputs()).toEqual(['Email', 'Password']);
    expect(hasText('New here?')).toBe(false);
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
    expect(labels()).not.toContain('Sign in with Ideaflow');
    expect(inputs()).toEqual(['Email', 'Password']);
    expect(hasText('Uses your Noos credentials. Phone sign-in coming soon.')).toBe(true);
  });
});
