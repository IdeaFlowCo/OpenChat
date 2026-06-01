/**
 * InvitePreviewPage — renders at /i/:token (OpenChat-240).
 *
 * Fetches GET /api/chat/invites/:token, shows conversation title + member count,
 * and lets the user join via POST /api/chat/invites/:token/accept.
 *
 * If the user is not logged in, redirects to /login?redirect=/i/:token so they
 * come back here after auth.
 */

import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useChat } from '../contexts/ChatContext';

interface InvitePreview {
  conversationId: string;
  conversationTitle: string | null;
  memberCount: number;
  expiresAt: string;
}

export function InvitePreviewPage() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const { token: authToken, setActiveConversation } = useChat();

  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Redirect to login if not authed
  useEffect(() => {
    if (!authToken) {
      navigate(`/login?redirect=${encodeURIComponent(`/i/${token}`)}`, { replace: true });
    }
  }, [authToken, token, navigate]);

  // Fetch invite preview
  useEffect(() => {
    if (!token || !authToken) return;
    setLoading(true);
    setError(null);
    api.getInvitePreview(token)
      .then(data => {
        setPreview(data);
        setLoading(false);
      })
      .catch(err => {
        setError(err.message || 'Failed to load invite');
        setLoading(false);
      });
  }, [token, authToken]);

  const handleJoin = async () => {
    if (!token) return;
    setJoining(true);
    setError(null);
    try {
      const result = await api.acceptInvite(token);
      setActiveConversation(result.conversationId);
      navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to join');
      setJoining(false);
    }
  };

  if (!authToken) return null;

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-100 dark:bg-slate-950">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500 mx-auto mb-4"></div>
          <p className="text-gray-600 dark:text-slate-300">Loading invite...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-100 dark:bg-slate-950 px-4">
        <div className="bg-white dark:bg-slate-900 p-8 rounded-lg shadow-md dark:shadow-black/40 w-full max-w-md text-center">
          <h1 className="text-xl font-bold text-red-600 dark:text-red-400 mb-4">Invite Unavailable</h1>
          <p className="text-gray-600 dark:text-slate-300 mb-6">{error}</p>
          <button
            onClick={() => navigate('/', { replace: true })}
            className="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600"
          >
            Go to OpenChat
          </button>
        </div>
      </div>
    );
  }

  const groupName = preview?.conversationTitle || 'Unnamed Group';
  const memberCount = preview?.memberCount ?? 0;

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-100 dark:bg-slate-950 px-4">
      <div className="bg-white dark:bg-slate-900 p-8 rounded-lg shadow-md dark:shadow-black/40 w-full max-w-md text-center">
        <div className="w-16 h-16 bg-blue-100 dark:bg-blue-900 rounded-full flex items-center justify-center mx-auto mb-4">
          <svg className="w-8 h-8 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
        </div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-slate-100 mb-2">
          You're invited to join
        </h1>
        <p className="text-xl font-semibold text-blue-600 dark:text-blue-400 mb-2">
          {groupName}
        </p>
        <p className="text-gray-500 dark:text-slate-400 text-sm mb-8">
          {memberCount} {memberCount === 1 ? 'member' : 'members'}
        </p>

        <button
          onClick={handleJoin}
          disabled={joining}
          className="w-full py-3 bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:opacity-50 font-medium mb-3"
        >
          {joining ? 'Joining...' : 'Join Group'}
        </button>
        <button
          onClick={() => navigate('/', { replace: true })}
          className="w-full py-3 text-gray-600 dark:text-slate-400 hover:text-gray-900 dark:hover:text-slate-200 font-medium"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
