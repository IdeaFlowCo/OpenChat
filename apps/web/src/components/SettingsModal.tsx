import { useCallback, useEffect, useState } from 'react';
import {
  APP_BUILD_DATE,
  APP_GIT_BRANCH,
  APP_GIT_SHA,
  IS_DEV_BUILD,
  formatVersion,
} from '../utils/appVersion';
import { AgentKey, api, EXPORT_RANGE_OPTIONS, ExportRangeKey, User, type SecretaryAnswer } from '../api';
import { buildAgentSetupBlob } from '../utils/agentSetupBlob';
import { saveTextDownload } from '../utils/download';
import { useTheme, ThemePreference } from '../contexts/ThemeContext';
import { useChat } from '../contexts/ChatContext';

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  showVersionInTopBar: boolean;
  onShowVersionInTopBarChange: (value: boolean) => void;
}

type View = 'root' | 'profile' | 'secretary' | 'agentKeys' | 'blocked' | 'export';

function timeAgo(iso: string | null | undefined): string {
  if (!iso) return 'Never';
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

// Detect a coarse update/build channel for provenance (openchat-3jq.3).
function updateChannel(): string {
  if (IS_DEV_BUILD) return 'development';
  const host = typeof window !== 'undefined' ? window.location.hostname : '';
  if (/^100\.\d+\.\d+\.\d+$/.test(host) || host.endsWith('.ts.net')) return 'tailscale';
  if (host === 'localhost' || host === '127.0.0.1') return 'local';
  return 'production';
}

export function SettingsModal({
  open,
  onClose,
  showVersionInTopBar,
  onShowVersionInTopBarChange,
}: SettingsModalProps) {
  const { preference: themePref, setPreference: setThemePref } = useTheme();
  const { currentUser, logout } = useChat();
  const [view, setView] = useState<View>('root');

  // Reset to root whenever the modal closes so it re-opens at the top.
  useEffect(() => {
    if (!open) setView('root');
  }, [open]);

  if (!open) return null;

  const buildDate = new Date(APP_BUILD_DATE);
  const buildDateLabel = Number.isNaN(buildDate.getTime()) ? APP_BUILD_DATE : buildDate.toLocaleString();

  const title =
    view === 'profile' ? 'Edit profile'
    : view === 'secretary' ? 'Secretary'
    : view === 'agentKeys' ? 'Agent keys'
    : view === 'blocked' ? 'Blocked users'
    : view === 'export' ? 'Export my data'
    : 'Settings';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-title"
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 md:items-center md:p-4"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[90vh] w-full flex-col rounded-t-2xl bg-white dark:bg-slate-900 shadow-xl md:max-w-lg md:rounded-2xl">
        <div className="flex items-center justify-between gap-3 border-b border-gray-200 dark:border-slate-800 px-4 py-3">
          <div className="flex items-center gap-2 min-w-0">
            {view !== 'root' && (
              <button
                type="button"
                onClick={() => setView('root')}
                aria-label="Back"
                className="flex min-h-[36px] min-w-[36px] items-center justify-center rounded-full text-gray-500 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-slate-800"
              >
                <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                  <path fillRule="evenodd" d="M12.79 5.23a.75.75 0 010 1.06L9.06 10l3.73 3.71a.75.75 0 11-1.06 1.06l-4.25-4.24a.75.75 0 010-1.06l4.25-4.24a.75.75 0 011.06 0z" clipRule="evenodd" />
                </svg>
              </button>
            )}
            <h2 id="settings-title" className="text-base font-semibold text-gray-900 dark:text-slate-100 truncate">
              {title}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close settings"
            className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full text-gray-500 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-slate-800 hover:text-gray-900 dark:hover:text-slate-100"
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
              <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
            </svg>
          </button>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto p-4">
          {view === 'root' && (
            <RootView
              themePref={themePref}
              setThemePref={setThemePref}
              showVersionInTopBar={showVersionInTopBar}
              onShowVersionInTopBarChange={onShowVersionInTopBarChange}
              buildDateLabel={buildDateLabel}
              currentUser={currentUser}
              onNavigate={setView}
              onLogout={logout}
            />
          )}
          {view === 'profile' && <ProfileEditView onDone={() => setView('root')} />}
          {view === 'secretary' && <SecretaryView />}
          {view === 'agentKeys' && <AgentKeysView />}
          {view === 'blocked' && <BlockedUsersView />}
          {view === 'export' && <ExportView />}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Root view
// ─────────────────────────────────────────────────────────────────────────

const sectionCls = 'rounded-lg border border-gray-200 dark:border-slate-700 overflow-hidden';
const labelCls = 'text-xs font-bold uppercase tracking-wide text-gray-500 dark:text-slate-400';
const rowCls = 'flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-gray-50 dark:hover:bg-slate-800/50';

function NavRow({ label, hint, onClick, danger }: { label: string; hint?: string; onClick: () => void; danger?: boolean }) {
  return (
    <button type="button" onClick={onClick} className={rowCls}>
      <span className="min-w-0">
        <span className={`block text-sm font-medium ${danger ? 'text-red-600 dark:text-red-400' : 'text-gray-900 dark:text-slate-100'}`}>{label}</span>
        {hint && <span className="block text-xs text-gray-500 dark:text-slate-400 truncate">{hint}</span>}
      </span>
      {!danger && <span className="text-gray-400 dark:text-slate-500 text-lg shrink-0">›</span>}
    </button>
  );
}

function RootView({
  themePref, setThemePref, showVersionInTopBar, onShowVersionInTopBarChange,
  buildDateLabel, currentUser, onNavigate, onLogout,
}: {
  themePref: ThemePreference;
  setThemePref: (p: ThemePreference) => void;
  showVersionInTopBar: boolean;
  onShowVersionInTopBarChange: (v: boolean) => void;
  buildDateLabel: string;
  currentUser: { userId: string; email: string; name?: string } | null;
  onNavigate: (v: View) => void;
  onLogout: () => void;
}) {
  const [minting, setMinting] = useState(false);
  const [setupStatus, setSetupStatus] = useState<{ kind: 'success' | 'error'; message: string } | null>(null);
  const [feedback, setFeedback] = useState('');
  const [sendingFeedback, setSendingFeedback] = useState(false);
  const [feedbackStatus, setFeedbackStatus] = useState<{ kind: 'success' | 'error'; message: string } | null>(null);
  const [notifPerm, setNotifPerm] = useState<NotificationPermission | 'unsupported'>(
    typeof Notification === 'undefined' ? 'unsupported' : Notification.permission
  );
  const [deleting, setDeleting] = useState(false);

  const handleCopyAgentSetup = async () => {
    if (minting) return;
    setMinting(true);
    setSetupStatus(null);
    try {
      const result = await api.createAgentKey(`Quick setup ${new Date().toISOString().slice(0, 10)}`, ['read', 'write']);
      const blob = buildAgentSetupBlob(result.key, window.location.origin);
      await navigator.clipboard.writeText(blob);
      setSetupStatus({ kind: 'success', message: 'Copied! Paste it into ChatGPT, Claude, Gemini, or any chatbot — no install needed.' });
    } catch (err) {
      setSetupStatus({ kind: 'error', message: err instanceof Error ? err.message : 'Failed to create agent setup.' });
    } finally {
      setMinting(false);
    }
  };

  const handleSendFeedback = async () => {
    const text = feedback.trim();
    if (!text || sendingFeedback) return;
    setSendingFeedback(true);
    setFeedbackStatus(null);
    try {
      const { url } = await api.submitFeedback(text);
      setFeedback('');
      setFeedbackStatus({ kind: 'success', message: `Thanks! Your feedback was sent.${url ? ` ${url}` : ''}` });
    } catch (err) {
      setFeedbackStatus({ kind: 'error', message: err instanceof Error ? err.message : 'Could not send feedback.' });
    } finally {
      setSendingFeedback(false);
    }
  };

  const handleEnableNotifications = async () => {
    if (typeof Notification === 'undefined') return;
    try {
      const perm = await Notification.requestPermission();
      setNotifPerm(perm);
    } catch {
      /* user dismissed */
    }
  };

  const handleDeleteAccount = async () => {
    if (deleting) return;
    if (!window.confirm('Delete your account? This deletes your profile and replaces your sent messages with "Message deleted". This cannot be undone.')) return;
    const typed = window.prompt('Type DELETE to permanently delete your account.');
    if (typed !== 'DELETE') return;
    setDeleting(true);
    try {
      await api.deleteAccount();
      onLogout();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to delete account.');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
      {/* One-click "Copy agent setup" (openchat-bbr) */}
      <section className="rounded-lg border border-blue-200 dark:border-blue-900 bg-blue-50 dark:bg-blue-900/20 p-4">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-blue-600 dark:text-blue-400">OpenChat for agents</h3>
        <button
          type="button"
          onClick={handleCopyAgentSetup}
          disabled={minting}
          className="mt-3 flex min-h-[44px] w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-3 text-base font-semibold text-white shadow-sm transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {minting ? 'Minting key…' : '📋  Copy agent setup'}
        </button>
        <p className="mt-2 text-xs text-gray-600 dark:text-slate-400">Mints a key + copies a paste-anywhere setup for ChatGPT, Claude, any LLM.</p>
        {setupStatus && (
          <p role="status" className={`mt-2 text-sm ${setupStatus.kind === 'success' ? 'text-green-700 dark:text-green-400' : 'text-red-600'}`}>{setupStatus.message}</p>
        )}
        <button type="button" onClick={() => onNavigate('agentKeys')} className="mt-3 text-sm font-medium text-blue-600 dark:text-blue-400 hover:underline">
          Manage agent keys →
        </button>
      </section>

      {/* Account */}
      {currentUser && (
        <section>
          <h3 className={labelCls}>Account</h3>
          <div className={`mt-2 ${sectionCls}`}>
            <NavRow label="Edit profile" hint={currentUser.name || 'Set your display name'} onClick={() => onNavigate('profile')} />
            <div className="border-t border-gray-100 dark:border-slate-800 px-4 py-3 text-sm text-gray-700 dark:text-slate-300">{currentUser.email}</div>
          </div>
        </section>
      )}

      <section>
        <h3 className={labelCls}>Automation</h3>
        <div className={`mt-2 ${sectionCls}`}>
          <NavRow label="Secretary" hint="Auto-answer repetitive questions using replies you approve" onClick={() => onNavigate('secretary')} />
        </div>
      </section>

      {/* Feedback */}
      <section>
        <h3 className={labelCls}>Feedback</h3>
        <div className={`mt-2 ${sectionCls} p-4`}>
          <textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            rows={3}
            placeholder="What's working, broken, or missing?"
            className="w-full resize-none rounded-lg border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 text-sm text-gray-900 dark:text-slate-100 placeholder:text-gray-400 dark:placeholder:text-slate-500 focus:outline-none focus:border-blue-500"
          />
          <button
            type="button"
            onClick={handleSendFeedback}
            disabled={!feedback.trim() || sendingFeedback}
            className="mt-2 min-h-[40px] w-full rounded-lg bg-gray-900 dark:bg-slate-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {sendingFeedback ? 'Sending…' : 'Send feedback'}
          </button>
          {feedbackStatus && (
            <p role="status" className={`mt-2 text-sm ${feedbackStatus.kind === 'success' ? 'text-green-700 dark:text-green-400' : 'text-red-600'}`}>{feedbackStatus.message}</p>
          )}
        </div>
      </section>

      {/* Data */}
      <section>
        <h3 className={labelCls}>Data</h3>
        <div className={`mt-2 ${sectionCls}`}>
          <NavRow label="Export my data" hint="Download messages, settings, and account metadata" onClick={() => onNavigate('export')} />
        </div>
      </section>

      {/* Appearance */}
      <section>
        <h3 className={labelCls}>Appearance</h3>
        <div className="mt-2 grid grid-cols-3 gap-2" role="radiogroup" aria-label="Theme">
          {(['light', 'system', 'dark'] as ThemePreference[]).map((opt) => (
            <button
              key={opt}
              type="button"
              role="radio"
              aria-checked={themePref === opt}
              onClick={() => setThemePref(opt)}
              className={`min-h-[44px] rounded-lg text-sm font-medium capitalize transition-colors ${
                themePref === opt ? 'bg-blue-500 text-white' : 'bg-gray-100 dark:bg-slate-800 text-gray-700 dark:text-slate-300 hover:bg-gray-200 dark:hover:bg-slate-700'
              }`}
            >
              {opt === 'light' ? '☀️' : opt === 'dark' ? '🌙' : '⚙️'} {opt}
            </button>
          ))}
        </div>
      </section>

      {/* Notifications (web Notification API permission) */}
      <section>
        <h3 className={labelCls}>Notifications</h3>
        <div className={`mt-2 ${sectionCls} p-4`}>
          {notifPerm === 'unsupported' && (
            <p className="text-sm text-gray-500 dark:text-slate-400">This browser does not support notifications.</p>
          )}
          {notifPerm === 'granted' && (
            <p className="text-sm text-gray-700 dark:text-slate-300 flex items-center justify-between">Notifications are on <span className="text-green-600 dark:text-green-400">✓</span></p>
          )}
          {notifPerm === 'default' && (
            <button type="button" onClick={handleEnableNotifications} className="text-sm font-medium text-blue-600 dark:text-blue-400">
              Enable notifications
              <span className="block text-xs font-normal text-gray-500 dark:text-slate-400">Get pinged when you receive a message</span>
            </button>
          )}
          {notifPerm === 'denied' && (
            <p className="text-sm text-gray-700 dark:text-slate-300">
              Notifications are blocked.
              <span className="block text-xs text-gray-500 dark:text-slate-400">Re-enable them in your browser's site settings (lock icon in the address bar).</span>
            </p>
          )}
        </div>
      </section>

      {/* Contacts */}
      <section>
        <h3 className={labelCls}>Contacts</h3>
        <div className={`mt-2 ${sectionCls}`}>
          <NavRow label="Blocked users" hint="Manage who you've blocked" onClick={() => onNavigate('blocked')} />
        </div>
      </section>

      {/* Invite people (openchat-37z). QR + link point to the landing page,
          which branches to iOS TestFlight / web / Android — one QR for anyone. */}
      <section>
        <h3 className={labelCls}>Invite people</h3>
        <div className={`mt-2 ${sectionCls} p-4 flex flex-col items-center`}>
          <img src="/about/qr.svg" alt="Scan to download OpenChat" className="w-44 h-44 rounded-lg bg-white p-2" />
          <p className="mt-2 text-center text-sm text-gray-500 dark:text-slate-400">
            Scan to open the OpenChat download page — iOS TestFlight, web, or Android.
          </p>
          <button
            type="button"
            onClick={async () => {
              const url = 'https://chat.globalbr.ai';
              const text = `Try OpenChat — chat with a built-in AI assistant: ${url}`;
              const nav = navigator as Navigator & { share?: (d: { title?: string; text?: string; url?: string }) => Promise<void> };
              if (nav.share) { try { await nav.share({ title: 'OpenChat', text, url }); } catch { /* cancelled */ } return; }
              try { await navigator.clipboard.writeText(url); } catch { /* ignore */ }
            }}
            className="mt-3 flex min-h-[44px] w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-3 text-base font-semibold text-white shadow-sm transition hover:bg-blue-700"
          >
            📤 Share / copy invite link
          </button>
          <a href="https://testflight.apple.com/join/QvUPzDMY" target="_blank" rel="noopener" className="mt-2 w-full text-center rounded-lg border border-gray-200 dark:border-slate-700 px-4 py-2.5 text-sm font-medium text-gray-900 dark:text-slate-100 hover:bg-gray-100 dark:hover:bg-slate-800">
            Get the iOS app · TestFlight
          </a>
          <a href="/about" target="_blank" rel="noopener" className="mt-2 w-full text-center rounded-lg border border-gray-200 dark:border-slate-700 px-4 py-2.5 text-sm font-medium text-gray-900 dark:text-slate-100 hover:bg-gray-100 dark:hover:bg-slate-800">
            Open the download page
          </a>
        </div>
      </section>

      {/* About / provenance (openchat-3jq.3) */}
      <section>
        <h3 className={labelCls}>About</h3>
        <div className={`mt-2 ${sectionCls} p-4`}>
          <p className="text-xl font-semibold text-gray-950 dark:text-slate-50">{formatVersion()}</p>
          <dl className="mt-2 space-y-2 text-sm">
            <div className="flex justify-between gap-4"><dt className="text-gray-500 dark:text-slate-400">Build date</dt><dd className="text-right font-medium text-gray-900 dark:text-slate-100">{buildDateLabel}</dd></div>
            <div className="flex justify-between gap-4"><dt className="text-gray-500 dark:text-slate-400">Channel</dt><dd className="text-right font-medium text-gray-900 dark:text-slate-100 capitalize">{updateChannel()}</dd></div>
            <div className="flex justify-between gap-4"><dt className="text-gray-500 dark:text-slate-400">Commit</dt><dd className="text-right font-mono text-sm text-gray-900 dark:text-slate-100">{APP_GIT_SHA || 'unknown'}</dd></div>
            <div className="flex justify-between gap-4"><dt className="text-gray-500 dark:text-slate-400">Branch</dt><dd className="text-right font-mono text-sm text-gray-900 dark:text-slate-100">{APP_GIT_BRANCH || 'unknown'}</dd></div>
          </dl>
          <a href="https://github.com/IdeaFlowCo/OpenChat" target="_blank" rel="noopener" className="mt-3 flex items-center justify-between gap-4 border-t border-gray-100 dark:border-slate-800 pt-3 text-sm font-medium text-gray-900 dark:text-slate-100 hover:underline">
            <span>Source code · GitHub<span className="block text-xs font-normal text-gray-500 dark:text-slate-400">github.com/IdeaFlowCo/OpenChat — open source</span></span>
            <span className="text-gray-400">↗</span>
          </a>
          <label className="mt-3 flex items-center justify-between gap-4 border-t border-gray-100 dark:border-slate-800 pt-3">
            <span>
              <span className="block text-sm font-medium text-gray-900 dark:text-slate-100">Show version in top bar</span>
              <span className="block text-xs text-gray-500 dark:text-slate-400">Default: {IS_DEV_BUILD ? 'on in dev' : 'off in production'}</span>
            </span>
            <input type="checkbox" checked={showVersionInTopBar} onChange={(e) => onShowVersionInTopBarChange(e.target.checked)} className="h-5 w-5 accent-blue-500" />
          </label>
        </div>
      </section>

      {/* Legal & Account */}
      <section>
        <h3 className={labelCls}>Legal &amp; Account</h3>
        <div className={`mt-2 ${sectionCls}`}>
          <a href="https://chat.globalbr.ai/legal/privacy" target="_blank" rel="noopener noreferrer" className={rowCls}>
            <span className="text-sm font-medium text-gray-900 dark:text-slate-100">Privacy Policy</span>
            <span className="text-gray-400 dark:text-slate-500 text-lg">›</span>
          </a>
          <a href="https://chat.globalbr.ai/legal/terms" target="_blank" rel="noopener noreferrer" className={`${rowCls} border-t border-gray-100 dark:border-slate-800`}>
            <span className="text-sm font-medium text-gray-900 dark:text-slate-100">Terms of Service</span>
            <span className="text-gray-400 dark:text-slate-500 text-lg">›</span>
          </a>
          <div className="border-t border-gray-100 dark:border-slate-800">
            <NavRow label={deleting ? 'Deleting…' : 'Delete my account'} onClick={handleDeleteAccount} danger />
          </div>
        </div>
      </section>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Profile edit (OpenChat-tml)
// ─────────────────────────────────────────────────────────────────────────

function SecretaryView() {
  const [enabled, setEnabled] = useState(false);
  const [answers, setAnswers] = useState<SecretaryAnswer[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [status, setStatus] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);

  useEffect(() => {
    let active = true;
    api.getSecretary()
      .then((config) => {
        if (!active) return;
        setEnabled(config.enabled);
        setAnswers(config.answers);
      })
      .catch((error) => active && setStatus({ kind: 'error', text: error instanceof Error ? error.message : 'Could not load Secretary.' }))
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, []);

  const toggle = async () => {
    const next = !enabled;
    setEnabled(next);
    setStatus(null);
    try {
      await api.setSecretaryEnabled(next);
    } catch (error) {
      setEnabled(!next);
      setStatus({ kind: 'error', text: error instanceof Error ? error.message : 'Could not update Secretary.' });
    }
  };

  const reset = () => {
    setEditingId(null);
    setQuestion('');
    setAnswer('');
  };

  const edit = (entry: SecretaryAnswer) => {
    setEditingId(entry.id);
    setQuestion(entry.question);
    setAnswer(entry.answer);
    setStatus(null);
  };

  const save = async () => {
    if (!question.trim() || !answer.trim() || saving) return;
    setSaving(true);
    setStatus(null);
    try {
      const saved = editingId
        ? await api.updateSecretaryAnswer(editingId, { question: question.trim(), answer: answer.trim() })
        : await api.createSecretaryAnswer({ question: question.trim(), answer: answer.trim() });
      setAnswers((current) => editingId
        ? current.map((item) => item.id === editingId ? saved : item)
        : [...current, saved]);
      reset();
      setStatus({ kind: 'success', text: 'Quick answer saved.' });
    } catch (error) {
      setStatus({ kind: 'error', text: error instanceof Error ? error.message : 'Could not save quick answer.' });
    } finally {
      setSaving(false);
    }
  };

  const remove = async (entry: SecretaryAnswer) => {
    if (!window.confirm(`Delete the quick answer “${entry.question}”?`)) return;
    setStatus(null);
    try {
      await api.deleteSecretaryAnswer(entry.id);
      setAnswers((current) => current.filter((item) => item.id !== entry.id));
      if (editingId === entry.id) reset();
    } catch (error) {
      setStatus({ kind: 'error', text: error instanceof Error ? error.message : 'Could not delete quick answer.' });
    }
  };

  if (loading) return <p className="py-8 text-center text-sm text-gray-500 dark:text-slate-400">Loading Secretary…</p>;

  return (
    <div className="space-y-5">
      <section className="rounded-xl border border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-800/50 p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h3 className="font-semibold text-gray-900 dark:text-slate-100">Routine questions, handled</h3>
            <p className="mt-1 text-sm leading-5 text-gray-600 dark:text-slate-400">Replies in direct chats use only the exact answers you approve here.</p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            aria-label="Enable Secretary auto-replies"
            onClick={toggle}
            className={`relative h-7 w-12 shrink-0 rounded-full transition-colors ${enabled ? 'bg-blue-600' : 'bg-gray-300 dark:bg-slate-600'}`}
          >
            <span className={`absolute left-1 top-1 h-5 w-5 rounded-full bg-white shadow transition-transform ${enabled ? 'translate-x-5' : 'translate-x-0'}`} />
          </button>
        </div>
        <p className="mt-3 rounded-lg bg-white dark:bg-slate-900 px-3 py-2 text-xs leading-5 text-gray-500 dark:text-slate-400">Replies are visibly labeled “Secretary auto-reply.” Unmatched questions wait for you; group chats are never answered.</p>
      </section>

      <section>
        <h3 className={labelCls}>Approved quick answers</h3>
        <div className="mt-2 space-y-2">
          {answers.map((entry) => (
            <div key={entry.id} className={`rounded-lg border p-3 ${editingId === entry.id ? 'border-blue-500' : 'border-gray-200 dark:border-slate-700'}`}>
              <button type="button" onClick={() => edit(entry)} className="block w-full text-left">
                <span className="block text-sm font-semibold text-gray-900 dark:text-slate-100">{entry.question}</span>
                <span className="mt-1 block whitespace-pre-wrap text-sm text-gray-600 dark:text-slate-400">{entry.answer}</span>
              </button>
              <button type="button" onClick={() => void remove(entry)} className="mt-2 text-xs font-medium text-red-600 dark:text-red-400">Delete</button>
            </div>
          ))}
          {answers.length === 0 && <p className="py-3 text-center text-sm text-gray-500 dark:text-slate-400">Add one repetitive question to try the mode.</p>}
        </div>
      </section>

      <section className="rounded-xl border border-gray-200 dark:border-slate-700 p-4">
        <h3 className="font-semibold text-gray-900 dark:text-slate-100">{editingId ? 'Edit quick answer' : 'Add a quick answer'}</h3>
        <label className="mt-3 block text-xs font-semibold text-gray-600 dark:text-slate-400">
          When someone asks…
          <input
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            maxLength={200}
            placeholder="What is your address?"
            className="mt-1 min-h-[44px] w-full rounded-lg border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 text-sm font-normal text-gray-900 dark:text-slate-100 placeholder:text-gray-400"
          />
        </label>
        <label className="mt-3 block text-xs font-semibold text-gray-600 dark:text-slate-400">
          Reply with…
          <textarea
            value={answer}
            onChange={(event) => setAnswer(event.target.value)}
            maxLength={2000}
            rows={4}
            placeholder="The exact answer people should receive"
            className="mt-1 w-full resize-none rounded-lg border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 text-sm font-normal text-gray-900 dark:text-slate-100 placeholder:text-gray-400"
          />
        </label>
        <div className="mt-3 flex justify-end gap-2">
          {editingId && <button type="button" onClick={reset} className="min-h-[40px] rounded-lg border border-gray-300 dark:border-slate-700 px-4 text-sm font-medium text-gray-700 dark:text-slate-300">Cancel</button>}
          <button type="button" onClick={() => void save()} disabled={!question.trim() || !answer.trim() || saving} className="min-h-[40px] rounded-lg bg-blue-600 px-4 text-sm font-semibold text-white disabled:opacity-50">{saving ? 'Saving…' : editingId ? 'Save' : 'Add answer'}</button>
        </div>
      </section>

      {status && <p role="status" className={`text-sm ${status.kind === 'error' ? 'text-red-600 dark:text-red-400' : 'text-green-700 dark:text-green-400'}`}>{status.text}</p>}
    </div>
  );
}

function ProfileEditView({ onDone }: { onDone: () => void }) {
  const { currentUser } = useChat();
  const [name, setName] = useState(currentUser?.name ?? '');
  const [statusMessage, setStatusMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await api.updateProfile({ name: name.trim(), statusMessage: statusMessage.trim() });
      // The display name is also held in the auth session; update local copy.
      try {
        const raw = localStorage.getItem('openchat_user');
        if (raw) {
          const u = JSON.parse(raw);
          u.name = name.trim();
          localStorage.setItem('openchat_user', JSON.stringify(u));
        }
      } catch { /* best effort */ }
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save profile.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <label className="block">
        <span className="text-sm font-medium text-gray-700 dark:text-slate-300">Display name</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={80}
          placeholder="Your name"
          className="mt-1 w-full rounded-lg border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 text-base text-gray-900 dark:text-slate-100 focus:outline-none focus:border-blue-500"
        />
      </label>
      <label className="block">
        <span className="text-sm font-medium text-gray-700 dark:text-slate-300">Status message</span>
        <input
          value={statusMessage}
          onChange={(e) => setStatusMessage(e.target.value)}
          maxLength={120}
          placeholder="What's on your mind?"
          className="mt-1 w-full rounded-lg border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 text-base text-gray-900 dark:text-slate-100 focus:outline-none focus:border-blue-500"
        />
      </label>
      <p className="text-xs text-gray-500 dark:text-slate-400">{currentUser?.email}</p>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button
        type="button"
        onClick={handleSave}
        disabled={saving}
        className="min-h-[44px] w-full rounded-lg bg-blue-600 px-4 py-2 text-base font-semibold text-white disabled:opacity-50"
      >
        {saving ? 'Saving…' : 'Save'}
      </button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Agent keys management (OpenChat-7c9)
// ─────────────────────────────────────────────────────────────────────────

function AgentKeysView() {
  const [keys, setKeys] = useState<AgentKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [justCreated, setJustCreated] = useState<{ name: string; key: string } | null>(null);
  const [revealed, setRevealed] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setKeys(await api.listAgentKeys());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load keys.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const handleCreate = async () => {
    const name = newName.trim() || `Key ${new Date().toISOString().slice(0, 10)}`;
    if (creating) return;
    setCreating(true);
    setError(null);
    try {
      const result = await api.createAgentKey(name, ['read', 'write']);
      setJustCreated({ name: result.name, key: result.key });
      setNewName('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create key.');
    } finally {
      setCreating(false);
    }
  };

  const handleReveal = async (id: string) => {
    try {
      const { key } = await api.revealAgentKey(id);
      setRevealed((r) => ({ ...r, [id]: key }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reveal key.');
    }
  };

  const handleRevoke = async (id: string, name: string) => {
    if (!window.confirm(`Revoke "${name}"? All requests using it will fail immediately.`)) return;
    try {
      await api.revokeAgentKey(id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to revoke key.');
    }
  };

  const copy = (text: string) => navigator.clipboard.writeText(text).catch(() => {});

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-600 dark:text-slate-400">
        Each key gives an agent (Claude, Cursor, Codex, a script) bi-directional access to your conversations.
      </p>

      {/* Create */}
      <div className={`${sectionCls} p-4`}>
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="Key name (e.g. Claude Desktop)"
          className="w-full rounded-lg border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 text-sm text-gray-900 dark:text-slate-100 focus:outline-none focus:border-blue-500"
        />
        <button
          type="button"
          onClick={handleCreate}
          disabled={creating}
          className="mt-2 min-h-[40px] w-full rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          {creating ? 'Creating…' : '+ New key'}
        </button>
      </div>

      {justCreated && (
        <div className="rounded-lg border border-green-300 dark:border-green-800 bg-green-50 dark:bg-green-900/20 p-3">
          <p className="text-sm font-medium text-green-800 dark:text-green-300">Key “{justCreated.name}” created</p>
          <code className="mt-1 block break-all rounded bg-white dark:bg-slate-800 px-2 py-1 text-xs text-gray-900 dark:text-slate-100">{justCreated.key}</code>
          <button type="button" onClick={() => copy(justCreated.key)} className="mt-1 text-xs font-medium text-green-700 dark:text-green-400">Copy</button>
        </div>
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}
      {loading ? (
        <p className="text-sm text-gray-500 dark:text-slate-400">Loading…</p>
      ) : keys.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-slate-400">No keys yet.</p>
      ) : (
        <ul className="space-y-2">
          {keys.map((k) => {
            const revoked = !!k.revokedAt;
            return (
              <li key={k.id} className={`${sectionCls} p-3`}>
                <div className="flex items-center justify-between gap-2">
                  <span className={`text-sm font-medium ${revoked ? 'text-gray-400 line-through' : 'text-gray-900 dark:text-slate-100'}`}>{k.name}</span>
                  {revoked && <span className="rounded bg-red-100 dark:bg-red-900/40 px-1.5 py-0.5 text-[11px] font-bold text-red-600 dark:text-red-400">Revoked</span>}
                </div>
                <p className="font-mono text-xs text-gray-500 dark:text-slate-400">{k.keyPrefix}…</p>
                <p className="text-xs text-gray-400 dark:text-slate-500">
                  {k.lastUsedAt ? `Last used ${timeAgo(k.lastUsedAt)}` : 'Never used'}
                  {k.scopes?.length ? ` · ${k.scopes.join(', ')}` : ''}
                </p>
                {revealed[k.id] && (
                  <code className="mt-1 block break-all rounded bg-gray-100 dark:bg-slate-800 px-2 py-1 text-xs text-gray-900 dark:text-slate-100">{revealed[k.id]}</code>
                )}
                {!revoked && (
                  <div className="mt-2 flex gap-3 text-xs font-medium">
                    {revealed[k.id] ? (
                      <button type="button" onClick={() => copy(revealed[k.id])} className="text-blue-600 dark:text-blue-400">Copy</button>
                    ) : (
                      <button type="button" onClick={() => handleReveal(k.id)} className="text-blue-600 dark:text-blue-400">View full key</button>
                    )}
                    <button type="button" onClick={() => handleRevoke(k.id, k.name)} className="text-red-600 dark:text-red-400">Revoke</button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Blocked users (OpenChat-46p)
// ─────────────────────────────────────────────────────────────────────────

function BlockedUsersView() {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { loadConversations } = useChat();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setUsers(await api.listBlocked());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load blocked users.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const handleUnblock = async (u: User) => {
    if (!window.confirm(`Unblock ${u.name || u.email}?`)) return;
    try {
      await api.unblockUser(u.id);
      await load();
      await loadConversations();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to unblock.');
    }
  };

  if (loading) return <p className="text-sm text-gray-500 dark:text-slate-400">Loading…</p>;
  if (error) return <p className="text-sm text-red-600">{error}</p>;
  if (users.length === 0) return <p className="text-sm text-gray-500 dark:text-slate-400">You haven't blocked anyone.</p>;

  return (
    <ul className="space-y-2">
      {users.map((u) => (
        <li key={u.id} className={`${sectionCls} flex items-center justify-between gap-3 p-3`}>
          <div className="min-w-0">
            <p className="text-sm font-medium text-gray-900 dark:text-slate-100 truncate">{u.name || u.email}</p>
            {u.name && <p className="text-xs text-gray-500 dark:text-slate-400 truncate">{u.email}</p>}
          </div>
          <button type="button" onClick={() => handleUnblock(u)} className="shrink-0 rounded-lg border border-blue-500 px-3 py-1.5 text-sm font-medium text-blue-600 dark:text-blue-400">
            Unblock
          </button>
        </li>
      ))}
    </ul>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Data export
// ─────────────────────────────────────────────────────────────────────────

function ExportView() {
  const [busy, setBusy] = useState<ExportRangeKey | null>(null);
  const [status, setStatus] = useState<{ kind: 'success' | 'error'; message: string } | null>(null);

  const handleExport = async (range: ExportRangeKey) => {
    if (busy) return;
    setBusy(range);
    setStatus(null);
    try {
      const { filename, text } = await api.exportAccount(range);
      const saved = saveTextDownload(filename, text);
      setStatus({ kind: 'success', message: `Downloaded ${saved}` });
    } catch (err) {
      setStatus({ kind: 'error', message: err instanceof Error ? err.message : 'Export failed.' });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-sm text-gray-600 dark:text-slate-400">Download a JSON bundle of your OpenChat account. Pick a window.</p>
      <ul className={`${sectionCls}`}>
        {EXPORT_RANGE_OPTIONS.map((opt, i) => (
          <li key={opt.key} className={i > 0 ? 'border-t border-gray-100 dark:border-slate-800' : ''}>
            <button type="button" onClick={() => handleExport(opt.key)} disabled={!!busy} className={`${rowCls} disabled:opacity-60`}>
              <span>
                <span className="block text-sm font-medium text-gray-900 dark:text-slate-100">{opt.label}</span>
                <span className="block text-xs text-gray-500 dark:text-slate-400">{opt.detail}</span>
              </span>
              <span className="text-blue-600 dark:text-blue-400 text-lg">{busy === opt.key ? '…' : '↓'}</span>
            </button>
          </li>
        ))}
      </ul>
      {status && <p role="status" className={`text-sm ${status.kind === 'success' ? 'text-green-700 dark:text-green-400' : 'text-red-600'}`}>{status.message}</p>}
    </div>
  );
}
