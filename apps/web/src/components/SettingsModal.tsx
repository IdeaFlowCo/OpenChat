import { useState } from 'react';
import {
  APP_BUILD_DATE,
  APP_GIT_BRANCH,
  APP_GIT_SHA,
  IS_DEV_BUILD,
  formatVersion,
} from '../utils/appVersion';
import { api } from '../api';
import { buildAgentSetupBlob } from '../utils/agentSetupBlob';
import { useTheme, ThemePreference } from '../contexts/ThemeContext';

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  showVersionInTopBar: boolean;
  onShowVersionInTopBarChange: (value: boolean) => void;
}

export function SettingsModal({
  open,
  onClose,
  showVersionInTopBar,
  onShowVersionInTopBarChange,
}: SettingsModalProps) {
  // One-click "Copy agent setup" (openchat-bbr): mints a key + copies the
  // tool-less paste-anywhere REST blob. No navigation, no reveal step.
  const [minting, setMinting] = useState(false);
  const [setupStatus, setSetupStatus] = useState<
    { kind: 'success' | 'error'; message: string } | null
  >(null);
  const { preference: themePref, setPreference: setThemePref } = useTheme();

  const handleCopyAgentSetup = async () => {
    if (minting) return;
    setMinting(true);
    setSetupStatus(null);
    try {
      const result = await api.createAgentKey(
        `Quick setup ${new Date().toISOString().slice(0, 10)}`,
        ['read', 'write'],
      );
      const blob = buildAgentSetupBlob(result.key, window.location.origin);
      await navigator.clipboard.writeText(blob);
      setSetupStatus({
        kind: 'success',
        message: 'Copied! Paste it into ChatGPT, Claude, Gemini, or any chatbot — no install needed.',
      });
    } catch (err) {
      setSetupStatus({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Failed to create agent setup. Please try again.',
      });
    } finally {
      setMinting(false);
    }
  };

  if (!open) return null;

  const buildDate = new Date(APP_BUILD_DATE);
  const buildDateLabel = Number.isNaN(buildDate.getTime())
    ? APP_BUILD_DATE
    : buildDate.toLocaleString();

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
          <h2 id="settings-title" className="text-base font-semibold text-gray-900 dark:text-slate-100">
            Settings
          </h2>
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
          {/*
           * One-click "Copy agent setup" (openchat-bbr). TRUE one-tap: mints
           * a key + copies a paste-anywhere setup blob for ChatGPT, Claude,
           * any LLM. No navigation, no reveal step.
           */}
          <section className="rounded-lg border border-blue-200 dark:border-blue-900 bg-blue-50 dark:bg-blue-900/20 p-4">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-blue-600 dark:text-blue-400">
              OpenChat for agents
            </h3>
            <button
              type="button"
              onClick={handleCopyAgentSetup}
              disabled={minting}
              className="mt-3 flex min-h-[44px] w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-3 text-base font-semibold text-white shadow-sm transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {minting ? 'Minting key…' : '📋  Copy agent setup'}
            </button>
            <p className="mt-2 text-xs text-gray-600 dark:text-slate-400">
              Mints a key + copies a paste-anywhere setup for ChatGPT, Claude, any LLM.
            </p>
            {setupStatus && (
              <p
                role="status"
                className={`mt-2 text-sm ${
                  setupStatus.kind === 'success' ? 'text-green-700' : 'text-red-600'
                }`}
              >
                {setupStatus.message}
              </p>
            )}
          </section>

          <section className="rounded-lg border border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-800/50 p-4">
            <div className="mb-3 flex items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold uppercase tracking-wide text-gray-500 dark:text-slate-400">About</h3>
                <p className="mt-1 text-xl font-semibold text-gray-950 dark:text-slate-50">{formatVersion()}</p>
              </div>
            </div>
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between gap-4">
                <dt className="text-gray-500 dark:text-slate-400">Version</dt>
                <dd className="text-right font-medium text-gray-900 dark:text-slate-100">{formatVersion()}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-gray-500 dark:text-slate-400">Build date</dt>
                <dd className="text-right font-medium text-gray-900 dark:text-slate-100">{buildDateLabel}</dd>
              </div>
              {IS_DEV_BUILD && (
                <>
                  <div className="flex justify-between gap-4">
                    <dt className="text-gray-500 dark:text-slate-400">Commit</dt>
                    <dd className="text-right font-mono text-sm text-gray-900 dark:text-slate-100">{APP_GIT_SHA || 'unknown'}</dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-gray-500 dark:text-slate-400">Branch</dt>
                    <dd className="text-right font-mono text-sm text-gray-900 dark:text-slate-100">{APP_GIT_BRANCH || 'unknown'}</dd>
                  </div>
                </>
              )}
            </dl>
          </section>

          {/* Theme picker (openchat-dpy). System default follows OS preference. */}
          <section className="rounded-lg border border-gray-200 dark:border-slate-700 p-4">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-gray-500 dark:text-slate-400">Appearance</h3>
            <div className="mt-3 grid grid-cols-3 gap-2" role="radiogroup" aria-label="Theme">
              {(['light', 'system', 'dark'] as ThemePreference[]).map((opt) => (
                <button
                  key={opt}
                  type="button"
                  role="radio"
                  aria-checked={themePref === opt}
                  onClick={() => setThemePref(opt)}
                  className={`min-h-[44px] rounded-lg text-sm font-medium capitalize transition-colors ${
                    themePref === opt
                      ? 'bg-blue-500 text-white'
                      : 'bg-gray-100 dark:bg-slate-800 text-gray-700 dark:text-slate-300 hover:bg-gray-200 dark:hover:bg-slate-700'
                  }`}
                >
                  {opt === 'light' ? '☀️' : opt === 'dark' ? '🌙' : '⚙️'} {opt}
                </button>
              ))}
            </div>
          </section>

          <section className="rounded-lg border border-gray-200 dark:border-slate-700 p-4">
            <label className="flex items-center justify-between gap-4">
              <span>
                <span className="block text-sm font-medium text-gray-900 dark:text-slate-100">Show version in top bar</span>
                <span className="block text-xs text-gray-500 dark:text-slate-400">Default: {IS_DEV_BUILD ? 'on in dev' : 'off in production'}</span>
              </span>
              <input
                type="checkbox"
                checked={showVersionInTopBar}
                onChange={(event) => onShowVersionInTopBarChange(event.target.checked)}
                className="h-5 w-5 accent-blue-500"
              />
            </label>
          </section>
        </div>
      </div>
    </div>
  );
}
