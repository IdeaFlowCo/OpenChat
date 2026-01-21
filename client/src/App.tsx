import { useState } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { ChatProvider, useChat } from './contexts/ChatContext';
import { ChatPage } from './pages/ChatPage';

function LoginPage() {
  const { devLogin, login } = useChat();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [showTokenLogin, setShowTokenLogin] = useState(false);
  const [token, setToken] = useState('');

  const handleDevLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) {
      setError('Please enter an email');
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

  const handleTokenLogin = (e: React.FormEvent) => {
    e.preventDefault();
    if (!token.trim()) {
      setError('Please enter a token');
      return;
    }
    try {
      login(token.trim());
    } catch {
      setError('Invalid token');
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-100">
      <div className="bg-white p-8 rounded-lg shadow-md w-full max-w-md">
        <h1 className="text-2xl font-bold mb-6 text-center">OpenChat</h1>

        {!showTokenLogin ? (
          <>
            <p className="text-gray-600 mb-6 text-center">
              Enter your email to sign in or create an account
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
                className="w-full py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:opacity-50"
                disabled={loading}
              >
                {loading ? 'Signing in...' : 'Continue'}
              </button>
            </form>

            <button
              onClick={() => setShowTokenLogin(true)}
              className="w-full mt-4 py-2 text-gray-600 text-sm hover:text-gray-800"
            >
              Or login with Noos token
            </button>
          </>
        ) : (
          <>
            <p className="text-gray-600 mb-6 text-center">
              Enter your Noos JWT token
            </p>

            <form onSubmit={handleTokenLogin}>
              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  JWT Token
                </label>
                <input
                  type="password"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="eyJhbGciOiJIUzI1..."
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:border-blue-500"
                />
              </div>

              {error && (
                <p className="text-red-500 text-sm mb-4">{error}</p>
              )}

              <button
                type="submit"
                className="w-full py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600"
              >
                Login
              </button>
            </form>

            <button
              onClick={() => setShowTokenLogin(false)}
              className="w-full mt-4 py-2 text-gray-600 text-sm hover:text-gray-800"
            >
              Back to email login
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { token } = useChat();
  if (!token) {
    return <Navigate to="/login" replace />;
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
      <AppRoutes />
    </ChatProvider>
  );
}
