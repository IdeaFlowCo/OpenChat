import { useEffect, useState } from 'react';
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
import * as Google from 'expo-auth-session/providers/google';
// AuthSession previously used for makeRedirectUri — removed; Google.useAuthRequest
// auto-derives the iOS redirect URI from iosClientId.
import * as WebBrowser from 'expo-web-browser';
import { useTheme } from '../contexts/ThemeContext';
import { loginWithPassword, googleIdTokenExchange, GOOGLE_CLIENT_ID, GOOGLE_IOS_CLIENT_ID } from '../api/client';
import { getColors } from '../theme/colors';
import { useChat } from '../contexts/ChatContext';

// Required for the in-app browser to dismiss properly after the OAuth round-trip.
WebBrowser.maybeCompleteAuthSession();

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
  const [googleLoading, setGoogleLoading] = useState(false);

  // Google OAuth — iOS native flow.
  //
  // Google rejects custom-scheme redirect URIs (com.jacobcole.openchat:/...)
  // on Web-type OAuth clients. So on iOS we use a SEPARATE iOS-type client
  // (GOOGLE_IOS_CLIENT_ID, created 2026-05-31). The iOS flow has no client
  // secret — expo-auth-session uses PKCE and returns the ID token directly.
  // We then POST the ID token to /api/auth/google/idtoken-exchange where
  // the server verifies it against Google's certs and MERGEs the User.
  //
  // CRITICAL — DO NOT pass `redirectUri` here. Google's iOS OAuth client
  // requires the redirect URI to be the reverse-client-id format
  // (com.googleusercontent.apps.874749606899-...:/oauthredirect). The
  // Google.useAuthRequest provider auto-derives this from iosClientId when
  // redirectUri is omitted. Passing our app's custom scheme (openchat:/...)
  // breaks with redirect_uri_mismatch (verified empirically on build 14).
  // The reverse-client-id is registered as a CFBundleURLScheme in app.json
  // so iOS deep-links the callback back to the app correctly.
  //
  // The Web flow (GOOGLE_CLIENT_ID + code + secret + /google/exchange) is
  // still used at chat.globalbr.ai and the RN-web build at /m on web.
  const [googleRequest, googleResponse, promptGoogle] = Google.useAuthRequest({
    iosClientId: GOOGLE_IOS_CLIENT_ID,
    androidClientId: GOOGLE_IOS_CLIENT_ID, // TODO: separate Android client when Android ships
    webClientId: GOOGLE_CLIENT_ID,
    clientId: GOOGLE_IOS_CLIENT_ID,
    scopes: ['openid', 'email', 'profile'],
    // Native iOS: we want the ID token back. expo-auth-session handles PKCE.
    shouldAutoExchangeCode: true,
    // redirectUri intentionally omitted — see comment above.
  });

  useEffect(() => {
    if (!googleResponse) return;
    if (googleResponse.type === 'success') {
      // Either authentication.idToken (when shouldAutoExchangeCode=true on
      // native) or params.id_token (rare implicit fallback) carries the ID
      // token we POST to the server.
      const authResp = googleResponse as unknown as {
        authentication?: { idToken?: string };
        params?: { id_token?: string };
      };
      const idToken = authResp.authentication?.idToken || authResp.params?.id_token;
      if (!idToken) {
        Alert.alert('Google sign-in failed', 'Google did not return an ID token.');
        setGoogleLoading(false);
        return;
      }
      (async () => {
        try {
          await googleIdTokenExchange(idToken);
          await bootstrapIfAuthed();
        } catch (err) {
          Alert.alert(
            'Google sign-in failed',
            err instanceof Error ? err.message : String(err)
          );
        } finally {
          setGoogleLoading(false);
        }
      })();
    } else if (googleResponse.type === 'error') {
      Alert.alert(
        'Google sign-in failed',
        googleResponse.error?.message || 'Google returned an error.'
      );
      setGoogleLoading(false);
    } else {
      // 'cancel' / 'dismiss' / 'locked' — user backed out.
      setGoogleLoading(false);
    }
  }, [googleResponse, bootstrapIfAuthed]);

  const handleGoogleSignIn = async () => {
    if (googleLoading || loading) return;
    if (!googleRequest) {
      Alert.alert('Google sign-in unavailable', 'Sign-in request is not ready yet. Please try again.');
      return;
    }
    setGoogleLoading(true);
    try {
      await promptGoogle();
    } catch (err) {
      Alert.alert('Google sign-in failed', err instanceof Error ? err.message : String(err));
      setGoogleLoading(false);
    }
  };

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

        <TouchableOpacity
          style={[
            styles.googleButton,
            { borderColor: c.border, opacity: (googleLoading || loading || !googleRequest) ? 0.6 : 1 },
          ]}
          onPress={handleGoogleSignIn}
          disabled={googleLoading || loading || !googleRequest}
          accessibilityLabel="Continue with Google"
        >
          {googleLoading ? (
            <ActivityIndicator color="#1f1f1f" />
          ) : (
            <>
              <View style={styles.googleGlyph}>
                <Text style={styles.googleGlyphText}>G</Text>
              </View>
              <Text style={styles.googleButtonText}>Continue with Google</Text>
            </>
          )}
        </TouchableOpacity>

        <View style={styles.orRow}>
          <View style={[styles.orLine, { backgroundColor: c.border }]} />
          <Text style={[styles.orLabel, { color: c.textMuted }]}>or</Text>
          <View style={[styles.orLine, { backgroundColor: c.border }]} />
        </View>

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
          Uses your Noos credentials. Phone sign-in coming soon.
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
  googleButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#ffffff',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 10,
    minHeight: 48,
  },
  googleGlyph: {
    width: 22,
    height: 22,
    borderRadius: 4,
    backgroundColor: '#ffffff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  // The web button uses the multi-color Google "G" SVG. Mobile uses a simple
  // Google-blue glyph as a stand-in — visually close enough without pulling in
  // an SVG dependency.
  googleGlyphText: {
    fontSize: 18,
    fontWeight: '700',
    color: '#4285F4',
    lineHeight: 22,
  },
  googleButtonText: {
    color: '#1f1f1f',
    fontSize: 15,
    fontWeight: '600',
  },
  orRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginVertical: 4,
  },
  orLine: { flex: 1, height: StyleSheet.hairlineWidth },
  orLabel: { fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.6 },
});
