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
  useColorScheme,
} from 'react-native';
import { loginWithPassword } from '../api/client';
import { getColors } from '../theme/colors';

interface Props {
  onSignedIn: () => void;
}

export function LoginScreen({ onSignedIn }: Props) {
  const scheme = useColorScheme() || 'light';
  const c = getColors(scheme);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async () => {
    if (!email || !password) return;
    setLoading(true);
    try {
      await loginWithPassword(email.trim(), password);
      onSignedIn();
    } catch (err) {
      Alert.alert('Sign-in failed', err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
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
});
