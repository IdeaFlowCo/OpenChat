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
  Linking,
  Platform,
  Share,
} from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import * as Google from 'expo-auth-session/providers/google';
// AuthSession previously used for makeRedirectUri — removed; Google.useAuthRequest
// auto-derives the iOS redirect URI from iosClientId.
import * as WebBrowser from 'expo-web-browser';
import * as AppleAuthentication from 'expo-apple-authentication';
import { useTheme } from '../contexts/ThemeContext';
import { loginWithPassword, registerWithPassword, googleIdTokenExchange, googleExchange, signInWithApple, GOOGLE_CLIENT_ID, GOOGLE_IOS_CLIENT_ID, GOOGLE_ANDROID_CLIENT_ID, OPENCHAT_URL } from '../api/client';
import { getColors } from '../theme/colors';
import { useChat } from '../contexts/ChatContext';

// Required for the in-app browser to dismiss properly after the OAuth round-trip.
WebBrowser.maybeCompleteAuthSession();

// Quick-login test accounts. Only rendered when EXPO_PUBLIC_SHOW_TEST_LOGINS
// is explicitly set to 'true'. Default is OFF so production builds — both EAS
// (iOS TestFlight) AND the openchat-server's web bundles at /m/ and /d/ —
// never accidentally ship the Alice/Bob buttons. Dev/local users who want
// them must set EXPO_PUBLIC_SHOW_TEST_LOGINS=true in their .env or shell.
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
  (process.env.EXPO_PUBLIC_SHOW_TEST_LOGINS ?? 'false').toLowerCase() === 'true';

export function LoginScreen() {
  const { scheme } = useTheme();
  const c = getColors(scheme);
  const { bootstrapIfAuthed } = useChat();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  // 'signin' = existing account; 'register' = create a new account (name+email+password).
  const [mode, setMode] = useState<'signin' | 'register'>('signin');
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [appleLoading, setAppleLoading] = useState(false);

  // Web Google sign-in uses a full-page REDIRECT, not the expo-auth-session
  // popup: Google's pages set Cross-Origin-Opener-Policy, which severs the
  // popup from its opener so window.closed polling never resolves and the
  // flow stalls. See openchat-n9a. Native (iOS) keeps the ID-token flow below.
  const isWeb = Platform.OS === 'web';
  const GOOGLE_WEB_STATE_KEY = 'openchat_google_web';

  // Web: finish the redirect flow when we return from Google with ?code&state.
  useEffect(() => {
    if (!isWeb || typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const returnedState = params.get('state');
    if (!code) return;

    // Strip the OAuth params immediately so a refresh can't replay the code
    // (auth codes are single-use) and the URL stays clean.
    const basePath = `/${window.location.pathname.split('/')[1] || ''}/`;
    window.history.replaceState({}, '', basePath);

    let stored: { state: string; redirectUri: string } | null = null;
    try {
      const raw = window.sessionStorage.getItem(GOOGLE_WEB_STATE_KEY);
      stored = raw ? JSON.parse(raw) : null;
    } catch { stored = null; }
    window.sessionStorage.removeItem(GOOGLE_WEB_STATE_KEY);

    if (!stored || !returnedState || returnedState !== stored.state) {
      Alert.alert('Google sign-in failed', 'Session expired or state mismatch — please try again.');
      return;
    }

    setGoogleLoading(true);
    (async () => {
      try {
        await googleExchange(code, stored!.redirectUri);
        await bootstrapIfAuthed();
      } catch (err) {
        Alert.alert('Google sign-in failed', err instanceof Error ? err.message : String(err));
      } finally {
        setGoogleLoading(false);
      }
    })();
  }, [isWeb, bootstrapIfAuthed]);

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
    androidClientId: GOOGLE_ANDROID_CLIENT_ID, // Android-type client (pkg + SHA-1); falls back to iOS until EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID is set
    webClientId: GOOGLE_CLIENT_ID,
    clientId: GOOGLE_IOS_CLIENT_ID,
    scopes: ['openid', 'email', 'profile'],
    // Native iOS: we want the ID token back. expo-auth-session handles PKCE.
    shouldAutoExchangeCode: true,
    // Always show the account chooser so users can pick/switch Google accounts.
    extraParams: { prompt: 'select_account' },
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

  // Apple Sign-In — iOS only. (OpenChat-c08)
  const handleAppleSignIn = async () => {
    if (appleLoading || googleLoading || loading) return;
    setAppleLoading(true);
    try {
      const cred = await AppleAuthentication.signInAsync({
        requestedScopes: [
          AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
          AppleAuthentication.AppleAuthenticationScope.EMAIL,
        ],
      });
      if (!cred.identityToken) {
        Alert.alert('Apple sign-in failed', 'Apple did not return an identity token.');
        return;
      }
      await signInWithApple(cred.identityToken, cred.fullName, cred.email);
      await bootstrapIfAuthed();
    } catch (err: unknown) {
      // User cancelled — err.code === 'ERR_REQUEST_CANCELED'. Don't alert on cancel.
      const code = (err as { code?: string })?.code;
      if (code !== 'ERR_REQUEST_CANCELED') {
        Alert.alert('Apple sign-in failed', err instanceof Error ? err.message : String(err));
      }
    } finally {
      setAppleLoading(false);
    }
  };

  const handleGoogleSignIn = async () => {
    if (googleLoading || loading) return;

    // Web: full-page redirect via our server's /api/auth/google/url. The
    // server holds the web client_id + secret and echoes our redirect_uri
    // (https://chat.globalbr.ai/m/ or /d/, registered in the GCP OAuth client).
    // On return, the useEffect above finishes the exchange. See openchat-n9a.
    if (isWeb && typeof window !== 'undefined') {
      setGoogleLoading(true);
      try {
        const seg = window.location.pathname.split('/')[1] || '';
        const redirectUri = `${window.location.origin}/${seg}/`;
        const state = (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
          ? crypto.randomUUID()
          : Math.random().toString(36).slice(2);
        const resp = await fetch(
          `${OPENCHAT_URL}/api/auth/google/url?redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(state)}&prompt=select_account`
        );
        if (!resp.ok) throw new Error(`Could not start Google sign-in (${resp.status})`);
        const data = (await resp.json()) as { url: string; state?: string; redirectUri?: string };
        window.sessionStorage.setItem(GOOGLE_WEB_STATE_KEY, JSON.stringify({
          state: data.state || state,
          redirectUri: data.redirectUri || redirectUri,
        }));
        window.location.href = data.url;
      } catch (err) {
        Alert.alert('Google sign-in failed', err instanceof Error ? err.message : String(err));
        setGoogleLoading(false);
      }
      return;
    }

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

  const doRegister = async (n: string, e: string, p: string): Promise<void> => {
    setLoading(true);
    try {
      await registerWithPassword(e.trim(), p, n.trim());
      // Flip auth state in the context — the navigator swaps stacks.
      await bootstrapIfAuthed();
    } catch (err) {
      Alert.alert('Sign-up failed', err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async () => {
    if (mode === 'register') {
      if (!name.trim() || !email || !password) return;
      await doRegister(name, email, password);
    } else {
      if (!email || !password) return;
      await doLogin(email, password);
    }
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

        {/* Sign in with Apple — iOS only. Apple requires SIWA to be at least as prominent
            as any other social login, so it goes ABOVE Google. (OpenChat-c08) */}
        {Platform.OS === 'ios' && (
          appleLoading ? (
            <View style={styles.appleButtonPlaceholder}>
              <ActivityIndicator color="#fff" />
            </View>
          ) : (
            <AppleAuthentication.AppleAuthenticationButton
              buttonType={AppleAuthentication.AppleAuthenticationButtonType.SIGN_IN}
              buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.BLACK}
              cornerRadius={10}
              style={styles.appleButton}
              onPress={handleAppleSignIn}
            />
          )
        )}

        <TouchableOpacity
          style={[
            styles.googleButton,
            { borderColor: c.border, opacity: (googleLoading || loading || (!isWeb && !googleRequest)) ? 0.6 : 1 },
          ]}
          onPress={handleGoogleSignIn}
          disabled={googleLoading || loading || (!isWeb && !googleRequest)}
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

        {mode === 'register' && (
          <TextInput
            style={[styles.input, { backgroundColor: c.surfaceElevated, borderColor: c.border, color: c.textPrimary }]}
            value={name}
            onChangeText={setName}
            placeholder="Your name"
            placeholderTextColor={c.textMuted}
            autoCapitalize="words"
            autoComplete="name"
            editable={!loading}
          />
        )}
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
            <Text style={styles.buttonText}>{mode === 'register' ? 'Create account' : 'Sign In'}</Text>
          )}
        </TouchableOpacity>

        <TouchableOpacity
          onPress={() => setMode(mode === 'register' ? 'signin' : 'register')}
          disabled={loading}
          style={{ marginTop: 14, alignSelf: 'center' }}
        >
          <Text style={{ color: c.primary, fontSize: 14, fontWeight: '600' }}>
            {mode === 'register' ? 'Already have an account? Sign in' : "Don't have an account? Create one"}
          </Text>
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

      {/* Share-the-app QR — only on native (web users don't need it).
          Encodes the mobile web URL so the recipient can open OpenChat
          immediately in their browser without installing. */}
      {Platform.OS !== 'web' && (
        <View style={styles.shareSection}>
          <Text style={[styles.shareLabel, { color: c.textMuted }]}>SHARE OPENCHAT</Text>
          <View style={[styles.shareCard, { backgroundColor: c.surface, borderColor: c.border }]}>
            <View style={styles.qrWrap}>
              {/* Light QR on a fixed white background so it scans reliably
                  regardless of theme. Scanning takes you to the mobile web. */}
              <QRCode value="https://chat.globalbr.ai/m/" size={120} backgroundColor="#ffffff" color="#000000" />
            </View>
            <View style={styles.shareTextBlock}>
              <Text style={[styles.shareTitle, { color: c.textPrimary }]}>Scan to open on any phone</Text>
              <TouchableOpacity
                onPress={() => Linking.openURL('https://chat.globalbr.ai/m/')}
                activeOpacity={0.7}
              >
                <Text style={[styles.shareLink, { color: c.primary }]}>chat.globalbr.ai/m</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => Share.share({ message: 'Try OpenChat: https://chat.globalbr.ai/m/' })}
                activeOpacity={0.7}
                style={[styles.shareButton, { backgroundColor: c.surfaceElevated, borderColor: c.border }]}
              >
                <Text style={[styles.shareButtonText, { color: c.textPrimary }]}>Share link</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      )}
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
  shareSection: { marginTop: 24, alignItems: 'stretch' },
  shareLabel: { fontSize: 11, fontWeight: '700', letterSpacing: 1, marginBottom: 8, textAlign: 'center' },
  shareCard: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 16,
  },
  qrWrap: {
    padding: 6,
    backgroundColor: '#ffffff',
    borderRadius: 8,
  },
  shareTextBlock: { flex: 1, gap: 6 },
  shareTitle: { fontSize: 14, fontWeight: '600' },
  shareLink: { fontSize: 13 },
  shareButton: {
    marginTop: 6,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    alignSelf: 'flex-start',
  },
  shareButtonText: { fontSize: 13, fontWeight: '500' },
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
  // Apple Sign-In button. AppleAuthenticationButton requires an explicit height.
  appleButton: {
    width: '100%',
    height: 48,
    borderRadius: 10,
  },
  // Loading placeholder so the layout doesn't jump while the native sheet opens.
  appleButtonPlaceholder: {
    width: '100%',
    height: 48,
    borderRadius: 10,
    backgroundColor: '#000',
    alignItems: 'center',
    justifyContent: 'center',
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
