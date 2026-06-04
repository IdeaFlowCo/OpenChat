/**
 * Native push notification service for OpenChat mobile (OpenChat-vg7).
 *
 * Responsibilities:
 *   - Request OS permission to display notifications (iOS prompts; Android 13+ also prompts).
 *   - Fetch the Expo push token (a string like ExponentPushToken[xxxxxxxx]) and
 *     POST it to /api/push/register-native so the server can fan-out messages.
 *   - Install a foreground handler so banners + sounds appear while the app is open,
 *     EXCEPT when the user is already viewing the conversation that the message
 *     belongs to (avoids self-spam).
 *   - Install a response handler so tapping the OS notification navigates to the
 *     right Chat screen.
 *
 * Web platform is a no-op (web push is handled separately via service worker).
 */

import { Platform } from 'react-native';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import { createNavigationContainerRef } from '@react-navigation/native';

import { api } from '../api/client';
import type { RootStackParamList } from '../navigation/types';

// Muted conversations: convId → ISO expiry string (or 'always')
const MUTED_CONVS_KEY = 'openchat_muted_convs';

/** Check whether a conversation is currently muted. */
export async function isConversationMuted(convId: string): Promise<boolean> {
  if (Platform.OS === 'web') return false;
  try {
    const raw = await AsyncStorage.getItem(MUTED_CONVS_KEY);
    if (!raw) return false;
    const map: Record<string, string> = JSON.parse(raw);
    const until = map[convId];
    if (!until) return false;
    if (until === 'always') return true;
    return new Date(until) > new Date();
  } catch {
    return false;
  }
}

/** Synchronously check mute from an already-loaded mute map. */
export function isConversationMutedSync(
  map: Record<string, string>,
  convId: string
): boolean {
  const until = map[convId];
  if (!until) return false;
  if (until === 'always') return true;
  return new Date(until) > new Date();
}

/** Load the full mute map from storage. */
export async function loadMutedConvs(): Promise<Record<string, string>> {
  if (Platform.OS === 'web') return {};
  try {
    const raw = await AsyncStorage.getItem(MUTED_CONVS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

/** Mute a conversation. Pass null to unmute. */
export async function muteConversation(
  convId: string,
  until: Date | 'always' | null
): Promise<void> {
  if (Platform.OS === 'web') return;
  try {
    const raw = await AsyncStorage.getItem(MUTED_CONVS_KEY);
    const map: Record<string, string> = raw ? JSON.parse(raw) : {};
    if (until === null) {
      delete map[convId];
    } else if (until === 'always') {
      map[convId] = 'always';
    } else {
      map[convId] = until.toISOString();
    }
    await AsyncStorage.setItem(MUTED_CONVS_KEY, JSON.stringify(map));
  } catch {
    /* ignore */
  }
}

/**
 * Set the app icon badge count (iOS). No-op on web or Android.
 */
export async function setUnreadBadgeCount(count: number): Promise<void> {
  if (Platform.OS === 'web') return;
  try {
    await Notifications.setBadgeCountAsync(count);
  } catch {
    /* badge not available on all platforms/simulators */
  }
}

const REGISTERED_TOKEN_KEY = 'openchat_native_push_token_registered';

/** Set by App.tsx, used by the tap-handler to navigate. */
export const navigationRef = createNavigationContainerRef<RootStackParamList>();

/**
 * The conversation the user is currently viewing on this device. Used by the
 * foreground handler to suppress redundant banners — if a message arrives for
 * the conv that's already on screen, the in-app UI will show it; we don't need
 * a system banner on top.
 *
 * ChatScreen calls setActiveConversation(id) in its mount effect.
 */
let activeConversationId: string | null = null;
export function getActiveConversationIdForNotifications(): string | null {
  return activeConversationId;
}

export function setActiveConversationForNotifications(id: string | null): void {
  activeConversationId = id;
}

/**
 * Configure the foreground handler. Called once at app boot, BEFORE
 * registerForPushNotificationsAsync, so it's wired before any notifications can
 * arrive. Safe to call on web (Notifications module is a no-op there for
 * setNotificationHandler).
 */
export function configureNotificationHandlers(): void {
  if (Platform.OS === 'web') return;

  Notifications.setNotificationHandler({
    handleNotification: async (notification) => {
      const data = (notification.request.content.data || {}) as { conversationId?: string };
      const convId = data.conversationId;
      const inThisConv = !!convId && convId === activeConversationId;
      // Check mute status — suppress banner/sound if muted.
      const muted = convId ? await isConversationMuted(convId) : false;
      // If the user is already viewing the conversation, suppress the banner +
      // sound (the in-app message:new socket event already updated the UI).
      // We still let it through silently so the system notification center has
      // a record — but no audible/visual alert.
      const suppress = inThisConv || muted;
      return {
        shouldShowBanner: !suppress,
        shouldShowList: !suppress,
        shouldPlaySound: !suppress,
        shouldSetBadge: true,
      };
    },
  });
}

/**
 * Install the tap-response listener. Returns the subscription so the caller
 * can remove it on unmount.
 */
export function addNotificationTapListener(): { remove: () => void } | null {
  if (Platform.OS === 'web') return null;

  const sub = Notifications.addNotificationResponseReceivedListener((response) => {
    const data = (response.notification.request.content.data || {}) as {
      conversationId?: string;
    };
    const conversationId = data.conversationId;
    if (!conversationId) return;
    if (!navigationRef.isReady()) return;
    try {
      navigationRef.navigate('Chat', { conversationId });
    } catch (err) {
      console.warn('[notifications] navigate on tap failed:', err);
    }
  });

  return sub;
}

/**
 * Ask permission, fetch the Expo push token, and register it with the server.
 * Idempotent: caches the last-registered token in AsyncStorage and skips the
 * POST if the freshly-fetched token matches.
 *
 * Returns the token string, or null if permission was denied / device can't
 * receive push (simulators, web).
 */
export async function registerForPushNotificationsAsync(): Promise<string | null> {
  if (Platform.OS === 'web') return null;

  // Push requires a physical device.
  if (!Device.isDevice) {
    console.log('[notifications] skipping push registration on simulator/emulator');
    return null;
  }

  // Check / request permission.
  const settings = await Notifications.getPermissionsAsync();
  let status = settings.status;
  if (status !== 'granted') {
    const req = await Notifications.requestPermissionsAsync({
      ios: {
        allowAlert: true,
        allowBadge: false,
        allowSound: true,
      },
    });
    status = req.status;
  }
  if (status !== 'granted') {
    console.log('[notifications] permission not granted:', status);
    return null;
  }

  // Resolve the EAS project id from app config — getExpoPushTokenAsync needs it
  // on SDK 49+.
  const projectId =
    (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId ||
    (Constants.easConfig as { projectId?: string } | undefined)?.projectId;
  if (!projectId) {
    console.warn('[notifications] no EAS projectId — cannot fetch push token');
    return null;
  }

  let token: string;
  try {
    const t = await Notifications.getExpoPushTokenAsync({ projectId });
    token = t.data;
  } catch (err) {
    console.warn('[notifications] getExpoPushTokenAsync failed:', err);
    return null;
  }

  const platform: 'ios' | 'android' = Platform.OS === 'android' ? 'android' : 'ios';

  // Skip server POST if we've already registered this exact token on this device.
  try {
    const cached = await AsyncStorage.getItem(REGISTERED_TOKEN_KEY);
    if (cached === `${platform}:${token}`) {
      return token;
    }
  } catch {
    /* ignore */
  }

  try {
    await api.registerNativePushToken(token, platform);
    await AsyncStorage.setItem(REGISTERED_TOKEN_KEY, `${platform}:${token}`);
  } catch (err) {
    console.warn('[notifications] register-native failed:', err);
    return token; // we still have the token; just couldn't register it
  }

  return token;
}

/**
 * Best-effort deregister at sign-out so a future user on the same device
 * doesn't keep getting the previous user's push notifications. Failing to
 * deregister is fine — server cleanup will purge on DeviceNotRegistered.
 */
export async function deregisterNativePushToken(): Promise<void> {
  if (Platform.OS === 'web') return;
  const platform: 'ios' | 'android' = Platform.OS === 'android' ? 'android' : 'ios';
  try {
    await api.deregisterNativePushToken(platform);
  } catch (err) {
    console.warn('[notifications] deregister failed:', err);
  } finally {
    try {
      await AsyncStorage.removeItem(REGISTERED_TOKEN_KEY);
    } catch {
      /* ignore */
    }
  }
}
