/**
 * App entry. Sets up ChatProvider (the single source of truth for socket +
 * conversations state) and a native-stack navigator with these routes:
 *   Login              → email / password sign-in
 *   Conversations      → list + compose entry point
 *   Chat               → message thread + tappable header
 *   NewConversation    → contact picker (DM or group)
 *   GroupSettings      → rename, members, add, remove, leave
 *
 * The "is the user signed in?" gate is driven by ChatContext.isAuthed, which
 * is hydrated on mount from AsyncStorage and updated by Login / signOut.
 */

import { useEffect } from 'react';
import { ActivityIndicator, StatusBar, StyleSheet, View, useColorScheme } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { NavigationContainer, DefaultTheme, DarkTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';

import { ChatProvider, useChat } from './src/contexts/ChatContext';
import { LoginScreen } from './src/screens/LoginScreen';
import { ConversationsScreen } from './src/screens/ConversationsScreen';
import { ChatScreen } from './src/screens/ChatScreen';
import { NewConversationScreen } from './src/screens/NewConversationScreen';
import { GroupSettingsScreen } from './src/screens/GroupSettingsScreen';
import { getColors } from './src/theme/colors';
import type { RootStackParamList } from './src/navigation/types';

const Stack = createNativeStackNavigator<RootStackParamList>();

function Shell() {
  const scheme = useColorScheme() || 'light';
  const c = getColors(scheme);
  const { isAuthed, bootstrapIfAuthed, currentUser } = useChat();

  useEffect(() => {
    bootstrapIfAuthed();
  }, [bootstrapIfAuthed]);

  // A brief loading splash while we hydrate the auth state from storage.
  // After bootstrapIfAuthed runs, isAuthed flips to true or stays false and
  // the right stack renders.
  const navTheme = scheme === 'dark'
    ? { ...DarkTheme, colors: { ...DarkTheme.colors, background: c.background, card: c.surface, text: c.textPrimary, primary: c.primary, border: c.border } }
    : { ...DefaultTheme, colors: { ...DefaultTheme.colors, background: c.background, card: c.surface, text: c.textPrimary, primary: c.primary, border: c.border } };

  return (
    <NavigationContainer theme={navTheme}>
      <StatusBar
        barStyle={scheme === 'dark' ? 'light-content' : 'dark-content'}
        backgroundColor={c.background}
      />
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
          </>
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}

export default function App() {
  const scheme = useColorScheme() || 'light';
  const c = getColors(scheme);
  return (
    <SafeAreaProvider>
      <View style={[styles.root, { backgroundColor: c.background }]}>
        <ChatProvider>
          <Shell />
        </ChatProvider>
      </View>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  splash: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});

// Suppress unused-import lint for ActivityIndicator (kept for future loading
// states the shell may show before NavigationContainer mounts its theme).
void ActivityIndicator;
