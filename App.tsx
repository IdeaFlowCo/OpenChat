/**
 * App entry. Sets up ThemeProvider + ChatProvider and a native-stack navigator
 * with these routes:
 *   Login              → email / password sign-in
 *   Conversations      → list + compose entry point
 *   Chat               → message thread + tappable header
 *   NewConversation    → contact picker (DM or group)
 *   GroupSettings      → rename, members, add, remove, leave
 *   Settings           → theme toggle (Light/Dark/System), sign-out
 *
 * The "is the user signed in?" gate is driven by ChatContext.isAuthed.
 */

import { useEffect } from 'react';
import { StatusBar, StyleSheet, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { NavigationContainer, DefaultTheme, DarkTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';

import { ChatProvider, useChat } from './src/contexts/ChatContext';
import { ThemeProvider, useTheme } from './src/contexts/ThemeContext';
import {
  configureNotificationHandlers,
  addNotificationTapListener,
  navigationRef,
} from './src/services/notifications';
import { installClientLogger } from './src/services/clientLogger';
import { initCrashReporting } from './src/services/crashReporting';

// Init crash reporting FIRST so even early-boot errors reach Sentry (OpenChat-7um).
// No-op if EXPO_PUBLIC_SENTRY_DSN is unset.
initCrashReporting();
// Install the client logger before anything else mounts so even early-boot
// errors are captured (OpenChat-e5v).
installClientLogger();
import { LoginScreen } from './src/screens/LoginScreen';
import { ConversationsScreen } from './src/screens/ConversationsScreen';
import { ChatScreen } from './src/screens/ChatScreen';
import { NewConversationScreen } from './src/screens/NewConversationScreen';
import { GroupSettingsScreen } from './src/screens/GroupSettingsScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';
import { SearchScreen } from './src/screens/SearchScreen';
import { MyQrCodeScreen } from './src/screens/MyQrCodeScreen';
import { ScanQrScreen } from './src/screens/ScanQrScreen';
import { getColors } from './src/theme/colors';
import { OfflineBanner } from './src/components/OfflineBanner';
import { PushSoftAsk } from './src/components/PushSoftAsk';
import type { RootStackParamList } from './src/navigation/types';

const Stack = createNativeStackNavigator<RootStackParamList>();

function Shell() {
  const { scheme } = useTheme();
  const c = getColors(scheme);
  const { isAuthed, bootstrapIfAuthed, currentUser } = useChat();

  useEffect(() => {
    bootstrapIfAuthed();
  }, [bootstrapIfAuthed]);

  // Configure notification foreground / tap handlers once at mount. Safe to call
  // on web (no-op there). The tap listener is set up here (vs. inside the
  // signed-in branch) because notifications can arrive while the user is on
  // the Login screen too — we still want the navigator to react if they're
  // signed in by the time they tap. (OpenChat-vg7)
  useEffect(() => {
    configureNotificationHandlers();
    const sub = addNotificationTapListener();
    return () => { sub?.remove(); };
  }, []);

  // Push registration is now triggered by PushSoftAsk (OpenChat-9mo) —
  // the soft-ask card is shown 5s after sign-in and only calls
  // registerForPushNotificationsAsync() when the user taps "Turn on".

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
      <PushSoftAsk isAuthed={isAuthed} />
      <Stack.Navigator
        screenOptions={{
          headerStyle: { backgroundColor: c.surface },
          headerTitleStyle: { color: c.textPrimary },
          headerTintColor: c.primary,
          contentStyle: { backgroundColor: c.background },
        }}
      >
        {!isAuthed ? (
          <Stack.Screen name="Login" component={LoginScreen} options={{ headerShown: false }} />
        ) : (
          <>
            <Stack.Screen
              name="Conversations"
              component={ConversationsScreen}
              options={{ title: `Chats${currentUser ? ` · ${currentUser.email}` : ''}` }}
            />
            <Stack.Screen
              name="Chat"
              component={ChatScreen}
              options={{ title: '' /* set dynamically in screen */ }}
            />
            <Stack.Screen
              name="NewConversation"
              component={NewConversationScreen}
              options={{ title: 'New Chat', presentation: 'modal' }}
            />
            <Stack.Screen
              name="GroupSettings"
              component={GroupSettingsScreen}
              options={{ title: 'Group Info' }}
            />
            <Stack.Screen
              name="Settings"
              component={SettingsScreen}
              options={{ title: 'Settings' }}
            />
            <Stack.Screen
              name="Search"
              component={SearchScreen}
              options={{ title: 'Search', presentation: 'modal' }}
            />
            <Stack.Screen
              name="MyQrCode"
              component={MyQrCodeScreen}
              options={{ title: 'My QR Code', presentation: 'modal' }}
            />
            <Stack.Screen
              name="ScanQr"
              component={ScanQrScreen}
              options={{ title: 'Scan QR', presentation: 'modal', headerShown: false }}
            />
          </>
        )}
      </Stack.Navigator>
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
