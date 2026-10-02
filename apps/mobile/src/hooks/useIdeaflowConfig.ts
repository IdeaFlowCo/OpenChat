import { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import { OPENCHAT_URL } from '../api/client';
import {
  fetchIdeaflowConfig,
  IDEAFLOW_CONFIG_DISABLED,
  type IdeaflowConfigState,
} from '../services/ideaflowSignIn';

/**
 * Server-reported Ideaflow ID capability. The server flag is the rollout
 * source of truth and an immediate kill switch without rebuilding RN-web.
 * Native never asks: native Ideaflow sign-in is separate work.
 */
export function useIdeaflowConfig(): IdeaflowConfigState {
  const isWeb = Platform.OS === 'web';
  const [config, setConfig] = useState<IdeaflowConfigState>(
    isWeb ? { status: 'loading' } : IDEAFLOW_CONFIG_DISABLED,
  );

  useEffect(() => {
    if (!isWeb) return;
    let cancelled = false;
    void fetchIdeaflowConfig(OPENCHAT_URL).then(next => {
      if (!cancelled) setConfig(next);
    });
    return () => { cancelled = true; };
  }, [isWeb]);

  return config;
}
