import { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { useTheme } from '../contexts/ThemeContext';
import { loginWithPassword } from '../api/client';
import { getColors } from '../theme/colors';
import { useChat } from '../contexts/ChatContext';

// Quick-login test accounts. Only rendered when EXPO_PUBLIC_SHOW_TEST_LOGINS is
// truthy (default 'true' for dev via .env). Production EAS builds set it to
// 'false' so the buttons don't ship. Mirrors the Noos web pattern in
// `~/code/noos/client/src/components/Login.tsx` (the VITE_SHOW_TEST_LOGINS gate).
//
// IMPORTANT: these passwords are PUBLIC test creds — they are intentionally
// committed (alice/bob are seed accounts on production Noos). Never put any
// real-data account here.
type TestAccount = { label: string; email: string; password: string };
const TEST_ACCOUNTS: TestAccount[] = [
  { label: 'Alice', email: 'alice@noos.app', password: 'password123' },
  { label: 'Bob', email: 'bob@noos.app', password: 'password123' },
];
const SHOW_TEST_LOGINS =
  (process.env.EXPO_PUBLIC_SHOW_TEST_LOGINS ?? 'true').toLowerCase() !== 'false';

export function LoginScreen() {
  const { scheme } = useTheme();
  const c = getColors(scheme);
  const { bootstrapIfAuthed } = useChat();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  const doLogin = async (e: string, p: string): Promise<void> => {
    setLoading(true);
    try {
      await loginWithPassword(e.trim(), p);
      // Flip auth state in the context — the navigator swaps stacks.
      await bootstrapIfAuthed();
    } catch (err) {
      Alert.alert('Sign-in failed', err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async () => {
    if (!email || !password) return;
    await doLogin(email, password);
  };

  const handleQuickLogin = async (acct: TestAccount) => {
    if (loading) return;
    await doLogin(acct.email, acct.password);
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={[styles.root, { backgroundColor: c.background }]}
    >
      <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }]}>
        <Text style={[styles.title, { color: c.textPrimary }]}>OpenChat</Text>
        <Text style={[styles.subtitle, { color: c.textSecondary }]}>
          Real-time messaging powered by the Global Brain
        </Text>

        <TextInput
          style={[styles.input, { backgroundColor: c.surfaceElevated, borderColor: c.border, color: c.textPrimary }]}
          value={email}
          onChangeText={setEmail}
          placeholder="Email"
          placeholderTextColor={c.textMuted}
          keyboardType="email-address"
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="email"
          editable={!loading}
        />
        <TextInput
          style={[styles.input, { backgroundColor: c.surfaceElevated, borderColor: c.border, color: c.textPrimary }]}
          value={password}
          onChangeText={setPassword}
          placeholder="Password"
          placeholderTextColor={c.textMuted}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          editable={!loading}
        />

        <TouchableOpacity
          style={[styles.button, { backgroundColor: c.primary, opacity: loading ? 0.6 : 1 }]}
          onPress={handleSubmit}
          disabled={loading}
        >
          {loading ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.buttonText}>Sign In</Text>
          )}
        </TouchableOpacity>

        {SHOW_TEST_LOGINS && (
          <View style={styles.quickLogin}>
            <View style={[styles.divider, { backgroundColor: c.border }]} />
            <Text style={[styles.quickLabel, { color: c.textMuted }]}>Quick login (testing)</Text>
            <View style={styles.quickRow}>
              {TEST_ACCOUNTS.map((acct) => (
                <TouchableOpacity
                  key={acct.email}
                  style={[
                    styles.quickButton,
                    {
                      backgroundColor: c.surfaceElevated,
                      borderColor: c.border,
                      opacity: loading ? 0.6 : 1,
                    },
                  ]}
                  onPress={() => handleQuickLogin(acct)}
                  disabled={loading}
                >
                  <Text style={[styles.quickButtonText, { color: c.textPrimary }]}>{acct.label}</Text>
                  <Text style={[styles.quickButtonSub, { color: c.textMuted }]}>{acct.email}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        )}

        <Text style={[styles.footer, { color: c.textMuted }]}>
          Uses your Noos credentials. Google + phone sign-in coming soon.
        </Text>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, padding: 24, justifyContent: 'center' },
  card: {
    padding: 24,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 12,
  },
  title: { fontSize: 28, fontWeight: '700', textAlign: 'center' },
  subtitle: { fontSize: 14, textAlign: 'center', marginBottom: 12 },
  input: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    fontSize: 16,
  },
  button: {
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
    marginTop: 4,
  },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  footer: { fontSize: 12, textAlign: 'center', marginTop: 8 },
  quickLogin: { marginTop: 4 },
  divider: { height: StyleSheet.hairlineWidth, marginVertical: 12 },
  quickLabel: { fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.6, textAlign: 'center', marginBottom: 10 },
  quickRow: { flexDirection: 'row', gap: 10 },
  quickButton: {
    flex: 1,
    paddingVertical: 10,
    paddingHorizontal: 8,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
  },
  quickButtonText: { fontSize: 15, fontWeight: '600' },
  quickButtonSub: { fontSize: 11, marginTop: 2 },
});
