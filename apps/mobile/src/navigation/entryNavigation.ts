import { CommonActions } from '@react-navigation/native';
import type { EntryIntent } from '../services/entryIntents';

type EntryNavigationRef = {
  isReady: () => boolean;
  getRootState: () => { index: number; routes: Array<{ name: string }> };
  dispatch: (action: ReturnType<typeof CommonActions.navigate>) => void;
};

/** Route through Main and ChatsTab; entry screens are not root-stack screens. */
export function routeEntryIntentIfReady(
  ref: EntryNavigationRef,
  intent: EntryIntent,
  lastRoutedIntent: { current: string | null },
): boolean {
  if (!ref.isReady() || lastRoutedIntent.current === intent.clientIntentId) return false;
  const root = ref.getRootState();
  // Login and Onboarding can own the root while the intent waits for sign-in.
  if (root.routes[root.index]?.name !== 'Main') return false;

  const target = intent.target;
  const screen = target.kind === 'group' ? 'GroupInvitePreview'
    : target.kind === 'person' ? 'PersonEntry' : 'CardEntry';
  const params = target.kind === 'person' ? { userId: target.userId } : { token: target.token };
  lastRoutedIntent.current = intent.clientIntentId;
  ref.dispatch(CommonActions.navigate({
    name: 'Main',
    params: { screen: 'ChatsTab', params: { screen, params } },
  }));
  return true;
}
