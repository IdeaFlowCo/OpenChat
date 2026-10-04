import { useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { OPENCHAT_URL } from '../api/client';
import {
  autoSignInBlockReason,
  currentReturnPath,
  markAutoSignInAttempted,
  readBrowserEnvironment,
} from '../services/ideaflowAutoSignIn';
import { prepareIdeaflowWebSignIn, type IdeaflowConfigState } from '../services/ideaflowSignIn';

/**
 * Automatic cross-app sign-in (code-xbh.21.1), web only. Mounted by the login
 * screen, i.e. after the app's own session check came back signed out.
 *
 * Returns `pending: true` while it is deciding or already leaving for the
 * provider, so the caller renders a neutral loading state instead of flashing
 * the sign-in page. One `location.replace` (Back never bounces through the
 * hop) to the normal Ideaflow start with prompt=none; the once-per-browser-
 * session cookie is set first.
 */
export function useIdeaflowAutoSignIn(config: IdeaflowConfigState): { pending: boolean } {
  // Evaluated on the first render, before the callback handler cleans the URL.
  const [initialSearch] = useState(() => (
    Platform.OS === 'web' && typeof window !== 'undefined' ? window.location?.search ?? '' : ''
  ));
  const [phase, setPhase] = useState<'deciding' | 'leaving' | 'idle'>(() => (
    autoSignInBlockReason(readBrowserEnvironment(Platform.OS, initialSearch)) === null ? 'deciding' : 'idle'
  ));

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (phase !== 'deciding' || config.status === 'loading') return;
    if (!config.enabled || !config.autoSignIn) { setPhase('idle'); return; }
    // Re-check: another tab may have used this session's attempt meanwhile.
    if (autoSignInBlockReason(readBrowserEnvironment(Platform.OS, initialSearch)) !== null
      || !markAutoSignInAttempted()) {
      setPhase('idle');
      return;
    }
    setPhase('leaving');
    void prepareIdeaflowWebSignIn(OPENCHAT_URL, {
      silent: true,
      returnTo: currentReturnPath(window.location),
    }).then(url => {
      if (mounted.current) window.location.replace(url);
    }).catch(() => {
      // Provider or server unreachable: just show the normal sign-in page.
      if (mounted.current) setPhase('idle');
    });
  }, [phase, config, initialSearch]);

  return { pending: phase !== 'idle' };
}
