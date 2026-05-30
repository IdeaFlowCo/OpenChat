import { useEffect, useState } from 'react';
import { ActivityIndicator, StatusBar, StyleSheet, View, useColorScheme } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { LoginScreen } from './src/screens/LoginScreen';
import { ConversationsScreen } from './src/screens/ConversationsScreen';
import { ChatScreen } from './src/screens/ChatScreen';
import { Conversation, getToken } from './src/api/client';
import { getColors } from './src/theme/colors';

type Screen =
  | { name: 'loading' }
  | { name: 'login' }
  | { name: 'conversations' }
  | { name: 'chat'; conversation: Conversation };

export default function App() {
  const scheme = useColorScheme() || 'light';
  const c = getColors(scheme);
  const [screen, setScreen] = useState<Screen>({ name: 'loading' });

  useEffect(() => {
    (async () => {
      const token = await getToken();
      setScreen(token ? { name: 'conversations' } : { name: 'login' });
    })();
  }, []);

  return (
    <SafeAreaProvider>
      <StatusBar
        barStyle={scheme === 'dark' ? 'light-content' : 'dark-content'}
        backgroundColor={c.background}
      />
      <SafeAreaView style={[styles.root, { backgroundColor: c.background }]} edges={['top', 'bottom', 'left', 'right']}>
        {screen.name === 'loading' && (
          <View style={styles.center}>
            <ActivityIndicator color={c.primary} />
          </View>
        )}
        {screen.name === 'login' && (
          <LoginScreen onSignedIn={() => setScreen({ name: 'conversations' })} />
        )}
        {screen.name === 'conversations' && (
          <ConversationsScreen
            onOpenConversation={(conv) => setScreen({ name: 'chat', conversation: conv })}
            onSignedOut={() => setScreen({ name: 'login' })}
          />
        )}
        {screen.name === 'chat' && (
          <ChatScreen
            conversation={screen.conversation}
            onBack={() => setScreen({ name: 'conversations' })}
          />
        )}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
