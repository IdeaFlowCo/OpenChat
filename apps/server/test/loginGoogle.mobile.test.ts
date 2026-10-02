import React from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requestReady: false,
  response: null as any,
  exchange: vi.fn(),
  bootstrap: vi.fn(),
  authConfig: null as null | { redirectUri?: string; extraParams?: { prompt?: string } },
  prompt: vi.fn(),
  alert: vi.fn(),
  constants: {
    expoConfig: { version: '1.0.1', ios: { buildNumber: '2002' } },
    platform: { ios: { buildNumber: '2001' } } as { ios?: { buildNumber: string | null } } | undefined,
  },
  updates: { isEnabled: false, isEmbeddedLaunch: true, updateId: null as string | null },
}));

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Alert: { alert: mocks.alert },
  Linking: { openURL: vi.fn() },
  Share: { share: vi.fn() },
  View: 'View', Text: 'Text', TextInput: 'TextInput', TouchableOpacity: 'TouchableOpacity',
  KeyboardAvoidingView: 'KeyboardAvoidingView', ScrollView: 'ScrollView', ActivityIndicator: 'ActivityIndicator',
}));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
vi.mock('react-native-qrcode-svg', () => ({ default: () => null }));
vi.mock('expo-auth-session/providers/google', () => ({
  useAuthRequest: (config: { redirectUri?: string; extraParams?: { prompt?: string } }) => {
    mocks.authConfig = config;
    return [mocks.requestReady ? { url: 'https://accounts.google.com/' } : null, mocks.response, mocks.prompt];
  },
}));
vi.mock('expo-web-browser', () => ({ maybeCompleteAuthSession: vi.fn() }));
vi.mock('expo-apple-authentication', () => ({
  AppleAuthenticationButton: 'AppleAuthenticationButton',
  AppleAuthenticationButtonType: { SIGN_IN: 'sign_in' },
  AppleAuthenticationButtonStyle: { BLACK: 'black' },
}));
vi.mock('expo-constants', () => ({
  default: mocks.constants,
}));
vi.mock('expo-updates', () => mocks.updates);
vi.mock('../../mobile/src/contexts/ThemeContext', () => ({ useTheme: () => ({ scheme: 'light' }) }));
vi.mock('../../mobile/src/contexts/ChatContext', () => ({ useChat: () => ({ bootstrapIfAuthed: mocks.bootstrap }) }));
vi.mock('../../mobile/src/contexts/EntryContext', () => ({ useEntryContext: () => ({ entryIntent: null, refreshEntryIntent: vi.fn() }) }));
vi.mock('../../mobile/src/components/EntryHeader', () => ({ EntryHeader: () => null }));
vi.mock('../../mobile/src/api/client', () => ({
  OPENCHAT_URL: 'https://chat.globalbr.ai',
  GOOGLE_CLIENT_ID: 'web.apps.googleusercontent.com',
  GOOGLE_IOS_CLIENT_ID: 'ios.apps.googleusercontent.com',
  GOOGLE_ANDROID_CLIENT_ID: 'android.apps.googleusercontent.com',
  api: {},
  googleIdTokenExchange: mocks.exchange,
}));
vi.mock('expo-clipboard', () => ({ getStringAsync: vi.fn() }));
vi.mock('../../mobile/src/utils/parseOpenChatUrl', () => ({ parseOpenChatUrl: vi.fn() }));
vi.mock('../../mobile/src/services/entryIntents', () => ({ createEntryIntent: vi.fn(), saveEntryIntent: vi.fn() }));

import { LoginScreen } from '../../mobile/src/screens/LoginScreen';

let screen: ReturnType<typeof create> | undefined;
async function render() {
  await act(async () => {
    if (screen) screen.update(React.createElement(LoginScreen));
    else screen = create(React.createElement(LoginScreen));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.requestReady = false;
  mocks.response = null;
  mocks.exchange.mockResolvedValue(undefined);
  mocks.bootstrap.mockResolvedValue(undefined);
  mocks.authConfig = null;
  mocks.constants.platform = { ios: { buildNumber: '2001' } };
  mocks.updates.isEnabled = false;
  mocks.updates.isEmbeddedLaunch = true;
  mocks.updates.updateId = null;
  mocks.prompt.mockResolvedValue({ type: 'dismiss' });
});
afterEach(async () => {
  await act(async () => { screen?.unmount(); });
  screen = undefined;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

describe('iPhone pre-login Google control', () => {
  it('explains an unready request and starts Google when the request becomes ready', async () => {
    await render();
    expect(mocks.authConfig?.redirectUri).toBe('com.googleusercontent.apps.ios:/oauthredirect');
    expect(mocks.authConfig?.extraParams?.prompt).toBe('select_account');
    let button = screen!.root.findByProps({ accessibilityLabel: 'Continue with Google' });
    expect(button.props.disabled).toBe(false);
    await act(async () => { await button.props.onPress(); });
    expect(mocks.alert).toHaveBeenCalledWith('Google sign-in unavailable', expect.stringContaining('still preparing'));
    expect(mocks.prompt).not.toHaveBeenCalled();

    mocks.requestReady = true;
    await render();
    button = screen!.root.findByProps({ accessibilityLabel: 'Continue with Google' });
    await act(async () => { await button.props.onPress(); });
    expect(mocks.prompt).toHaveBeenCalledOnce();
  });

  it('exposes password recovery guidance on native sign-in without issuing a reset', async () => {
    await render();
    const help = screen!.root.findByProps({ accessibilityLabel: 'Forgot password?' });
    expect(help.props.accessibilityState.expanded).toBe(false);
    await act(async () => { help.props.onPress(); });
    expect(screen!.root.findAllByType('Text' as any).some(node =>
      String(node.props.children).includes('existing Noos account'))).toBe(true);
    expect(mocks.exchange).not.toHaveBeenCalled();
    expect(mocks.bootstrap).not.toHaveBeenCalled();
  });

  it('shows the installed binary build on the login screen', async () => {
    await render();
    expect(screen!.root.findByProps({ accessibilityLabel: 'OpenChat version v1.0.1 (2001)' })).toBeDefined();
  });

  it('shows the installed build and update ID when the OTA manifest declares a different build', async () => {
    mocks.updates.isEnabled = true;
    mocks.updates.isEmbeddedLaunch = false;
    mocks.updates.updateId = 'abcd1234-5678-9012-3456-789012345678';
    await render();
    const label = screen!.root.findByProps({ accessibilityLabel: 'OpenChat version v1.0.1 (2001) · update abcd1234' });
    expect(label.props.children).toBe('v1.0.1 (2001) · update abcd1234');
  });

  it.each([undefined, {}, { ios: { buildNumber: null } }])('falls back to the manifest when installed build metadata is unavailable: %j', async platform => {
    mocks.constants.platform = platform;
    await render();
    const label = screen!.root.findByProps({ accessibilityLabel: 'OpenChat version v1.0.1 (2002)' });
    expect(label.props.children).toBe('v1.0.1 (2002)');
  });

  it('shows progress while Google opens and restores the button after dismissal', async () => {
    let resolvePrompt!: (value: { type: string }) => void;
    mocks.prompt.mockReturnValue(new Promise(resolve => { resolvePrompt = resolve; }));
    mocks.requestReady = true;
    await render();

    await act(async () => {
      void screen!.root.findByProps({ accessibilityLabel: 'Continue with Google' }).props.onPress();
    });
    let button = screen!.root.findByProps({ accessibilityLabel: 'Continue with Google' });
    expect(button.props.disabled).toBe(true);
    expect(button.findAllByType('ActivityIndicator' as any)).toHaveLength(1);

    await act(async () => { resolvePrompt({ type: 'dismiss' }); });
    button = screen!.root.findByProps({ accessibilityLabel: 'Continue with Google' });
    expect(button.props.disabled).toBe(false);
  });
});


describe('iPhone Google callback outcomes', () => {
  it.each(['authentication', 'params'])('exchanges the %s ID token and resumes the signed-in app', async source => {
    mocks.requestReady = true;
    await render();
    mocks.response = source === 'authentication'
      ? { type: 'success', authentication: { idToken: 'test-google-id-token' } }
      : { type: 'success', params: { id_token: 'test-google-id-token' } };
    await render();
    expect(mocks.exchange).toHaveBeenCalledExactlyOnceWith('test-google-id-token');
    expect(mocks.bootstrap).toHaveBeenCalledOnce();
    expect(mocks.alert).not.toHaveBeenCalled();
  });

  it('reports a callback without an ID token and never exchanges or bootstraps', async () => {
    mocks.response = { type: 'success', params: {} };
    await render();
    expect(mocks.alert).toHaveBeenCalledWith('Google sign-in failed', 'Google did not return an ID token.');
    expect(mocks.exchange).not.toHaveBeenCalled();
    expect(mocks.bootstrap).not.toHaveBeenCalled();
  });

  it('reports an OAuth error and allows retry', async () => {
    mocks.requestReady = true;
    mocks.response = { type: 'error', error: { message: 'Access was declined' } };
    await render();
    expect(mocks.alert).toHaveBeenCalledWith('Google sign-in failed', 'Access was declined');
    expect(screen!.root.findByProps({ accessibilityLabel: 'Continue with Google' }).props.disabled).toBe(false);
    expect(mocks.exchange).not.toHaveBeenCalled();
  });

  it('reports exchange rejection without entering the signed-in app', async () => {
    mocks.requestReady = true;
    mocks.exchange.mockRejectedValue(new Error('Google sign-in is not enabled for this release'));
    mocks.response = { type: 'success', authentication: { idToken: 'test-google-id-token' } };
    await render();
    expect(mocks.alert).toHaveBeenCalledWith('Google sign-in failed', 'Google sign-in is not enabled for this release');
    expect(mocks.bootstrap).not.toHaveBeenCalled();
    expect(screen!.root.findByProps({ accessibilityLabel: 'Continue with Google' }).props.disabled).toBe(false);
  });

  it('reports browser startup failure and allows retry', async () => {
    mocks.requestReady = true;
    mocks.prompt.mockRejectedValue(new Error('Could not open authentication browser'));
    await render();
    await act(async () => { await screen!.root.findByProps({ accessibilityLabel: 'Continue with Google' }).props.onPress(); });
    expect(mocks.alert).toHaveBeenCalledWith('Google sign-in failed', 'Could not open authentication browser');
    expect(screen!.root.findByProps({ accessibilityLabel: 'Continue with Google' }).props.disabled).toBe(false);
  });
});
