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
  ScrollView,
  Share,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import QRCode from 'react-native-qrcode-svg';
import * as Google from 'expo-auth-session/providers/google';
import * as WebBrowser from 'expo-web-browser';
import * as AppleAuthentication from 'expo-apple-authentication';
import Constants from 'expo-constants';
import * as Updates from 'expo-updates';
import { useTheme } from '../contexts/ThemeContext';
import { loginWithPassword, registerWithPassword, googleIdTokenExchange, googleExchange, ideaflowExchange, IdeaflowPasswordProofRequiredError, linkIdeaflowWithPassword, signInWithApple, GOOGLE_CLIENT_ID, GOOGLE_IOS_CLIENT_ID, GOOGLE_ANDROID_CLIENT_ID, OPENCHAT_URL, api } from '../api/client';
import { getColors } from '../theme/colors';
import { useChat } from '../contexts/ChatContext';
import { EntryHeader } from '../components/EntryHeader';
import { useEntryContext } from '../contexts/EntryContext';
import * as Clipboard from 'expo-clipboard';
import { parseOpenChatUrl } from '../utils/parseOpenChatUrl';
import { createEntryIntent, saveEntryIntent } from '../services/entryIntents';
import { googleAuthRequestConfig } from '../utils/googleAuthRequest';
import { PasswordRecoveryHelp } from '../components/PasswordRecoveryHelp';
import { useIdeaflowConfig } from '../hooks/useIdeaflowConfig';
import {
  IDEAFLOW_WEB_STATE_KEY,
  ideaflowCallbackErrorMessage,
  loginSurface,
  prepareIdeaflowWebSignIn,
  takeIdeaflowAccountChoice,
} from '../services/ideaflowSignIn';

// Required for the in-app browser to dismiss properly after the OAuth round-trip.
WebBrowser.maybeCompleteAuthSession();

// Quick-login test accounts. Only rendered when EXPO_PUBLIC_SHOW_TEST_LOGINS
// is explicitly set to 'true'. Default is OFF so production builds — both EAS
// (iOS compatibility builds) and the server's canonical /app/ RN-web bundle —
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
  const insets = useSafeAreaInsets();
  const appVersion = Constants.expoConfig?.version;
  const buildNumber = Platform.OS === 'ios'
    ? Constants.platform?.ios?.buildNumber ?? Constants.expoConfig?.ios?.buildNumber
    : Platform.OS === 'android'
      ? Constants.expoConfig?.android?.versionCode
      : undefined;
  const buildDate = (Constants.expoConfig?.extra as { buildDate?: string } | undefined)?.buildDate;
  const loginBuildLabel = appVersion
    ? `v${appVersion}${buildNumber != null ? ` (${buildNumber})` : ''}${
        Platform.OS === 'web' && buildDate ? ` · ${buildDate}` : ''
      }${Updates.isEnabled && !Updates.isEmbeddedLaunch && Updates.updateId
        ? ` · update ${Updates.updateId.slice(0, 8)}` : ''}`
    : null;
  const { bootstrapIfAuthed } = useChat();
  const { entryIntent, refreshEntryIntent } = useEntryContext();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  // 'signin' = existing account; 'register' = create a new account (name+email+password).
  const [mode, setMode] = useState<'signin' | 'register'>('signin');
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [appleLoading, setAppleLoading] = useState(false);
  const [ideaflowLoading, setIdeaflowLoading] = useState(false);
  // RN-web's Alert.alert is a no-op, and Ideaflow is the only web sign-in, so
  // its failures are shown inline (fixed, readable copy) rather than vanishing.
  const [ideaflowError, setIdeaflowError] = useState<string | null>(null);
  // Link-proof step: the Ideaflow email matches an existing account that has a
  // password but a never-verified email, so its password is proven once before
  // the Ideaflow identity is connected (code-xbh.7, same rule as Noos).
  const [passwordProof, setPasswordProof] = useState<{ email: string; linkTicket: string } | null>(null);
  const [proofPassword, setProofPassword] = useState('');
  const [proofLoading, setProofLoading] = useState(false);
  const reportIdeaflowError = (message: string) => {
    setIdeaflowError(message);
    Alert.alert('Ideaflow sign-in failed', message);
  };

  // Web Google sign-in uses a full-page REDIRECT, not the expo-auth-session
  // popup: Google's pages set Cross-Origin-Opener-Policy, which severs the
  // popup from its opener so window.closed polling never resolves and the
  // flow stalls. See openchat-n9a. Native (iOS) keeps the ID-token flow below.
  const isWeb = Platform.OS === 'web';
  const GOOGLE_WEB_STATE_KEY = 'openchat_google_web';

  // The server-side flag is the rollout source of truth: web shows nothing
  // until it answers, then either the single "Sign in with Ideaflow" button
  // (enabled) or the legacy methods (kill switch / unreachable). Native never
  // asks. Google, email/password, sign-up and reset live on id.ideaflow.app.
  const ideaflowConfig = useIdeaflowConfig();
  const providerResetUrl = ideaflowConfig.status === 'ready' ? ideaflowConfig.passwordResetUrl : null;
  const surface = loginSurface({ isWeb, config: ideaflowConfig });

  // Web: finish the Ideaflow ID redirect. The callback route adds a provider
  // marker because Google and OIDC both use standard `code` and `state` keys.
  useEffect(() => {
    if (!isWeb || typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('provider') !== 'ideaflow') return;

    const code = params.get('code');
    const oauthError = params.get('error');
    const returnedState = params.get('state');
    const basePath = `/${window.location.pathname.split('/')[1] || ''}/`;
    window.history.replaceState({}, '', basePath);

    let stored: { state: string; nonce: string; codeVerifier: string } | null = null;
    try {
      const raw = window.sessionStorage.getItem(IDEAFLOW_WEB_STATE_KEY);
      stored = raw ? JSON.parse(raw) : null;
    } catch { stored = null; }
    window.sessionStorage.removeItem(IDEAFLOW_WEB_STATE_KEY);

    if (!stored || !returnedState || returnedState !== stored.state) {
      reportIdeaflowError(ideaflowCallbackErrorMessage({ stateMatched: false, error: oauthError }));
      return;
    }
    if (oauthError || !code) {
      reportIdeaflowError(ideaflowCallbackErrorMessage({ stateMatched: true, error: oauthError }));
      return;
    }

    setIdeaflowLoading(true);
    (async () => {
      try {
        await ideaflowExchange(code, stored!.codeVerifier, stored!.nonce);
        // Signed in: any pending "ask which account" marker is now spent.
        takeIdeaflowAccountChoice();
        await bootstrapIfAuthed();
      } catch (err) {
        if (err instanceof IdeaflowPasswordProofRequiredError) {
          setPasswordProof({ email: err.email, linkTicket: err.linkTicket });
        } else {
          reportIdeaflowError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        setIdeaflowLoading(false);
      }
    })();
  }, [isWeb, bootstrapIfAuthed]);

  const handlePasswordProof = async () => {
    if (!passwordProof || !proofPassword || proofLoading) return;
    setProofLoading(true);
    setIdeaflowError(null);
    try {
      await linkIdeaflowWithPassword(passwordProof.linkTicket, passwordProof.email, proofPassword);
      takeIdeaflowAccountChoice();
      await bootstrapIfAuthed();
    } catch (err) {
      reportIdeaflowError(err instanceof Error ? err.message : String(err));
    } finally {
      setProofLoading(false);
    }
  };

  // Web: finish the redirect flow when we return from Google with ?code&state.
  useEffect(() => {
    if (!isWeb || typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('provider') === 'ideaflow') return;
    const code = params.get('code');
    const oauthError = params.get('error');
    const returnedState = params.get('state');
    if (!code && !oauthError) return;

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

    if (oauthError) {
      const description = params.get('error_description');
      Alert.alert('Google sign-in failed', description || oauthError);
      return;
    }

    setGoogleLoading(true);
    (async () => {
      try {
        await googleExchange(code!, stored!.redirectUri);
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
  // googleAuthRequestConfig owns the iOS callback URI constraint.
  //
  // The Web flow (GOOGLE_CLIENT_ID + code + secret + /google/exchange) is
  // still used by the RN-web app at chat.ideaflow.app/app.
  const [googleRequest, googleResponse, promptGoogle] = Google.useAuthRequest(
    googleAuthRequestConfig(Platform.OS, GOOGLE_IOS_CLIENT_ID, GOOGLE_ANDROID_CLIENT_ID, GOOGLE_CLIENT_ID),
  );

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
    // server holds the web client_id + secret and echoes our redirect_uri.
    // Google returns to the exactly registered /auth/google/callback endpoint;
    // the server then preserves code/state in a same-origin redirect to /app/,
    // where the useEffect above finishes the exchange. See openchat-n9a.
    if (isWeb && typeof window !== 'undefined') {
      setGoogleLoading(true);
      try {
        const redirectUri = `${window.location.origin}/auth/google/callback`;
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
      Alert.alert('Google sign-in unavailable', 'Google sign-in is still preparing. Please try again shortly.');
      return;
    }
    setGoogleLoading(true);
    try {
      const result = await promptGoogle();
      if (result.type === 'cancel' || result.type === 'dismiss' || result.type === 'locked') {
        setGoogleLoading(false);
      }
    } catch (err) {
      Alert.alert('Google sign-in failed', err instanceof Error ? err.message : String(err));
      setGoogleLoading(false);
    }
  };

  const handleIdeaflowSignIn = async () => {
    if (!isWeb || typeof window === 'undefined' || ideaflowLoading || loading) return;
    setIdeaflowLoading(true);
    setIdeaflowError(null);
    // Ordinary sign-in sends no prompt so an existing Ideaflow session is
    // reused silently. The first sign-in after an explicit sign-out asks the
    // provider for its account chooser (prompt=select_account).
    const selectAccount = takeIdeaflowAccountChoice();
    try {
      window.location.href = await prepareIdeaflowWebSignIn(OPENCHAT_URL, { selectAccount });
    } catch {
      reportIdeaflowError("Couldn't reach Ideaflow. Please try again in a moment.");
      setIdeaflowLoading(false);
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

  const handlePasteInvite = async () => {
    if (loading) return;
    try {
      const text = await Clipboard.getStringAsync();
      const parsed = parseOpenChatUrl(text);
      if (parsed.type === 'invite') {
        const intent = createEntryIntent({ kind: 'group', token: parsed.token }, Platform.OS === 'web' ? 'web' : 'native');
        await saveEntryIntent(intent);
        await refreshEntryIntent();
      } else {
        Alert.alert('No valid invite', 'We could not find an OpenChat invite link in your clipboard.');
      }
    } catch (err) {
      Alert.alert('Error', 'Could not read clipboard.');
    }
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={[styles.root, { backgroundColor: c.background }]}
    >
      {/* Scrolls when the card + share section outgrow the screen (small
          phones, register mode, quick-login rows); centered otherwise. The
          safe-area insets keep the title clear of the status bar / island. */}
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[
          styles.scrollContent,
          { paddingTop: 24 + insets.top, paddingBottom: 24 + insets.bottom },
        ]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }]}>
          {entryIntent ? (
            <EntryHeader />
          ) : (
            <>
              <Text style={[styles.title, { color: c.textPrimary }]}>OpenChat</Text>
              <Text style={[styles.subtitle, { color: c.textSecondary }]}>
                Real-time messaging powered by the Global Brain
              </Text>
              {!isWeb && (
                <TouchableOpacity onPress={handlePasteInvite} style={{ marginBottom: 16, alignSelf: 'center' }}>
                  <Text style={{ color: c.primary, fontWeight: '600' }}>Paste Invite Link</Text>
                </TouchableOpacity>
              )}
            </>
          )}

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
                cornerRadius={12}
                style={styles.appleButton}
                onPress={handleAppleSignIn}
              />
            )
          )}

          {surface.pending && (
            <View style={styles.pendingMethods} accessibilityLabel="Loading sign-in options">
              <ActivityIndicator color={c.primary} />
            </View>
          )}

          {surface.ideaflow && passwordProof && (
            <View style={styles.proofPanel}>
              <Text style={[styles.proofTitle, { color: c.textPrimary }]}>Connect your existing account</Text>
              <Text style={[styles.proofBody, { color: c.textSecondary }]}>
                You already have an OpenChat account for {passwordProof.email}. Enter its password once to connect it to Ideaflow.
              </Text>
              <TextInput
                style={[styles.input, { backgroundColor: c.surfaceElevated, borderColor: c.border, color: c.textPrimary }]}
                value={proofPassword}
                onChangeText={setProofPassword}
                placeholder="Password for this account"
                placeholderTextColor={c.textMuted}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="current-password"
                editable={!proofLoading}
                onSubmitEditing={() => { void handlePasswordProof(); }}
              />
              <TouchableOpacity
                style={[styles.ideaflowButton, { backgroundColor: c.primary, opacity: (proofLoading || !proofPassword) ? 0.6 : 1 }]}
                onPress={() => { void handlePasswordProof(); }}
                disabled={proofLoading || !proofPassword}
                accessibilityRole="button"
                accessibilityLabel="Connect account"
              >
                {proofLoading ? (
                  <ActivityIndicator color={c.onPrimary} />
                ) : (
                  <Text style={[styles.ideaflowButtonText, { color: c.onPrimary }]}>Connect account</Text>
                )}
              </TouchableOpacity>
              <Text style={[styles.newHereHint, { color: c.textMetadata }]}>
                Forgot this password? Email support@ideaflow.app and we'll connect the account for you.
              </Text>
              <TouchableOpacity
                onPress={() => { setPasswordProof(null); setProofPassword(''); setIdeaflowError(null); }}
                disabled={proofLoading}
                accessibilityRole="button"
                accessibilityLabel="Cancel"
                style={styles.proofCancel}
              >
                <Text style={{ color: c.textMetadata, fontSize: 13 }}>Cancel</Text>
              </TouchableOpacity>
            </View>
          )}

          {surface.ideaflow && !passwordProof && (
            <TouchableOpacity
              style={[
                styles.ideaflowButton,
                {
                  backgroundColor: c.primary,
                  opacity: (ideaflowLoading || loading || googleLoading) ? 0.6 : 1,
                },
              ]}
              onPress={() => { void handleIdeaflowSignIn(); }}
              disabled={ideaflowLoading || loading || googleLoading}
              accessibilityRole="button"
              accessibilityLabel="Sign in with Ideaflow"
            >
              {ideaflowLoading ? (
                <ActivityIndicator color={c.onPrimary} />
              ) : (
                <Text style={[styles.ideaflowButtonText, { color: c.onPrimary }]}>Sign in with Ideaflow</Text>
              )}
            </TouchableOpacity>
          )}

          {surface.ideaflow && !passwordProof && (
            <Text style={[styles.newHereHint, { color: c.textMetadata }]}>
              New here? You can create an account on the next screen.
            </Text>
          )}

          {ideaflowError && !surface.pending && (
            <Text accessibilityRole="alert" style={[styles.inlineError, { color: c.danger }]}>
              {ideaflowError}
            </Text>
          )}

          {surface.legacy && (
            <>
            <TouchableOpacity
              style={[
                styles.googleButton,
                { borderColor: c.border, opacity: (googleLoading || loading) ? 0.6 : 1 },
              ]}
              onPress={handleGoogleSignIn}
              disabled={googleLoading || loading}
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
                <ActivityIndicator color={c.onPrimary} />
              ) : (
                <Text style={[styles.buttonText, { color: c.onPrimary }]}>{mode === 'register' ? 'Create account' : 'Sign In'}</Text>
              )}
            </TouchableOpacity>

            {mode === 'signin' && <PasswordRecoveryHelp colors={c} providerResetUrl={providerResetUrl} />}

            <TouchableOpacity
              onPress={() => setMode(mode === 'register' ? 'signin' : 'register')}
              disabled={loading}
              style={{ marginTop: 14, alignSelf: 'center' }}
            >
              <Text style={{ color: c.primary, fontSize: 14, fontWeight: '600' }}>
                {mode === 'register' ? 'Already have an account? Sign in' : "Don't have an account? Create one"}
              </Text>
            </TouchableOpacity>
            </>
          )}

          {SHOW_TEST_LOGINS && (
            <View style={styles.quickLogin}>
              <View style={[styles.divider, { backgroundColor: c.border }]} />
              <Text style={[styles.quickLabel, { color: c.textMetadata }]}>Quick login (testing)</Text>
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
                    <Text style={[styles.quickButtonSub, { color: c.textMetadata }]}>{acct.email}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>
          )}

          {surface.legacyFooter && (
            <Text style={[styles.footer, { color: c.textMetadata }]}>
              Uses your Noos credentials. Phone sign-in coming soon.
            </Text>
          )}
        </View>

        {/* Get / Share OpenChat.
            On web, offers the App Store link to iOS users who landed via a shared link.
            On native, offers the QR code so someone else can scan it. */}
        <View style={styles.shareSection}>
          <Text style={[styles.shareLabel, { color: c.textMetadata }]}>GET THE APP</Text>
          <View style={[styles.shareCard, { backgroundColor: c.surface, borderColor: c.border, flexDirection: 'column', gap: 0, padding: 0 }]}>
            <TouchableOpacity
              style={{ flexDirection: 'row', alignItems: 'center', padding: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.divider }}
              onPress={() => Linking.openURL('https://apps.apple.com/us/app/openchat-agentic-chat/id6774991932')}
              activeOpacity={0.7}
            >
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 16, fontWeight: '600', color: c.textPrimary }}>Get the iOS app · App Store</Text>
                <Text style={{ fontSize: 13, color: c.textSecondary, marginTop: 4 }}>Install the native app on iPhone or iPad</Text>
              </View>
              <Text style={{ color: c.textMuted, fontSize: 18 }}>›</Text>
            </TouchableOpacity>

            {Platform.OS !== 'web' ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', padding: 16, gap: 16 }}>
                <View style={styles.qrWrap}>
                  <QRCode value="https://chat.ideaflow.app/app/" size={80} backgroundColor="#ffffff" color="#000000" />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 16, fontWeight: '600', color: c.textPrimary }}>Scan to open on any phone</Text>
                  <TouchableOpacity
                    onPress={() => Share.share({ message: 'Try OpenChat: https://chat.ideaflow.app/app/' })}
                    activeOpacity={0.7}
                    style={[styles.shareButton, { backgroundColor: c.surfaceElevated, borderColor: c.border, marginTop: 12 }]}
                  >
                    <Text style={[styles.shareButtonText, { color: c.textPrimary }]}>Share link</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ) : (
              <TouchableOpacity
                style={{ flexDirection: 'row', alignItems: 'center', padding: 16 }}
                onPress={() => Linking.openURL('https://chat.ideaflow.app/app/')}
                activeOpacity={0.7}
              >
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 16, fontWeight: '600', color: c.textPrimary }}>Open in browser</Text>
                  <Text style={{ fontSize: 13, color: c.textSecondary, marginTop: 4 }}>Continue on the web version</Text>
                </View>
                <Text style={{ color: c.textMuted, fontSize: 18 }}>›</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>
      </ScrollView>
      {loginBuildLabel && (
        <Text
          accessibilityLabel={`OpenChat version ${loginBuildLabel}`}
          pointerEvents="none"
          style={[styles.buildLabel, { color: c.textMetadata, bottom: insets.bottom + 6, backgroundColor: c.background }]}
        >
          {loginBuildLabel}
        </Text>
      )}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  scroll: { flex: 1 },
  scrollContent: { flexGrow: 1, paddingHorizontal: 24, justifyContent: 'center', alignItems: 'stretch' },
  buildLabel: { position: 'absolute', right: 10, paddingHorizontal: 4, fontSize: 11, lineHeight: 15 },
  card: {
    width: '100%',
    maxWidth: 520,
    alignSelf: 'center',
    padding: 24,
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 12,
  },
  title: { fontSize: 28, fontWeight: '700', textAlign: 'center' },
  subtitle: { fontSize: 14, textAlign: 'center', marginBottom: 12 },
  input: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    fontSize: 16,
  },
  button: {
    height: 50,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 4,
  },
  buttonText: { fontSize: 16, fontWeight: '600' },
  ideaflowButton: {
    height: 50,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ideaflowButtonText: { fontSize: 16, fontWeight: '600' },
  inlineError: { fontSize: 14, textAlign: 'center' },
  pendingMethods: { height: 50, alignItems: 'center', justifyContent: 'center' },
  newHereHint: { fontSize: 13, textAlign: 'center' },
  proofPanel: { gap: 12 },
  proofTitle: { fontSize: 17, fontWeight: '600', textAlign: 'center' },
  proofBody: { fontSize: 14, textAlign: 'center', lineHeight: 20 },
  proofCancel: { alignSelf: 'center', paddingVertical: 4 },
  footer: { fontSize: 12, textAlign: 'center', marginTop: 8 },
  shareSection: { width: '100%', maxWidth: 520, alignSelf: 'center', marginTop: 32, alignItems: 'stretch', opacity: 0.88 },
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
    borderRadius: 12,
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
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 10,
    height: 50,
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
    height: 50,
    borderRadius: 12,
  },
  // Loading placeholder so the layout doesn't jump while the native sheet opens.
  appleButtonPlaceholder: {
    width: '100%',
    height: 50,
    borderRadius: 12,
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
