import { useCallback, useEffect, useState } from 'react';
import { hasCompletedOnboarding } from '../services/onboarding';

/** Null blocks authenticated navigation until this auth identity's check settles. */
export function useDeviceOnboardingGate(isAuthed: boolean, userId?: string) {
  const identity = isAuthed ? userId || 'authenticated' : null;
  const [check, setCheck] = useState<{ identity: string; done: boolean } | null>(null);
  useEffect(() => {
    let active = true;
    if (!identity) {
      setCheck(null);
      return () => { active = false; };
    }
    // The storage service deliberately treats failures as incomplete onboarding.
    void hasCompletedOnboarding().then(done => {
      if (active) setCheck({ identity, done });
    });
    return () => { active = false; };
  }, [identity]);
  const complete = useCallback(() => {
    // A late completion must not open navigation for a different auth identity.
    setCheck(previous => previous?.identity === identity ? { ...previous, done: true } : previous);
  }, [identity]);
  return { done: identity && check?.identity === identity ? check.done : null, complete };
}
