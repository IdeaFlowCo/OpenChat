import { useCallback, useState } from 'react';
import { Alert, Platform } from 'react-native';
import { ideaflowExchange, OPENCHAT_URL } from '../api/client';
import { useChat } from '../contexts/ChatContext';
import { prepareIdeaflowWebSignIn } from '../services/ideaflowSignIn';
import { authorizeWithIdeaflowNative } from '../services/ideaflowNativeSignIn';
import { useIdeaflowConfig } from './useIdeaflowConfig';

/**
 * Signed-in "Switch account" (OpenChat-3ag.12 web, code-xbh.14 native).
 *
 * Web: signs out of OpenChat locally — the same app-local sign-out as
 * "Sign out"; the Ideaflow ID session is untouched per
 * docs/ideaflow-id-migration.md — then starts Ideaflow sign-in with
 * prompt=select_account. The authorization URL is prepared before signing out
 * so a provider outage leaves the person signed in with an error instead of
 * stranded mid-switch.
 *
 * Native: opens the provider's account chooser first, while still signed in.
 * Only when the person picks an account does the app sign out locally and
 * redeem the code; cancelling leaves the current session untouched.
 */
export function useIdeaflowAccountSwitch(): {
  available: boolean;
  switching: boolean;
  switchAccount: () => Promise<void>;
} {
  const { signOut, bootstrapIfAuthed } = useChat();
  const config = useIdeaflowConfig();
  const [switching, setSwitching] = useState(false);
  const isWeb = Platform.OS === 'web';
  const available = config.status === 'ready'
    && config.enabled
    && (!isWeb || typeof window !== 'undefined');

  const switchAccount = useCallback(async () => {
    if (!available || switching) return;
    setSwitching(true);

    if (!isWeb) {
      try {
        const authorization = await authorizeWithIdeaflowNative({ selectAccount: true });
        if (authorization.kind === 'cancelled') return;
        await signOut({ explicit: false });
        await ideaflowExchange(authorization.code, authorization.codeVerifier, authorization.nonce);
        await bootstrapIfAuthed();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        Alert.alert('Could not switch account', message);
      } finally {
        setSwitching(false);
      }
      return;
    }

    let url: string;
    try {
      url = await prepareIdeaflowWebSignIn(OPENCHAT_URL, { selectAccount: true });
    } catch (err) {
      setSwitching(false);
      const message = err instanceof Error ? err.message : String(err);
      // RN-web's Alert.alert is a no-op; the browser dialog keeps this visible.
      if (typeof window.alert === 'function') window.alert(`Could not switch account. ${message}`);
      else Alert.alert('Could not switch account', message);
      return;
    }
    await signOut();
    window.location.assign(url);
  }, [available, switching, isWeb, signOut, bootstrapIfAuthed]);

  return { available, switching, switchAccount };
}
