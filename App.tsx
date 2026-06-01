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
import { StatusBar, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { NavigationContainer, DefaultTheme, DarkTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';

import { ChatProvider, useChat } from './src/contexts/ChatContext';
import { ThemeProvider, useTheme } from './src/contexts/ThemeContext';
import {
  configureNotificationHandlers,
  addNotificationTapListener,
  navigationRef,
} from './src/services/notifications';
import { installClientLogger } from './src/services/clientLogger';
import { initCrashReporting } from './src/services/crashReporting';
import { hasCompletedOnboarding } from './src/services/onboarding';
import { LoginScreen } from './src/screens/LoginScreen';
import { OnboardingScreen } from './src/screens/OnboardingScreen';
import { ConversationsScreen } from './src/screens/ConversationsScreen';

// Init crash reporting FIRST so even early-boot errors reach Sentry (OpenChat-7um).
// No-op if EXPO_PUBLIC_SENTRY_DSN is unset.
initCrashReporting();
// Install the client logger before anything else mounts so even early-boot
// errors are captured (OpenChat-e5v).
installClientLogger();
import { ChatScreen } from './src/screens/ChatScreen';
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
import { ThoughtsScreen } from './src/screens/ThoughtsScreen';
import { AddEditThoughtScreen } from './src/screens/AddEditThoughtScreen';
import { getColors } from './src/theme/colors';
import { OfflineBanner } from './src/components/OfflineBanner';
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
        component={ConversationsScreen}
        options={{ title: `Chats${currentUser?.email ? ` · ${currentUser.email}` : ''}` }}
      />
      <ChatsStack.Screen
        name="Chat"
        component={ChatScreen}
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
        options={{ title: 'Search', presentation: 'modal' }}
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

function TabIcon({ label, focused, color }: { label: string; focused: boolean; color: string }) {
  return (
    <Text
      style={{
        fontSize: focused ? 22 : 20,
        color,
        lineHeight: 26,
      }}
    >
      {label}
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
        tabBarActiveTintColor: c.primary,
        tabBarInactiveTintColor: c.textMuted,
      }}
    >
      <Tab.Screen
        name="ChatsTab"
        options={{
          tabBarLabel: 'Chats',
          tabBarIcon: ({ focused, color }) => (
            <TabIcon label="💬" focused={focused} color={color} />
          ),
        }}
      >
        {() => <ChatsNavigator currentUser={currentUser} c={c} />}
      </Tab.Screen>
      <Tab.Screen
        name="ThoughtsTab"
        options={{
          tabBarLabel: 'Thoughts',
          tabBarIcon: ({ focused, color }) => (
            <TabIcon label="💭" focused={focused} color={color} />
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
