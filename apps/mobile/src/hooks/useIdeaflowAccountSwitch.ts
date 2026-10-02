import { useCallback, useState } from 'react';
import { Alert, Platform } from 'react-native';
import { OPENCHAT_URL } from '../api/client';
import { useChat } from '../contexts/ChatContext';
import { prepareIdeaflowWebSignIn } from '../services/ideaflowSignIn';
import { useIdeaflowConfig } from './useIdeaflowConfig';

/**
 * Signed-in "Switch account" (OpenChat-3ag.12, web only).
 *
 * Signs out of OpenChat locally — the same app-local sign-out as "Sign out";
 * the Ideaflow ID session is untouched per docs/ideaflow-id-migration.md — and
 * then starts Ideaflow sign-in with prompt=select_account so the provider shows
 * its account chooser instead of silently reusing the current Ideaflow session.
 *
 * The authorization URL is prepared before signing out so a provider outage
 * leaves the person signed in with an error instead of stranded mid-switch.
 */
export function useIdeaflowAccountSwitch(): {
  available: boolean;
  switching: boolean;
  switchAccount: () => Promise<void>;
} {
  const { signOut } = useChat();
  const config = useIdeaflowConfig();
  const [switching, setSwitching] = useState(false);
  const available = Platform.OS === 'web'
    && config.status === 'ready'
    && config.enabled
    && typeof window !== 'undefined';

  const switchAccount = useCallback(async () => {
    if (!available || switching) return;
    setSwitching(true);
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
  }, [available, switching, signOut]);

  return { available, switching, switchAccount };
}
