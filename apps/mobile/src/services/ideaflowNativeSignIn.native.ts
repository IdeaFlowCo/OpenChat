/**
 * Native (iOS/Android) "Sign in with Ideaflow" (code-xbh.14).
 *
 * Opens the provider in the system auth session — ASWebAuthenticationSession
 * on iOS, Custom Tabs on Android — never an embedded web view, so Google and
 * the provider's own session cookies work. The session is NOT ephemeral, so a
 * person already signed in to Ideaflow ID in the system browser goes straight
 * through (silent SSO).
 *
 * The server holds the confidential web client: it builds the authorization
 * URL, its https callback bounces the native-marked response to
 * openchat://auth/ideaflow/callback, and /api/auth/ideaflow/exchange redeems
 * the code with this app's PKCE verifier and returns an OpenChat session.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import * as WebBrowser from 'expo-web-browser';
import { ideaflowExchange, OPENCHAT_URL } from '../api/client';
import {
  base64ToBase64Url,
  bytesToBase64Url,
  IDEAFLOW_NATIVE_REDIRECT_URI,
  IDEAFLOW_NATIVE_STATE_PREFIX,
  parseIdeaflowNativeCallback,
  startIdeaflowSignIn,
} from './ideaflowSignIn';

const NATIVE_ACCOUNT_CHOICE_KEY = 'openchat_ideaflow_choose_account';

/** After an explicit sign-out the next sign-in asks which account to use. */
export async function markIdeaflowAccountChoiceNative(): Promise<void> {
  try { await AsyncStorage.setItem(NATIVE_ACCOUNT_CHOICE_KEY, '1'); } catch { /* best effort */ }
}

/** Returns true once after an explicit sign-out, then clears the marker. */
export async function takeIdeaflowAccountChoiceNative(): Promise<boolean> {
  try {
    const marked = (await AsyncStorage.getItem(NATIVE_ACCOUNT_CHOICE_KEY)) === '1';
    if (marked) await AsyncStorage.removeItem(NATIVE_ACCOUNT_CHOICE_KEY);
    return marked;
  } catch {
    return false;
  }
}

async function clearIdeaflowAccountChoiceNative(): Promise<void> {
  try { await AsyncStorage.removeItem(NATIVE_ACCOUNT_CHOICE_KEY); } catch { /* best effort */ }
}

const nativePkce = {
  random: (byteLength: number) => bytesToBase64Url(Crypto.getRandomBytes(byteLength)),
  challenge: async (verifier: string) => base64ToBase64Url(
    await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, verifier, {
      encoding: Crypto.CryptoEncoding.BASE64,
    }),
  ),
};

export type IdeaflowNativeResult = 'signed-in' | 'cancelled';

/**
 * Runs the provider round trip and returns the authorization code plus the
 * PKCE secrets, without touching the current OpenChat session. Throws an
 * Error with fixed, readable copy on failure.
 */
export async function authorizeWithIdeaflowNative(options: { selectAccount?: boolean } = {}): Promise<
  | { kind: 'cancelled' }
  | { kind: 'code'; code: string; codeVerifier: string; nonce: string }
> {
  const { url, pending } = await startIdeaflowSignIn(
    OPENCHAT_URL,
    { selectAccount: options.selectAccount === true, statePrefix: IDEAFLOW_NATIVE_STATE_PREFIX },
    nativePkce,
  );
  const result = await WebBrowser.openAuthSessionAsync(url, IDEAFLOW_NATIVE_REDIRECT_URI, {
    // Share the system browser's cookies so an existing Ideaflow ID session
    // (and Google's) is reused instead of asking for credentials every time.
    preferEphemeralSession: false,
  });
  if (result.type !== 'success') return { kind: 'cancelled' };
  const parsed = parseIdeaflowNativeCallback(result.url, pending.state);
  if (parsed.kind === 'error') {
    if (parsed.message.startsWith('Sign-in was cancelled')) return { kind: 'cancelled' };
    throw new Error(parsed.message);
  }
  return { kind: 'code', code: parsed.code, codeVerifier: pending.codeVerifier, nonce: pending.nonce };
}

/**
 * Login-screen sign-in. Sends no prompt (silent SSO) except right after an
 * explicit sign-out, when it asks the provider for its account chooser.
 */
export async function signInWithIdeaflowNative(): Promise<IdeaflowNativeResult> {
  const selectAccount = await takeIdeaflowAccountChoiceNative();
  let authorization: Awaited<ReturnType<typeof authorizeWithIdeaflowNative>>;
  try {
    authorization = await authorizeWithIdeaflowNative({ selectAccount });
  } catch (err) {
    // Keep asking for the chooser next time if this attempt never finished.
    if (selectAccount) await markIdeaflowAccountChoiceNative();
    throw err;
  }
  if (authorization.kind === 'cancelled') {
    if (selectAccount) await markIdeaflowAccountChoiceNative();
    return 'cancelled';
  }
  try {
    await ideaflowExchange(authorization.code, authorization.codeVerifier, authorization.nonce);
  } catch (err) {
    if (selectAccount) await markIdeaflowAccountChoiceNative();
    throw err;
  }
  await clearIdeaflowAccountChoiceNative();
  return 'signed-in';
}
