import React from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  storage: new Map<string, string>(), auth: { isAuthed: false, authInitialized: true, currentUser: undefined as undefined | { userId: string; name: string } },
  bootstrap: vi.fn(), dispatch: vi.fn(), profile: vi.fn(), listeners: new Map<string, () => void>(),
  check: undefined as undefined | (() => Promise<string | null>), route: 'Login', replace: undefined as undefined | ((name: string) => void),
}));
vi.mock('react-native', () => ({
  Platform: { OS: 'web', select: (values: any) => values.web ?? values.default }, StatusBar: 'StatusBar', StyleSheet: { create: (v: unknown) => v, hairlineWidth: 1 },
  View: 'View', Text: 'Text', TextInput: 'TextInput', TouchableOpacity: 'TouchableOpacity', Image: 'Image', ActivityIndicator: 'ActivityIndicator', KeyboardAvoidingView: 'KeyboardAvoidingView',
  Dimensions: { get: () => ({ width: 400, height: 800 }) },
  Animated: { View: 'AnimatedView', Value: class { setValue() {} }, timing: () => ({ start: (callback?: () => void) => callback?.() }) },
  useWindowDimensions: () => ({ width: 400, height: 800 }),
}));
vi.mock('react-native-safe-area-context', () => ({ SafeAreaProvider: 'SafeAreaProvider', useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
vi.mock('expo-image-picker', () => ({}));
vi.mock('expo-file-system/legacy', () => ({ FileSystemUploadType: {} }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: {
  getItem: async (key: string) => key === 'openchat_onboarding_completed_v1' && mocks.check ? mocks.check() : mocks.storage.get(key) || null,
  setItem: async (key: string, value: string) => { mocks.storage.set(key, value); }, removeItem: async (key: string) => { mocks.storage.delete(key); },
} }));
vi.mock('@react-navigation/native', () => ({
  createNavigationContainerRef: () => ({}),
  DefaultTheme: { colors: {} }, DarkTheme: { colors: {} }, CommonActions: { navigate: (action: unknown) => action },
  NavigationContainer: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));
vi.mock('@react-navigation/native-stack', () => ({ createNativeStackNavigator: () => ({
  Screen: () => null,
  Navigator: ({ children }: any) => {
    const screens = React.Children.toArray(children).flatMap((child: any) => child.type === React.Fragment ? React.Children.toArray(child.props.children) : [child]).filter(Boolean) as any[];
    const [selected, setSelected] = React.useState(screens[0]?.props.name);
    const route = screens.find(screen => screen.props.name === selected) || screens[0];
    React.useLayoutEffect(() => { if (route && route.props.name !== selected) setSelected(route.props.name); }, [route?.props.name, selected]);
    mocks.route = route?.props.name;
    mocks.replace = (name: string) => { setSelected(name); mocks.route = name; mocks.listeners.get('state')?.(); };
    if (!route) return null;
    return route.props.component ? React.createElement(route.props.component, { navigation: { replace: mocks.replace } }) : route.props.children?.();
  },
}) }));
vi.mock('@react-navigation/bottom-tabs', () => ({ BottomTabBar: () => null, createBottomTabNavigator: () => ({ Navigator: () => null, Screen: () => null }) }));
vi.mock('../../mobile/src/contexts/ThemeContext', () => ({ ThemeProvider: () => null, useTheme: () => ({ scheme: 'light' }) }));
vi.mock('../../mobile/src/contexts/ChatContext', () => ({ ChatProvider: () => null, useChat: () => ({ ...mocks.auth, bootstrapIfAuthed: mocks.bootstrap, updateProfile: mocks.profile }) }));
vi.mock('../../mobile/src/contexts/EntryContext', () => ({ EntryProvider: () => null, useEntryContext: () => ({ entryIntent: null }) }));
vi.mock('../../mobile/src/contexts/RecordingContext', () => ({ RecordingProvider: () => null }));
vi.mock('../../mobile/src/contexts/PrivateNamesContext', () => ({ PrivateNamesProvider: () => null }));
vi.mock('../../mobile/src/contexts/SocialExperienceContext', () => ({ SocialExperienceProvider: () => null, useSocialExperience: () => ({ enhanced: false }) }));
vi.mock('../../mobile/src/navigation/EntryRouter', () => ({ EntryRouter: () => null }));
vi.mock('../../mobile/src/services/notifications', () => ({ configureNotificationHandlers: vi.fn(), addNotificationTapListener: vi.fn(), registerForPushNotificationsAsync: vi.fn(), navigationRef: {
  isReady: () => true, getCurrentRoute: () => ({ name: mocks.route }), dispatch: mocks.dispatch,
  addListener: (name: string, listener: () => void) => { mocks.listeners.set(name, listener); return () => mocks.listeners.delete(name); },
} }));
vi.mock('../../mobile/src/services/deepLinks', () => ({ installDeepLinkHandling: () => () => {} }));
vi.mock('../../mobile/src/services/clientLogger', () => ({ installClientLogger: vi.fn() }));
vi.mock('../../mobile/src/services/crashReporting', () => ({ initCrashReporting: vi.fn() }));
vi.mock('../../mobile/src/api/client', () => ({ api: { updateProfile: mocks.profile } }));
vi.mock('../../mobile/src/components/ErrorBoundary', () => ({ ErrorBoundary: () => null }));
vi.mock('../../mobile/src/components/UpdateBanner', () => ({ UpdateBanner: () => null }));
vi.mock('../../mobile/src/screens/LoginScreen', () => ({ LoginScreen: () => null }));
vi.mock('../../mobile/src/screens/PersonEntryScreen', () => ({ PersonEntryScreen: () => null }));
vi.mock('../../mobile/src/screens/CardEntryScreen', () => ({ CardEntryScreen: () => null }));
vi.mock('../../mobile/src/screens/FriendsScreen', () => ({ FriendsScreen: () => null }));
vi.mock('../../mobile/src/screens/PrivateThingScreen', () => ({ PrivateThingScreen: () => null }));
vi.mock('../../mobile/src/screens/CatchUpScreen', () => ({ CatchUpScreen: () => null }));
vi.mock('../../mobile/src/screens/HomeScreen', () => ({ HomeScreen: () => null }));
vi.mock('../../mobile/src/screens/ChatScreenRouter', () => ({ ChatScreenRouter: () => null }));
vi.mock('../../mobile/src/screens/KeyboardShortcutsScreen', () => ({ KeyboardShortcutsScreen: () => null }));
vi.mock('../../mobile/src/screens/PermissionsScreen', () => ({ PermissionsScreen: () => null }));
vi.mock('../../mobile/src/screens/SecretaryScreen', () => ({ SecretaryScreen: () => null }));
vi.mock('../../mobile/src/screens/NewConversationScreen', () => ({ NewConversationScreen: () => null }));
vi.mock('../../mobile/src/screens/InvitePersonScreen', () => ({ InvitePersonScreen: () => null }));
vi.mock('../../mobile/src/screens/AgentOverlayScreen', () => ({ AgentOverlayScreen: () => null }));
vi.mock('../../mobile/src/screens/GroupSettingsScreen', () => ({ GroupSettingsScreen: () => null }));
vi.mock('../../mobile/src/screens/SettingsScreen', () => ({ SettingsScreen: () => null }));
vi.mock('../../mobile/src/screens/SearchScreen', () => ({ SearchScreen: () => null }));
vi.mock('../../mobile/src/screens/MyCardScreen', () => ({ MyCardScreen: () => null }));
vi.mock('../../mobile/src/screens/ScanQrScreen', () => ({ ScanQrScreen: () => null }));
vi.mock('../../mobile/src/screens/BlockedUsersScreen', () => ({ BlockedUsersScreen: () => null }));
vi.mock('../../mobile/src/screens/ProfileEditScreen', () => ({ ProfileEditScreen: () => null }));
vi.mock('../../mobile/src/screens/GroupInviteScreen', () => ({ GroupInviteScreen: () => null }));
vi.mock('../../mobile/src/screens/GroupInvitePreviewScreen', () => ({ GroupInvitePreviewScreen: () => null }));
vi.mock('../../mobile/src/screens/ForwardPickerScreen', () => ({ ForwardPickerScreen: () => null }));
vi.mock('../../mobile/src/screens/ContactProfileScreen', () => ({ ContactProfileScreen: () => null }));
vi.mock('../../mobile/src/screens/AgentKeysScreen', () => ({ AgentKeysScreen: () => null }));
vi.mock('../../mobile/src/screens/AddAgentKeyScreen', () => ({ AddAgentKeyScreen: () => null }));
vi.mock('../../mobile/src/screens/AgentKeyDetailScreen', () => ({ AgentKeyDetailScreen: () => null }));
vi.mock('../../mobile/src/screens/ThoughtsScreen', () => ({ ThoughtsScreen: () => null }));
vi.mock('../../mobile/src/screens/AddEditThoughtScreen', () => ({ AddEditThoughtScreen: () => null }));
vi.mock('../../mobile/src/screens/ConversationThoughtsScreen', () => ({ ConversationThoughtsScreen: () => null }));
vi.mock('../../mobile/src/screens/AsksScreen', () => ({ AsksScreen: () => null }));
vi.mock('../../mobile/src/screens/StoryComposerScreen', () => ({ StoryComposerScreen: () => null }));
vi.mock('../../mobile/src/screens/StoryViewerScreen', () => ({ StoryViewerScreen: () => null }));
vi.mock('../../mobile/src/screens/SocialReviewScreen', () => ({ SocialReviewScreen: () => null }));
vi.mock('../../mobile/src/components/OfflineBanner', () => ({ OfflineBanner: () => null }));
vi.mock('../../mobile/src/components/InAppMessageBanner', () => ({ InAppMessageBanner: () => null }));
vi.mock('../../mobile/src/components/PushSoftAsk', () => ({ PushSoftAsk: () => null }));
vi.mock('../../mobile/src/components/GlobalRecordingBar', () => ({ GlobalRecordingBar: () => null }));
vi.mock('../../mobile/src/screens/ComposeScreen', () => ({ ComposeScreen: () => null }));
vi.mock('../../mobile/src/screens/OriginalMessageScreen', () => ({ OriginalMessageScreen: () => null }));
vi.mock('../../mobile/src/components/AppIcon', () => ({ AppIcon: () => null }));
import { Shell } from '../../mobile/App';
import { captureComposeIntent, loadPendingComposeIntent } from '../../mobile/src/services/composeIntents';
let root: ReturnType<typeof create> | undefined;
beforeEach(() => { vi.clearAllMocks(); mocks.storage.clear(); mocks.listeners.clear(); mocks.check = undefined; mocks.auth = { isAuthed: false, authInitialized: true, currentUser: undefined }; mocks.route = 'Login'; (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT; });
it('waits after callback, enters real Onboarding, and only replays the same intent after Done replaces Main', async () => {
  const intent = { source: 'unlinked' as const, profile: 'https://www.unlinked.ai/people/public-id' };
  await captureComposeIntent(intent);
  const pending = (await loadPendingComposeIntent())!;
  await act(async () => { root = create(React.createElement(Shell)); });
  let resolve!: (value: string | null) => void;
  mocks.check = () => new Promise(r => { resolve = r; });
  mocks.auth = { isAuthed: true, authInitialized: true, currentUser: { userId: 'new', name: 'Fixture' } };
  await act(async () => root!.update(React.createElement(Shell)));
  expect(mocks.dispatch).not.toHaveBeenCalled();
  expect(root!.root.findAllByType('TouchableOpacity')).toHaveLength(0);
  expect(root!.root.findAllByType('StatusBar')).toHaveLength(0);
  expect((await loadPendingComposeIntent())?.revision).toBe(pending.revision);
  await act(async () => resolve(null));
  expect(mocks.route).toBe('Onboarding'); expect(mocks.dispatch).not.toHaveBeenCalled();
  expect((await loadPendingComposeIntent())?.revision).toBe(pending.revision);
  const press = async (label: string) => act(async () => root!.root.findAllByType('TouchableOpacity').find(node => node.props.accessibilityLabel === label)!.props.onPress());
  await press("Let's go"); await press('Skip'); await press('Done');
  expect(mocks.storage.get('openchat_onboarding_completed_v1')).toBe('1');
  expect(mocks.dispatch).toHaveBeenCalledOnce();
  expect(mocks.dispatch.mock.calls[0][0].params.params.params).toEqual({ ...intent, requestRevision: pending.revision });
});
it('keeps returning-device completion behavior and ignores stale auth checks', async () => {
  let stale!: (value: string | null) => void;
  mocks.check = () => new Promise(r => { stale = r; });
  mocks.auth = { isAuthed: true, authInitialized: true, currentUser: { userId: 'a', name: 'A' } };
  await act(async () => { root = create(React.createElement(Shell)); });
  const completeOld = stale;
  mocks.auth = { isAuthed: false, authInitialized: true, currentUser: undefined };
  await act(async () => root!.update(React.createElement(Shell)));
  mocks.check = async () => '1';
  mocks.auth = { isAuthed: true, authInitialized: true, currentUser: { userId: 'b', name: 'B' } };
  await act(async () => root!.update(React.createElement(Shell)));
  expect(mocks.route).toBe('Main');
  await act(async () => completeOld(null));
  expect(mocks.route).toBe('Main');
});
it('rechecks a signed-out then signed-in same identity instead of reusing prior completion', async () => {
  mocks.check = async () => '1';
  const user = { userId: 'same', name: 'Fixture' };
  mocks.auth = { isAuthed: true, authInitialized: true, currentUser: user };
  await act(async () => { root = create(React.createElement(Shell)); });
  expect(mocks.route).toBe('Main');
  mocks.auth = { isAuthed: false, authInitialized: true, currentUser: undefined };
  await act(async () => root!.update(React.createElement(Shell)));
  expect(mocks.route).toBe('Login');
  let resolve!: (value: string | null) => void;
  mocks.check = () => new Promise(r => { resolve = r; });
  mocks.auth = { isAuthed: true, authInitialized: true, currentUser: user };
  await act(async () => root!.update(React.createElement(Shell)));
  expect(root!.root.findAllByType('StatusBar')).toHaveLength(0);
  await act(async () => resolve(null));
  expect(mocks.route).toBe('Onboarding');
});

it('does not let a pending identity check complete navigation for a different signed-in identity', async () => {
  const intent = { source: 'unlinked' as const, profile: 'https://www.unlinked.ai/people/identity-fixture' };
  await captureComposeIntent(intent);
  const pending = (await loadPendingComposeIntent())!;
  const resolves: Array<(value: string | null) => void> = [];
  mocks.check = () => new Promise(resolve => { resolves.push(resolve); });
  mocks.auth = { isAuthed: true, authInitialized: true, currentUser: { userId: 'old-identity', name: 'Old fixture' } };
  await act(async () => { root = create(React.createElement(Shell)); });
  mocks.auth = { isAuthed: true, authInitialized: true, currentUser: { userId: 'new-identity', name: 'New fixture' } };
  await act(async () => root!.update(React.createElement(Shell)));
  expect(resolves).toHaveLength(2);
  await act(async () => resolves[0]('1'));
  expect(mocks.dispatch).not.toHaveBeenCalled();
  expect((await loadPendingComposeIntent())?.revision).toBe(pending.revision);
  expect(root!.root.findAllByType('StatusBar')).toHaveLength(0);
  await act(async () => resolves[1](null));
  expect(mocks.route).toBe('Onboarding');
  expect(mocks.dispatch).not.toHaveBeenCalled();
  expect((await loadPendingComposeIntent())?.revision).toBe(pending.revision);
});
