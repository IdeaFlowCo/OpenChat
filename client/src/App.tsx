import { useState, useEffect } from 'react';
import { Routes, Route, Navigate, useSearchParams, useNavigate, useLocation } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import { ChatProvider, useChat } from './contexts/ChatContext';
import { ChatPage } from './pages/ChatPage';

const NOOS_URL = import.meta.env.VITE_NOOS_URL || 'http://localhost:52743';
const ALLOW_INSECURE_SSO_TOKEN = import.meta.env.MODE !== 'production';

function normalizeRedirect(target: string | null): string {
  if (!target) return '/';
  if (!target.startsWith('/')) return '/';
  try {
    const url = new URL(target, window.location.origin);
    if (url.origin !== window.location.origin) return '/';
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return '/';
  }
}

function parseHashParams(hash: string): URLSearchParams {
  if (!hash) return new URLSearchParams();
  return new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
}

// SSO Callback - handles redirect from Noos with auth code/token
function SSOCallback() {
  const { ssoLogin, token } = useChat();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const code = searchParams.get('code');
    const state = searchParams.get('state');
    const queryToken = searchParams.get('token');
    const hashToken = parseHashParams(window.location.hash).get('token');

    const storedStateRaw = sessionStorage.getItem('openchat_sso_state');
    let storedState: { state?: string; redirect?: string } | null = null;
    if (storedStateRaw) {
      try {
        storedState = JSON.parse(storedStateRaw) as { state?: string; redirect?: string };
      } catch {
        storedState = null;
      }
    }
    const redirectTarget = normalizeRedirect(storedState?.redirect || searchParams.get('redirect'));

    if (state && storedState?.state && state !== storedState.state) {
      setError('Invalid SSO state. Please try again.');
      setLoading(false);
      sessionStorage.removeItem('openchat_sso_state');
      return;
    }

    // Already logged in? Go to chat
    if (token) {
      navigate(redirectTarget, { replace: true });
      return;
    }

    const exchangePayload = code
      ? { code }
      : hashToken
        ? { token: hashToken }
        : (queryToken && ALLOW_INSECURE_SSO_TOKEN)
          ? { token: queryToken }
          : null;

    if (!exchangePayload) {
      if (queryToken && !ALLOW_INSECURE_SSO_TOKEN) {
        setError('Insecure SSO token in URL. Please sign in again.');
      } else {
        setError('No SSO code provided');
      }
      setLoading(false);
      return;
    }

    sessionStorage.removeItem('openchat_sso_state');
    if (window.location.hash) {
      window.history.replaceState({}, document.title, window.location.pathname + window.location.search);
    }

    ssoLogin(exchangePayload)
      .then(() => {
        navigate(redirectTarget, { replace: true });
      })
      .catch((err) => {
        setError(err.message || 'SSO login failed');
        setLoading(false);
      });
  }, [searchParams, ssoLogin, token, navigate]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-100">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500 mx-auto mb-4"></div>
          <p className="text-gray-600">Signing in from Noos...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-100">
        <div className="bg-white p-8 rounded-lg shadow-md w-full max-w-md text-center">
          <h1 className="text-xl font-bold text-red-600 mb-4">SSO Login Failed</h1>
          <p className="text-gray-600 mb-6">{error}</p>
          <button
            onClick={() => navigate('/login', { replace: true })}
            className="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600"
          >
            Go to Login
          </button>
        </div>
      </div>
    );
  }

  return null;
}

// Test accounts for quick login
const TEST_ACCOUNTS = [
  { email: 'alice@noos.app', name: 'Alice', password: 'Test123!' },
  { email: 'bob@noos.app', name: 'Bob', password: 'Test123!' },
];

function LoginPage() {
  const { devLogin, login, noosLogin } = useChat();
  const [searchParams] = useSearchParams();
  const [mode, setMode] = useState<'sso' | 'token' | 'dev'>('sso');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [tokenInput, setTokenInput] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const redirectTarget = normalizeRedirect(searchParams.get('redirect'));
  const showDev = import.meta.env.MODE !== 'production';

  const resetForm = () => {
    setEmail('');
    setName('');
    setTokenInput('');
    setError('');
  };

  const handleSsoLogin = () => {
    setError('');
    setLoading(true);
    const callbackUrl = new URL('/auth/callback', window.location.origin);
    if (redirectTarget && redirectTarget !== '/') {
      callbackUrl.searchParams.set('redirect', redirectTarget);
    }
    const state = typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);

    sessionStorage.setItem('openchat_sso_state', JSON.stringify({ state, redirect: redirectTarget }));

    const loginUrl = new URL('/api/auth/login', window.location.origin);
    loginUrl.searchParams.set('redirect_uri', callbackUrl.toString());
    loginUrl.searchParams.set('state', state);
    window.location.assign(loginUrl.toString());
  };

  const handleTokenLogin = (e: React.FormEvent) => {
    e.preventDefault();
    if (!tokenInput.trim()) {
      setError('Token is required');
      return;
    }
    setError('');
    const ok = login(tokenInput.trim());
    if (!ok) {
      setError('Invalid token format');
    }
  };

  const handleDevLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) {
      setError('Email is required');
      return;
    }
    setLoading(true);
    setError('');
    try {
      await devLogin(email.trim(), name.trim() || undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  const handleTestAccountLogin = async (account: typeof TEST_ACCOUNTS[0]) => {
    setLoading(true);
    setError('');
    try {
      await noosLogin(account.email, account.password);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-100">
      <div className="bg-white p-8 rounded-lg shadow-md w-full max-w-md">
        <h1 className="text-2xl font-bold mb-2 text-center">OpenChat</h1>
        <p className="text-gray-500 text-sm mb-6 text-center">Powered by Noos</p>

        <div className="flex gap-2 justify-center mb-6 text-xs">
          <button
            onClick={() => { resetForm(); setMode('sso'); }}
            className={`px-3 py-1 rounded-full border ${mode === 'sso' ? 'bg-blue-500 text-white border-blue-500' : 'border-gray-300 text-gray-600'}`}
          >
            Continue
          </button>
          <button
            onClick={() => { resetForm(); setMode('token'); }}
            className={`px-3 py-1 rounded-full border ${mode === 'token' ? 'bg-blue-500 text-white border-blue-500' : 'border-gray-300 text-gray-600'}`}
          >
            Use Token
          </button>
          {showDev && (
            <button
              onClick={() => { resetForm(); setMode('dev'); }}
              className={`px-3 py-1 rounded-full border ${mode === 'dev' ? 'bg-yellow-500 text-white border-yellow-500' : 'border-gray-300 text-gray-600'}`}
            >
              Dev
            </button>
          )}
        </div>

        {mode === 'sso' && (
          <>
            <button
              onClick={handleSsoLogin}
              className="w-full py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:opacity-50"
              disabled={loading}
            >
              {loading ? 'Redirecting...' : 'Continue with Noos'}
            </button>
            <p className="text-xs text-gray-500 mt-3 text-center">
              You will be redirected to Noos for authentication.
            </p>
            <div className="mt-3 text-center">
              <a
                className="text-xs text-gray-400 hover:text-gray-600"
                href={NOOS_URL}
                target="_blank"
                rel="noreferrer"
              >
                Open Noos in a new tab
              </a>
            </div>
          </>
        )}

        {mode === 'token' && (
          <form onSubmit={handleTokenLogin}>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Paste JWT
            </label>
            <textarea
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              placeholder="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:border-blue-500 text-xs h-28"
              disabled={loading}
            />
            {error && (
              <p className="text-red-500 text-sm mt-3">{error}</p>
            )}
            <button
              type="submit"
              className="w-full py-2 mt-4 bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:opacity-50"
              disabled={loading}
            >
              Use Token
            </button>
          </form>
        )}

        {mode === 'dev' && (
          <>
            <p className="text-yellow-600 text-sm mb-4 p-2 bg-yellow-50 rounded">
              Dev mode: No password required. For testing only.
            </p>

            <form onSubmit={handleDevLogin}>
              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Email
                </label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:border-blue-500"
                  disabled={loading}
                />
              </div>

              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Name (optional)
                </label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Your name"
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:border-blue-500"
                  disabled={loading}
                />
              </div>

              {error && (
                <p className="text-red-500 text-sm mb-4">{error}</p>
              )}

              <button
                type="submit"
                className="w-full py-2 bg-yellow-500 text-white rounded-lg hover:bg-yellow-600 disabled:opacity-50"
                disabled={loading}
              >
                {loading ? 'Signing in...' : 'Dev Login'}
              </button>
            </form>
          </>
        )}

        {/* Test accounts section */}
        <div className="mt-6 pt-6 border-t border-gray-200">
          <p className="text-sm text-gray-500 text-center mb-3">
            Quick test accounts (password: <code className="bg-gray-100 px-1 rounded text-xs">Test123!</code>)
          </p>
          <div className="grid grid-cols-2 gap-2">
            {TEST_ACCOUNTS.map((account) => (
              <button
                key={account.email}
                onClick={() => handleTestAccountLogin(account)}
                disabled={loading}
                className="px-3 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50"
              >
                {account.name}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { token } = useChat();
  const location = useLocation();
  if (!token) {
    const redirect = encodeURIComponent(`${location.pathname}${location.search}${location.hash}`);
    return <Navigate to={`/login?redirect=${redirect}`} replace />;
  }
  return <>{children}</>;
}

function AppRoutes() {
  const { token } = useChat();

  return (
    <Routes>
      <Route
        path="/login"
        element={token ? <Navigate to="/" replace /> : <LoginPage />}
      />
      <Route
        path="/auth/callback"
        element={<SSOCallback />}
      />
      <Route
        path="/"
        element={
          <ProtectedRoute>
            <ChatPage />
          </ProtectedRoute>
        }
      />
    </Routes>
  );
}

export default function App() {
  return (
    <ChatProvider>
      <Toaster
        position="top-right"
        toastOptions={{
          duration: 4000,
          error: {
            duration: 6000,
            style: {
              background: '#fee2e2',
              color: '#991b1b',
            },
          },
          success: {
            style: {
              background: '#dcfce7',
              color: '#166534',
            },
          },
        }}
      />
      <AppRoutes />
    </ChatProvider>
  );
}
