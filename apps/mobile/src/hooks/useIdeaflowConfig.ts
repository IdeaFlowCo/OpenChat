import { useEffect, useState } from 'react';
import { OPENCHAT_URL } from '../api/client';
import {
  fetchIdeaflowConfig,
  type IdeaflowConfigState,
} from '../services/ideaflowSignIn';

/**
 * Server-reported Ideaflow ID capability, on web and native (code-xbh.14).
 * The server flag is the rollout source of truth and an immediate kill switch
 * without rebuilding RN-web or shipping a native update: when it is off or
 * unreachable, the login screen falls back to the legacy methods.
 */
export function useIdeaflowConfig(): IdeaflowConfigState {
  const [config, setConfig] = useState<IdeaflowConfigState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    void fetchIdeaflowConfig(OPENCHAT_URL).then(next => {
      if (!cancelled) setConfig(next);
    });
    return () => { cancelled = true; };
  }, []);

  return config;
}
