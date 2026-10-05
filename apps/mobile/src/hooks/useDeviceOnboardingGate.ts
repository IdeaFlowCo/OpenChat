import { useEffect, useState } from 'react';
import { hasCompletedOnboarding } from '../services/onboarding';

/** Null blocks authenticated navigation until this auth identity's check settles. */
export function useDeviceOnboardingGate(isAuthed: boolean, userId?: string): boolean | null {
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
  return identity && check?.identity === identity ? check.done : null;
}
