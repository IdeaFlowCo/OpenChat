import { useState, useEffect } from 'react';
import { Routes, Route, Navigate, useSearchParams, useNavigate, useLocation } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import { ChatProvider, useChat } from './contexts/ChatContext';
import { ChatPage } from './pages/ChatPage';

const NOOS_URL = import.meta.env.VITE_NOOS_URL || 'https://globalbr.ai';
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

function LoginPage() {
  const [searchParams] = useSearchParams();
  const [loading, setLoading] = useState(false);

  const redirectTarget = normalizeRedirect(searchParams.get('redirect'));

  const handleNoosLogin = () => {
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

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-100">
      <div className="bg-white p-8 rounded-lg shadow-md w-full max-w-md">
        <h1 className="text-2xl font-bold mb-2 text-center">OpenChat</h1>
        <p className="text-gray-500 text-sm mb-6 text-center">
          Real-time messaging powered by the Global Brain
        </p>

        <button
          onClick={handleNoosLogin}
          className="w-full py-3 bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:opacity-50 font-medium"
          disabled={loading}
        >
          {loading ? 'Redirecting...' : 'Continue with Noos'}
        </button>

        <p className="text-sm text-gray-500 text-center mt-4">
          Don't have an account?{' '}
          <a
            href={`${NOOS_URL}/auth/authorize?client_id=openchat&redirect_uri=${encodeURIComponent(window.location.origin + '/auth/callback')}&response_type=code&mode=register`}
            className="text-blue-500 hover:underline"
          >
            Create one on Noos
          </a>
        </p>

        <div className="text-xs text-gray-400 text-center mt-6 pt-4 border-t border-gray-200">
          OpenChat is part of the{' '}
          <a href={NOOS_URL} className="text-blue-400 hover:underline">
            Global Brain
          </a>{' '}
          ecosystem. Sign in once to access all connected apps.
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
