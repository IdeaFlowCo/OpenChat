import React from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requestReady: false,
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
    return [mocks.requestReady ? { url: 'https://accounts.google.com/' } : null, null, mocks.prompt];
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
vi.mock('../../mobile/src/contexts/ChatContext', () => ({ useChat: () => ({ bootstrapIfAuthed: vi.fn() }) }));
vi.mock('../../mobile/src/contexts/EntryContext', () => ({ useEntryContext: () => ({ entryIntent: null, refreshEntryIntent: vi.fn() }) }));
vi.mock('../../mobile/src/components/EntryHeader', () => ({ EntryHeader: () => null }));
vi.mock('../../mobile/src/api/client', () => ({
  OPENCHAT_URL: 'https://chat.globalbr.ai',
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
