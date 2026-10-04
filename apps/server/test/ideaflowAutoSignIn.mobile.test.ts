import React from 'react';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// code-xbh.21.1: automatic cross-app sign-in on the OpenChat web app. A
// signed-out visitor makes ONE silent prompt=none round trip per browser
// session; it returns signed in on the same URL, or signed out with no error.

const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

const mocks = vi.hoisted(() => ({
  platform: { OS: 'web' as string },
  alert: vi.fn(),
  bootstrap: vi.fn(),
  exchange: vi.fn(),
  config: { enabled: true, autoSignIn: true } as Record<string, unknown> | 'hang',
  authorizeUrl: 'https://id.ideaflow.app/api/auth/oauth2/authorize?client_id=openchat-web&prompt=none',
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
  ideaflowExchange: mocks.exchange,
  api: {},
}));
vi.mock('../../mobile/src/services/ideaflowNativeSignIn', () => ({ signInWithIdeaflowNative: vi.fn() }));
vi.mock('expo-clipboard', () => ({ getStringAsync: vi.fn() }));
vi.mock('../../mobile/src/utils/parseOpenChatUrl', () => ({ parseOpenChatUrl: vi.fn() }));
vi.mock('../../mobile/src/services/entryIntents', () => ({ createEntryIntent: vi.fn(), saveEntryIntent: vi.fn() }));

import { LoginScreen } from '../../mobile/src/screens/LoginScreen';

type FakeStorage = Map<string, string> & {
  getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void;
};
function makeStorage(): FakeStorage {
  const store = new Map<string, string>() as FakeStorage;
  store.getItem = (k: string) => (store.has(k) ? store.get(k)! : null);
  store.setItem = (k: string, v: string) => { store.set(k, v); };
  store.removeItem = (k: string) => { store.delete(k); };
  return store;
}

let screen: ReturnType<typeof create> | undefined;
let jar: Map<string, string>;
let fakeWindow: {
  location: { search: string; pathname: string; hash: string; origin: string; href: string; replace: ReturnType<typeof vi.fn> };
  history: { replaceState: ReturnType<typeof vi.fn> };
  sessionStorage: FakeStorage;
  localStorage: FakeStorage;
  top?: unknown;
  self?: unknown;
};

const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
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
const signingIn = () => screen!.root.findAll(n => n.type === 'View' && n.props.accessibilityLabel === 'Signing you in').length > 0;
const inlineErrors = () => screen!.root.findAll(n => n.type === 'Text' && n.props.accessibilityRole === 'alert').map(textOf);
const starts = () => mocks.fetch.mock.calls.map(([url]) => new URL(String(url))).filter(u => u.pathname === '/api/auth/ideaflow/url');
const stored = () => JSON.parse(fakeWindow.sessionStorage.getItem('openchat_ideaflow_web') ?? 'null');

function at(path: string) {
  const url = new URL(path, 'https://chat.ideaflow.app');
  Object.assign(fakeWindow.location, { pathname: url.pathname, search: url.search, hash: url.hash, href: url.href });
}

beforeEach(() => {
  vi.clearAllMocks();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.platform.OS = 'web';
  mocks.config = { enabled: true, autoSignIn: true };
  mocks.bootstrap.mockResolvedValue(undefined);
  mocks.exchange.mockResolvedValue({ token: 't' });
  mocks.fetch.mockImplementation(async (input: string) => {
    const url = new URL(input);
    if (url.pathname === '/api/auth/ideaflow/config') {
      if (mocks.config === 'hang') return new Promise(() => {});
      return new Response(JSON.stringify(mocks.config), { status: 200 });
    }
    if (url.pathname === '/api/auth/ideaflow/url') {
      return new Response(JSON.stringify({ url: mocks.authorizeUrl }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  });
  jar = new Map();
  fakeWindow = {
    location: { search: '', pathname: '/app/', hash: '', origin: 'https://chat.ideaflow.app', href: 'https://chat.ideaflow.app/app/', replace: vi.fn() },
    history: { replaceState: vi.fn() },
    sessionStorage: makeStorage(),
    localStorage: makeStorage(),
  };
  fakeWindow.top = fakeWindow;
  fakeWindow.self = fakeWindow;
  vi.stubGlobal('fetch', mocks.fetch);
  vi.stubGlobal('window', fakeWindow);
  vi.stubGlobal('sessionStorage', fakeWindow.sessionStorage);
  vi.stubGlobal('navigator', { userAgent: CHROME, cookieEnabled: true });
  vi.stubGlobal('document', {
    visibilityState: 'visible',
    get cookie() { return [...jar].map(([k, v]) => `${k}=${v}`).join('; '); },
    set cookie(value: string) {
      const [pair] = value.split(';');
      const eq = pair.indexOf('=');
      jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    },
  });
});

afterEach(async () => {
  await act(async () => { screen?.unmount(); });
  screen = undefined;
  vi.unstubAllGlobals();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

describe('automatic sign-in attempt', () => {
  it('makes one silent prompt=none hop with location.replace, remembering the deep link', async () => {
    at('/app/c/abc?x=1#m-9');
    await render();
    expect(signingIn()).toBe(true);
    expect(labels()).toEqual([]);
    await settleUntil(() => fakeWindow.location.replace.mock.calls.length > 0);

    expect(fakeWindow.location.replace).toHaveBeenCalledTimes(1);
    expect(fakeWindow.location.replace).toHaveBeenCalledWith(mocks.authorizeUrl);
    expect(starts()).toHaveLength(1);
    expect(starts()[0].searchParams.getAll('prompt')).toEqual(['none']);
    expect(starts()[0].searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(stored()).toMatchObject({ silent: true, returnTo: '/app/c/abc?x=1#m-9', state: starts()[0].searchParams.get('state') });
    expect(jar.get('ideaflow_auto_signin')).toBe('1');
    expect(signingIn()).toBe(true);
  });

  it('shows the neutral loading state, never the sign-in page, while the server check is pending', async () => {
    mocks.config = 'hang';
    await render();
    await settle();
    expect(signingIn()).toBe(true);
    expect(labels()).toEqual([]);
  });

  it.each([
    ['the attempt was already made this browser session', () => { jar.set('ideaflow_auto_signin', '1'); }],
    ['the person explicitly signed out', () => { fakeWindow.localStorage.setItem('openchat_ideaflow_signed_out', '1'); }],
    ['the account-chooser marker from a sign-out is pending', () => { fakeWindow.localStorage.setItem('openchat_ideaflow_choose_account', '1'); }],
    ['the server kill switch is off', () => { mocks.config = { enabled: true, autoSignIn: false }; }],
    ['an older server does not advertise it', () => { mocks.config = { enabled: true }; }],
    ['Ideaflow sign-in is off', () => { mocks.config = { enabled: false, autoSignIn: true }; }],
    ['the visitor is a crawler', () => { vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (compatible; Googlebot/2.1)', cookieEnabled: true }); }],
    ['the visitor is a link unfurler', () => { vi.stubGlobal('navigator', { userAgent: 'Slackbot-LinkExpanding 1.0', cookieEnabled: true }); }],
    ['the page runs in an in-app browser', () => { vi.stubGlobal('navigator', { userAgent: `${CHROME} Instagram 350.0`, cookieEnabled: true }); }],
    ['the page runs in the desktop shell', () => { (fakeWindow as Record<string, unknown>).__TAURI_INTERNALS__ = {}; }],
    ['the page is in a frame', () => { fakeWindow.top = {}; }],
    ['cookies are blocked', () => { vi.stubGlobal('navigator', { userAgent: CHROME, cookieEnabled: false }); }],
  ])('does not attempt when %s', async (_label, arrange) => {
    arrange();
    await render();
    await settle();
    await settle();
    expect(fakeWindow.location.replace).not.toHaveBeenCalled();
    expect(starts()).toHaveLength(0);
    expect(labels()).toEqual(mocks.config !== 'hang' && (mocks.config as { enabled?: boolean }).enabled === false
      ? expect.arrayContaining(['Continue with Google'])
      : ['Sign in with Ideaflow']);
  });

  it('never attempts on native', async () => {
    mocks.platform.OS = 'ios';
    vi.stubGlobal('window', undefined);
    await render();
    await settle();
    expect(starts()).toHaveLength(0);
    expect(labels()).toContain('Sign in with Ideaflow');
  });
});

describe('returning from the silent attempt', () => {
  const silentRecord = (extra: Record<string, unknown> = {}) => JSON.stringify({
    state: 'S', nonce: 'N', codeVerifier: 'V', silent: true, returnTo: '/app/c/abc?x=1#m-9', ...extra,
  });

  it('login_required: back on the original URL, signed out, no error and no second hop', async () => {
    jar.set('ideaflow_auto_signin', '1');
    fakeWindow.sessionStorage.setItem('openchat_ideaflow_web', silentRecord());
    at('/app/?provider=ideaflow&error=login_required&state=S&iss=https%3A%2F%2Fid.ideaflow.app%2Fapi%2Fauth');
    await render();
    await settle();
    await settle();
    expect(fakeWindow.history.replaceState).toHaveBeenCalledWith({}, '', '/app/c/abc?x=1#m-9');
    expect(inlineErrors()).toEqual([]);
    expect(mocks.alert).not.toHaveBeenCalled();
    expect(mocks.exchange).not.toHaveBeenCalled();
    expect(starts()).toHaveLength(0);
    expect(fakeWindow.location.replace).not.toHaveBeenCalled();
    expect(labels()).toEqual(['Sign in with Ideaflow']);
    expect(stored()).toBeNull();
  });

  it('even if the session cookie was lost, a callback load never starts another hop', async () => {
    fakeWindow.sessionStorage.setItem('openchat_ideaflow_web', silentRecord());
    at('/app/?provider=ideaflow&error=login_required&state=S');
    await render();
    await settle();
    await settle();
    expect(starts()).toHaveLength(0);
    expect(jar.get('ideaflow_auto_signin')).toBe('1');
  });

  it('a code signs in and restores the original URL', async () => {
    fakeWindow.sessionStorage.setItem('openchat_ideaflow_web', silentRecord());
    at('/app/?provider=ideaflow&code=CODE&state=S');
    await render();
    await settleUntil(() => mocks.bootstrap.mock.calls.length > 0);
    expect(mocks.exchange).toHaveBeenCalledWith('CODE', 'V', 'N');
    expect(mocks.bootstrap).toHaveBeenCalledTimes(1);
    expect(fakeWindow.history.replaceState).toHaveBeenCalledWith({}, '', '/app/c/abc?x=1#m-9');
    expect(inlineErrors()).toEqual([]);
  });

  it('shows the neutral state, not the sign-in page, while the silent code is redeemed', async () => {
    mocks.exchange.mockReturnValue(new Promise(() => {}));
    fakeWindow.sessionStorage.setItem('openchat_ideaflow_web', silentRecord());
    at('/app/?provider=ideaflow&code=CODE&state=S');
    await render();
    await settle();
    expect(signingIn()).toBe(true);
    expect(labels()).toEqual([]);
  });

  it.each([
    ['duplicate email (409)', 'This Ideaflow account could not be linked automatically. Contact support@ideaflow.app.'],
    ['a password link step', 'password_proof_required'],
    ['a server error', 'Sign-in failed'],
  ])('%s: returns signed out with no error', async (_label, message) => {
    mocks.exchange.mockRejectedValue(new Error(message));
    fakeWindow.sessionStorage.setItem('openchat_ideaflow_web', silentRecord());
    at('/app/?provider=ideaflow&code=CODE&state=S');
    await render();
    await settleUntil(() => labels().length > 0);
    expect(mocks.exchange).toHaveBeenCalledTimes(1);
    expect(mocks.bootstrap).not.toHaveBeenCalled();
    expect(inlineErrors()).toEqual([]);
    expect(mocks.alert).not.toHaveBeenCalled();
    expect(labels()).toEqual(['Sign in with Ideaflow']);
    expect(fakeWindow.history.replaceState).toHaveBeenCalledWith({}, '', '/app/c/abc?x=1#m-9');
    expect(starts()).toHaveLength(0);
  });

  it('a mismatched state is never redeemed and stays quiet', async () => {
    fakeWindow.sessionStorage.setItem('openchat_ideaflow_web', silentRecord());
    at('/app/?provider=ideaflow&code=CODE&state=FORGED');
    await render();
    await settle();
    expect(mocks.exchange).not.toHaveBeenCalled();
    expect(inlineErrors()).toEqual([]);
  });

  it('an error with no stored state lands on the app, signed out, no error', async () => {
    at('/app/?provider=ideaflow&error=login_required&state=unknown');
    await render();
    await settle();
    expect(fakeWindow.history.replaceState).toHaveBeenCalledWith({}, '', '/app/');
    expect(inlineErrors()).toEqual([]);
    expect(starts()).toHaveLength(0);
  });

  it('never restores an off-site return URL', async () => {
    fakeWindow.sessionStorage.setItem('openchat_ideaflow_web', silentRecord({ returnTo: '//evil.example/' }));
    at('/app/?provider=ideaflow&error=login_required&state=S');
    await render();
    await settle();
    expect(fakeWindow.history.replaceState).toHaveBeenCalledWith({}, '', '/app/');
  });
});

describe('the explicit button keeps its interactive flow', () => {
  it('a cancelled explicit sign-in still shows fixed copy, and spends the automatic attempt', async () => {
    fakeWindow.sessionStorage.setItem('openchat_ideaflow_web', JSON.stringify({ state: 'S', nonce: 'N', codeVerifier: 'V' }));
    at('/app/?provider=ideaflow&error=access_denied&state=S');
    await render();
    await settle();
    await settle();
    expect(inlineErrors()).toEqual(['Sign-in was cancelled. You can try again.']);
    expect(starts()).toHaveLength(0);
    expect(jar.get('ideaflow_auto_signin')).toBe('1');
  });

  it('an explicit exchange failure (409) is still reported', async () => {
    mocks.exchange.mockRejectedValue(new Error('This Ideaflow account could not be linked automatically. Contact support@ideaflow.app.'));
    fakeWindow.sessionStorage.setItem('openchat_ideaflow_web', JSON.stringify({ state: 'S', nonce: 'N', codeVerifier: 'V' }));
    at('/app/?provider=ideaflow&code=CODE&state=S');
    await render();
    await settleUntil(() => inlineErrors().length > 0);
    expect(inlineErrors()).toEqual(['This Ideaflow account could not be linked automatically. Contact support@ideaflow.app.']);
  });

  it('the explicit button remembers the page it was pressed on', async () => {
    jar.set('ideaflow_auto_signin', '1');
    at('/app/i/invite-token?ref=x');
    Object.assign(fakeWindow.location, { href: 'https://chat.ideaflow.app/app/i/invite-token?ref=x' });
    await render();
    await settle();
    const button = screen!.root.find(n => n.type === 'TouchableOpacity' && n.props.accessibilityLabel === 'Sign in with Ideaflow');
    await act(async () => { await button.props.onPress(); });
    await settleUntil(() => fakeWindow.location.href === mocks.authorizeUrl);
    expect(starts()[0].searchParams.has('prompt')).toBe(false);
    expect(stored()).toMatchObject({ returnTo: '/app/i/invite-token?ref=x' });
    expect(stored().silent).toBeUndefined();
  });
});
