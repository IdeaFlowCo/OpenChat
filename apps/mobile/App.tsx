/**
 * App entry. Sets up ThemeProvider + ChatProvider and navigation:
 *
 *   Unauthenticated:
 *     Login  → email / password / Google / Apple sign-in
 *     Onboarding (once, first sign-in)
 *
 *   Authenticated — bottom tabs (OpenChat-zi1):
 *     Chats tab  → Conversations stack (all pre-existing chat screens)
 *     Thoughts tab → Thoughts stack (personal notes feed)
 *
 * The "is the user signed in?" gate is driven by ChatContext.isAuthed.
 */

import { useEffect, useState } from 'react';
import { Platform, StatusBar, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { NavigationContainer, DefaultTheme, DarkTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';

import { ChatProvider, useChat } from './src/contexts/ChatContext';
import { ThemeProvider, useTheme } from './src/contexts/ThemeContext';
import { UpdateBanner } from './src/components/UpdateBanner';
import {
  configureNotificationHandlers,
  addNotificationTapListener,
  navigationRef,
} from './src/services/notifications';
import { installClientLogger } from './src/services/clientLogger';
import { initCrashReporting } from './src/services/crashReporting';
import { hasCompletedOnboarding } from './src/services/onboarding';
// Deep-link router (OpenChat-84u.1) — handles openchat:// scheme + Universal
// Links to chat.globalbr.ai/{i,u}/<id>. Stashes the intent if unauthed so
// post-OAuth replay lands the user on the right screen.
import { installDeepLinkHandling, resumePendingIntent } from './src/services/deepLinks';
import { LoginScreen } from './src/screens/LoginScreen';
import { OnboardingScreen } from './src/screens/OnboardingScreen';

// Init crash reporting FIRST so even early-boot errors reach Sentry (OpenChat-7um).
// No-op if EXPO_PUBLIC_SENTRY_DSN is unset.
initCrashReporting();
// Install the client logger before anything else mounts so even early-boot
// errors are captured (OpenChat-e5v).
installClientLogger();
// HomeScreen replaces a direct ConversationsScreen import at the
// "Conversations" stack key (OpenChat-601). On native + narrow web it
// re-exports ConversationsScreen; on web ≥900px it renders the
// MasterDetailLayout side-by-side view. ChatScreenRouter wraps ChatScreen
// with the same pattern — desktop-web swaps activeConversationId instead
// of pushing a Chat screen.
import { HomeScreen } from './src/screens/HomeScreen';
import { ChatScreenRouter } from './src/screens/ChatScreenRouter';
import { KeyboardShortcutsScreen } from './src/screens/KeyboardShortcutsScreen';
import { PermissionsScreen } from './src/screens/PermissionsScreen';
import { NewConversationScreen } from './src/screens/NewConversationScreen';
import { GroupSettingsScreen } from './src/screens/GroupSettingsScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';
import { SearchScreen } from './src/screens/SearchScreen';
import { MyQrCodeScreen } from './src/screens/MyQrCodeScreen';
import { ScanQrScreen } from './src/screens/ScanQrScreen';
import { BlockedUsersScreen } from './src/screens/BlockedUsersScreen';
import { ProfileEditScreen } from './src/screens/ProfileEditScreen';
import { GroupInviteScreen } from './src/screens/GroupInviteScreen';
import { GroupInvitePreviewScreen } from './src/screens/GroupInvitePreviewScreen';
import { ForwardPickerScreen } from './src/screens/ForwardPickerScreen';
import { ContactProfileScreen } from './src/screens/ContactProfileScreen';
import { AgentKeysScreen } from './src/screens/AgentKeysScreen';
import { AddAgentKeyScreen } from './src/screens/AddAgentKeyScreen';
import { AgentKeyDetailScreen } from './src/screens/AgentKeyDetailScreen';
import { ThoughtsScreen } from './src/screens/ThoughtsScreen';
import { AddEditThoughtScreen } from './src/screens/AddEditThoughtScreen';
import { getColors } from './src/theme/colors';
import { OfflineBanner } from './src/components/OfflineBanner';
import { InAppMessageBanner } from './src/components/InAppMessageBanner';
import { PushSoftAsk } from './src/components/PushSoftAsk';
import type {
  RootStackParamList,
  ThoughtsStackParamList,
  TabParamList,
} from './src/navigation/types';

const ChatsStack = createNativeStackNavigator<RootStackParamList>();
const ThoughtsStack = createNativeStackNavigator<ThoughtsStackParamList>();
const Tab = createBottomTabNavigator<TabParamList>();

// ── Chats stack — all pre-existing chat screens ──────────────────────────────

function ChatsNavigator({ currentUser, c }: {
  currentUser: { email?: string } | null;
  c: ReturnType<typeof getColors>;
}) {
  return (
    <ChatsStack.Navigator
      screenOptions={{
        headerStyle: { backgroundColor: c.surface },
        headerTitleStyle: { color: c.textPrimary },
        headerTintColor: c.primary,
        contentStyle: { backgroundColor: c.background },
      }}
    >
      <ChatsStack.Screen
        name="Conversations"
        component={HomeScreen}
        options={{ title: `Chats${currentUser?.email ? ` · ${currentUser.email}` : ''}` }}
      />
      <ChatsStack.Screen
        name="Chat"
        component={ChatScreenRouter}
        options={{ title: '' /* set dynamically in screen */ }}
      />
      <ChatsStack.Screen
        name="NewConversation"
        component={NewConversationScreen}
        options={{ title: 'New Chat', presentation: 'modal' }}
      />
      <ChatsStack.Screen
        name="GroupSettings"
        component={GroupSettingsScreen}
        options={{ title: 'Group Info' }}
      />
      <ChatsStack.Screen
        name="Settings"
        component={SettingsScreen}
        options={{ title: 'Settings' }}
      />
      <ChatsStack.Screen
        name="Search"
        component={SearchScreen}
        options={{
          title: 'Search',
          // formSheet on iOS = card with dimmed backdrop, swipe-down to
          // dismiss — much lighter than full-screen 'modal'. Matches iOS
          // Settings / Mail / iMessage patterns. On Android falls back to
          // a slide-up sheet via react-navigation; on web it renders like
          // 'modal' (no formSheet support).
          presentation: Platform.OS === 'ios' ? 'formSheet' : 'modal',
        }}
      />
      <ChatsStack.Screen
        name="MyQrCode"
        component={MyQrCodeScreen}
        options={{ title: 'My QR Code', presentation: 'modal' }}
      />
      <ChatsStack.Screen
        name="ScanQr"
        component={ScanQrScreen}
        options={{ title: 'Scan QR', presentation: 'modal', headerShown: false }}
      />
      <ChatsStack.Screen
        name="BlockedUsers"
        component={BlockedUsersScreen}
        options={{ title: 'Blocked users' }}
      />
      <ChatsStack.Screen
        name="ProfileEdit"
        component={ProfileEditScreen}
        options={{ title: 'Edit Profile', presentation: 'modal' }}
      />
      {/* Group invite flow (OpenChat-240) */}
      <ChatsStack.Screen
        name="GroupInvite"
        component={GroupInviteScreen}
        options={{ title: 'Invite to Group', presentation: 'modal' }}
      />
      <ChatsStack.Screen
        name="GroupInvitePreview"
        component={GroupInvitePreviewScreen}
        options={{ title: 'Join Group', presentation: 'modal' }}
      />
      {/* Forward picker (OpenChat-hhc) */}
      <ChatsStack.Screen
        name="ForwardPicker"
        component={ForwardPickerScreen}
        options={{ title: 'Forward to…', presentation: 'modal' }}
      />
      {/* Contact profile — tap DM header to open */}
      <ChatsStack.Screen
        name="ContactProfile"
        component={ContactProfileScreen}
        options={{ title: 'Contact info' }}
      />
      {/* Agent API keys (OpenChat-7c9) */}
      <ChatsStack.Screen
        name="AgentKeys"
        component={AgentKeysScreen}
        options={{ title: 'Agent Keys' }}
      />
      <ChatsStack.Screen
        name="AddAgentKey"
        component={AddAgentKeyScreen}
        options={{ title: 'New Agent Key', presentation: 'modal' }}
      />
      <ChatsStack.Screen
        name="AgentKeyDetail"
        component={AgentKeyDetailScreen}
        options={{ title: 'Key Details' }}
      />
      {/* Desktop keyboard shortcuts cheat-sheet (OpenChat-601). Opens via
          Cmd-/ on the master-detail layout. Native shim returns null. */}
      <ChatsStack.Screen
        name="KeyboardShortcuts"
        component={KeyboardShortcutsScreen}
        options={{ title: 'Keyboard shortcuts', presentation: 'modal' }}
      />
      <ChatsStack.Screen
        name="Permissions"
        component={PermissionsScreen}
        options={{ title: 'Permissions' }}
      />
    </ChatsStack.Navigator>
  );
}

// ── Thoughts stack (OpenChat-zi1) ─────────────────────────────────────────────

function ThoughtsNavigator({ c }: { c: ReturnType<typeof getColors> }) {
  return (
    <ThoughtsStack.Navigator
      screenOptions={{
        headerStyle: { backgroundColor: c.surface },
        headerTitleStyle: { color: c.textPrimary },
        headerTintColor: c.primary,
        contentStyle: { backgroundColor: c.background },
      }}
    >
      <ThoughtsStack.Screen
        name="ThoughtsList"
        component={ThoughtsScreen}
        options={{ title: 'Thoughts' }}
      />
      <ThoughtsStack.Screen
        name="AddEditThought"
        component={AddEditThoughtScreen}
        options={({ route }) =>
          ({
            title: route.params?.thought ? 'Edit Thought' : 'New Thought',
            presentation: 'modal',
          })
        }
      />
    </ThoughtsStack.Navigator>
  );
}

// ── Tab icon helper ────────────────────────────────────────────────────────────
//
// OpenChat-65r: the active tab was nearly indistinguishable from the inactive
// one (a 2-pt icon size bump + grey↔blue tint that's easy to miss on small
// screens / low-contrast displays). The fix layers three signals on the active
// tab so users can tell at a glance which feed they're in:
//   1. Larger, bolder icon (font-weight 700, size 24 vs. 20)
//   2. A soft cobalt-tinted pill background (c.primaryMuted) behind the icon
//   3. Bold label text in the brand cobalt (c.primary)
//
// OpenChat (desktop-ux-audit): on DESKTOP web (≥900px) each tab item is ~half
// the full screen width, so the small centered icon pill from OpenChat-65r is
// a tiny dot floating in a huge tab item — proportionally far weaker than on a
// phone (where the item is half a narrow screen). Two extra signals make the
// active tab unambiguous at any item width:
//   4. A full-item tinted active background (tabBarActiveBackgroundColor on the
//      navigator) — fills the whole wide tab cell, not just a 44px pill.
//   5. A 3px top accent bar (c.primary) on the active item, rendered here as an
//      absolutely-positioned bar so it spans the item regardless of its width.
//      This is the canonical desktop "selected tab" affordance.

const TAB_INDICATOR_HEIGHT = 3;

function TabIcon({ label, focused, color, c }: {
  label: string;
  focused: boolean;
  color: string;
  c: ReturnType<typeof getColors>;
}) {
  return (
    <View
      style={{
        alignItems: 'center',
        justifyContent: 'center',
        minWidth: 44,
        paddingHorizontal: 12,
        paddingVertical: 4,
        borderRadius: 14,
        backgroundColor: focused ? c.primaryMuted : 'transparent',
      }}
    >
      {/* Top accent bar — the desktop-web "selected tab" indicator. Pinned to
          the top of the tab item via a negative offset so it reads as a tab
          underline regardless of how wide the item gets on large screens. */}
      {focused && (
        <View
          pointerEvents="none"
          style={{
            position: 'absolute',
            top: -8,
            left: 0,
            right: 0,
            height: TAB_INDICATOR_HEIGHT,
            borderRadius: TAB_INDICATOR_HEIGHT,
            backgroundColor: c.primary,
          }}
        />
      )}
      <Text
        style={{
          fontSize: focused ? 24 : 20,
          color,
          lineHeight: 28,
          fontWeight: focused ? '700' : '400',
        }}
      >
        {label}
      </Text>
    </View>
  );
}

// Label paired with TabIcon: bold + brand-tint when focused, regular weight
// when inactive. Pulling this out keeps the active-vs-inactive contrast
// consistent across both tabs.
function TabLabel({ text, focused, color }: { text: string; focused: boolean; color: string }) {
  return (
    <Text
      style={{
        fontSize: 12,
        marginTop: 2,
        color,
        fontWeight: focused ? '700' : '500',
        letterSpacing: focused ? 0.2 : 0,
      }}
    >
      {text}
    </Text>
  );
}

// ── Authenticated tab navigator ───────────────────────────────────────────────

function AuthedTabs({
  currentUser,
  c,
}: {
  currentUser: { email?: string } | null;
  c: ReturnType<typeof getColors>;
}) {
  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarStyle: { backgroundColor: c.surface, borderTopColor: c.border },
        // OpenChat-65r: use the brand cobalt (c.primary = #3b82f6) for the
        // active tint — both icon + label inherit it. Inactive uses
        // textSecondary (one step bolder than the old textMuted) so the
        // contrast between focused and unfocused tabs is unambiguous in
        // both light + dark mode.
        tabBarActiveTintColor: c.primary,
        tabBarInactiveTintColor: c.textSecondary,
        tabBarLabelStyle: { fontSize: 12, fontWeight: '500' },
        // NO full-cell tabBarActiveBackgroundColor: the contained icon pill
        // (TabIcon → primaryMuted, borderRadius 14) is the selected affordance.
        // Stacking a full-cell fill ON the pill made the active tab read as a
        // broken doubled blue block on mobile. The pill alone is clean on both
        // mobile + desktop web.
      }}
    >
      <Tab.Screen
        name="ChatsTab"
        options={{
          tabBarLabel: ({ focused, color }) => (
            <TabLabel text="Chats" focused={focused} color={color} />
          ),
          tabBarIcon: ({ focused, color }) => (
            <TabIcon label="💬" focused={focused} color={color} c={c} />
          ),
        }}
      >
        {() => <ChatsNavigator currentUser={currentUser} c={c} />}
      </Tab.Screen>
      <Tab.Screen
        name="ThoughtsTab"
        options={{
          tabBarLabel: ({ focused, color }) => (
            <TabLabel text="Thoughts" focused={focused} color={color} />
          ),
          tabBarIcon: ({ focused, color }) => (
            <TabIcon label="💭" focused={focused} color={color} c={c} />
          ),
        }}
      >
        {() => <ThoughtsNavigator c={c} />}
      </Tab.Screen>
    </Tab.Navigator>
  );
}

// ── Shell — root unauthenticated/onboarding stack + authed tab navigator ─────

// We need a separate root stack for Login + Onboarding. Once authed, the tab
// navigator is shown without a header.
type RootAuthStack = {
  Login: undefined;
  Onboarding: undefined;
  Main: undefined;
};
const RootStack = createNativeStackNavigator<RootAuthStack>();

function Shell() {
  const { scheme } = useTheme();
  const c = getColors(scheme);
  const { isAuthed, bootstrapIfAuthed, currentUser } = useChat();

  // Onboarding gate (OpenChat-x2s): null = not yet checked, true/false = result.
  const [onboardingChecked, setOnboardingChecked] = useState<boolean | null>(null);
  const [onboardingDone, setOnboardingDone] = useState(false);

  useEffect(() => {
    bootstrapIfAuthed();
  }, [bootstrapIfAuthed]);

  // When the user becomes authed, check whether they've completed onboarding.
  // Reset onboardingChecked when the user signs out (isAuthed → false).
  useEffect(() => {
    if (!isAuthed) {
      setOnboardingChecked(null);
      setOnboardingDone(false);
      return;
    }
    hasCompletedOnboarding().then((done) => {
      setOnboardingDone(done);
      setOnboardingChecked(true);
    });
  }, [isAuthed]);

  // Configure notification foreground / tap handlers once at mount.
  useEffect(() => {
    configureNotificationHandlers();
    const sub = addNotificationTapListener();
    return () => { sub?.remove(); };
  }, []);

  // Install deep-link handling (OpenChat-84u.1). Runs once at boot — covers
  // cold-start URLs, running-app URLs (Linking 'url' event), and the web
  // window.location case.
  useEffect(() => {
    const dispose = installDeepLinkHandling();
    return dispose;
  }, []);

  // Resume any pending deep-link intent the moment the user becomes
  // authenticated AND onboarded. Covers the canonical use case: unsigned-in
  // user taps a share/invite link, lands on Login, OAuth → here.
  useEffect(() => {
    if (!isAuthed) return;
    if (onboardingChecked && !onboardingDone) return;
    // Small delay so navigation has a chance to settle.
    const t = setTimeout(() => { void resumePendingIntent(); }, 300);
    return () => clearTimeout(t);
  }, [isAuthed, onboardingChecked, onboardingDone]);

  const baseNav = scheme === 'dark' ? DarkTheme : DefaultTheme;
  const navTheme = {
    ...baseNav,
    colors: {
      ...baseNav.colors,
      background: c.background,
      card: c.surface,
      text: c.textPrimary,
      primary: c.primary,
      border: c.border,
    },
  };

  return (
    <NavigationContainer ref={navigationRef} theme={navTheme}>
      <StatusBar
        barStyle={scheme === 'dark' ? 'light-content' : 'dark-content'}
        backgroundColor={c.background}
      />
      <OfflineBanner />
      <PushSoftAsk isAuthed={isAuthed && onboardingDone} />
      {/* In-app banner for messages arriving in a DIFFERENT conversation.
          Matches iMessage/WhatsApp/Signal pattern — when you're in app but
          not viewing the recipient chat, a small card slides down at the
          top with sender + preview. Tap to switch; swipe up to dismiss. */}
      <InAppMessageBanner />

      <RootStack.Navigator screenOptions={{ headerShown: false }}>
        {!isAuthed ? (
          <RootStack.Screen name="Login" component={LoginScreen} />
        ) : (
          <>
            {/* Show Onboarding if authed but not yet completed. */}
            {isAuthed && onboardingChecked && !onboardingDone ? (
              <RootStack.Screen
                name="Onboarding"
                component={OnboardingScreen}
                options={{ animation: 'fade' }}
              />
            ) : null}
            <RootStack.Screen name="Main">
              {() => <AuthedTabs currentUser={currentUser} c={c} />}
            </RootStack.Screen>
          </>
        )}
      </RootStack.Navigator>
    </NavigationContainer>
  );
}

function ShellWithBackground() {
  const { scheme } = useTheme();
  const c = getColors(scheme);
  return (
    <View style={[styles.root, { backgroundColor: c.background }]}>
      <UpdateBanner />
      <ChatProvider>
        <Shell />
      </ChatProvider>
    </View>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <ShellWithBackground />
      </ThemeProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
});
