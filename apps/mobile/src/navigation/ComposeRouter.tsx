import { CommonActions } from '@react-navigation/native';
import { useEffect, useRef } from 'react';
import { navigationRef } from '../services/notifications';
import { clearComposeIntent, loadComposeIntent, onComposeCaptured } from '../services/composeIntents';
export function ComposeRouter({ ready }: { ready: boolean }) {
  const routing = useRef(false);
  useEffect(() => {
    if (!ready) return;
    let active = true;
    const route = async () => {
      if (routing.current || !navigationRef.isReady() || ['Onboarding', 'Login'].includes(navigationRef.getCurrentRoute()?.name || '')) return;
      routing.current = true;
      try {
        const intent = await loadComposeIntent();
        if (active && intent && navigationRef.isReady()) {
          navigationRef.dispatch(CommonActions.navigate({ name: 'Main', params: { screen: 'ChatsTab', params: { screen: 'Compose', params: intent } } }));
          await clearComposeIntent();
        }
      } finally { routing.current = false; }
    };
    const disposers = [navigationRef.addListener('ready', () => void route()), navigationRef.addListener('state', () => void route()), onComposeCaptured(() => void route())];
    void route();
    return () => { active = false; disposers.forEach(dispose => dispose()); };
  }, [ready]);
  return null;
}
