import { CommonActions } from '@react-navigation/native';
import { useEffect } from 'react';
import { navigationRef } from '../services/notifications';
import { consumeComposeIntent, loadPendingComposeIntent, onComposeCaptured } from '../services/composeIntents';
export function ComposeRouter({ ready }: { ready: boolean }) {
  useEffect(() => {
    if (!ready) return;
    let active = true;
    let routing = false;
    let rerouteRequested = false;
    const canRoute = () => navigationRef.isReady() && !['Onboarding', 'Login'].includes(navigationRef.getCurrentRoute()?.name || '');
    const route = async () => {
      if (!active) return;
      if (routing) { rerouteRequested = true; return; }
      if (!canRoute()) return;
      routing = true;
      try {
        do {
          rerouteRequested = false;
          const pending = await loadPendingComposeIntent();
          if (active && pending && canRoute()) {
            navigationRef.dispatch(CommonActions.navigate({ name: 'Main', params: { screen: 'ChatsTab', params: { screen: 'Compose', params: { ...pending.intent, requestRevision: pending.revision } } } }));
            await consumeComposeIntent(pending.revision);
          }
        } while (active && rerouteRequested && canRoute());
      } finally { routing = false; }
    };
    const disposers = [navigationRef.addListener('ready', () => void route()), navigationRef.addListener('state', () => void route()), onComposeCaptured(() => void route())];
    void route();
    return () => { active = false; disposers.forEach(dispose => dispose()); };
  }, [ready]);
  return null;
}
