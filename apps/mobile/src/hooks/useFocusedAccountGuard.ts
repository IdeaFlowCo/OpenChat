import { useCallback, useRef } from 'react';
import { useFocusEffect } from '@react-navigation/native';

/** Each asynchronous card/contact action belongs to one account and one visit.
 * Leaving that visit invalidates it, even if the same account returns later. */
export function useFocusedAccountGuard(accountId: string | undefined) {
  const scope = useRef({ accountId, active: false });
  if (scope.current.accountId !== accountId) {
    scope.current.active = false;
    scope.current = { accountId, active: false };
  }
  useFocusEffect(useCallback(() => {
    const visit = { accountId, active: true };
    scope.current = visit;
    return () => { visit.active = false; };
  }, [accountId]));

  return useCallback(() => {
    const visit = scope.current;
    return () => visit.active && !!visit.accountId;
  }, []);
}
