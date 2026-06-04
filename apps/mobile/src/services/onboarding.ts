/**
 * Onboarding helpers (OpenChat-x2s).
 *
 * Tracks per-device onboarding completion in AsyncStorage.
 * The server also receives a `onboardingComplete: true` flag on PATCH /api/auth/me
 * (stored as User.onboardedAt) so returning users on new devices are gracefully
 * handled — but the primary gate is this local flag.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

const ONBOARDING_KEY = 'openchat_onboarding_completed_v1';

/**
 * Returns true if this device has already completed onboarding.
 * Falls back to false on any storage error.
 */
export async function hasCompletedOnboarding(): Promise<boolean> {
  try {
    const val = await AsyncStorage.getItem(ONBOARDING_KEY);
    return val === '1';
  } catch {
    return false;
  }
}

/**
 * Mark onboarding as complete on this device.
 */
export async function markOnboardingComplete(): Promise<void> {
  try {
    await AsyncStorage.setItem(ONBOARDING_KEY, '1');
  } catch {
    /* ignore storage errors — worst case the user sees onboarding again */
  }
}
