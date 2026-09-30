import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppRegistry } from 'react-native-web';
import { expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requestReady: false,
  response: null,
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

vi.mock('react-native', async () => {
  const web = await import('react-native-web');
  return { ...web, Platform: { ...web.Platform, OS: 'ios' }, Alert: { alert: mocks.alert } };
});
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


it('renders the pre-login release identifier on a phone-sized product surface', () => {
  mocks.constants.platform = { ios: { buildNumber: '2001' } };
  mocks.updates.isEnabled = true;
  mocks.updates.isEmbeddedLaunch = false;
  mocks.updates.updateId = 'abcd1234-5678-9012-3456-789012345678';
  AppRegistry.registerComponent('LoginEvidence', () => LoginScreen);
  const { element, getStyleElement } = AppRegistry.getApplication('LoginEvidence', {});
  const markup = renderToStaticMarkup(element);
  expect(markup).toContain('v1.0.1 (2001) · update abcd1234');
  expect(markup).toContain('Continue with Google');
  const evidenceDir = process.env.OPENCHAT_LOGIN_EVIDENCE_DIR;
  if (evidenceDir) {
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(join(evidenceDir, 'iphone-login-render.html'), `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${renderToStaticMarkup(getStyleElement())}<style>html,body,#root{height:100%;margin:0}#root{display:flex;max-width:390px;min-height:844px;margin:auto}</style></head><body><div id="root">${markup}</div></body></html>`);
  }
});
