import {
  APP_BUILD_DATE,
  APP_GIT_BRANCH,
  APP_GIT_SHA,
  IS_DEV_BUILD,
  formatVersion,
} from '../utils/appVersion';

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
      <div className="flex max-h-[90vh] w-full flex-col rounded-t-2xl bg-white shadow-xl md:max-w-lg md:rounded-2xl">
        <div className="flex items-center justify-between gap-3 border-b border-gray-200 px-4 py-3">
          <h2 id="settings-title" className="text-base font-semibold text-gray-900">
            Settings
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close settings"
            className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full text-gray-500 hover:bg-gray-100 hover:text-gray-900"
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
              <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
            </svg>
          </button>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto p-4">
          <section className="rounded-lg border border-gray-200 bg-gray-50 p-4">
            <div className="mb-3 flex items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold uppercase tracking-wide text-gray-500">About</h3>
                <p className="mt-1 text-xl font-semibold text-gray-950">{formatVersion()}</p>
              </div>
            </div>
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between gap-4">
                <dt className="text-gray-500">Version</dt>
                <dd className="text-right font-medium text-gray-900">{formatVersion()}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-gray-500">Build date</dt>
                <dd className="text-right font-medium text-gray-900">{buildDateLabel}</dd>
              </div>
              {IS_DEV_BUILD && (
                <>
                  <div className="flex justify-between gap-4">
                    <dt className="text-gray-500">Commit</dt>
                    <dd className="text-right font-mono text-sm text-gray-900">{APP_GIT_SHA || 'unknown'}</dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-gray-500">Branch</dt>
                    <dd className="text-right font-mono text-sm text-gray-900">{APP_GIT_BRANCH || 'unknown'}</dd>
                  </div>
                </>
              )}
            </dl>
          </section>

          <section className="rounded-lg border border-gray-200 p-4">
            <label className="flex items-center justify-between gap-4">
              <span>
                <span className="block text-sm font-medium text-gray-900">Show version in top bar</span>
                <span className="block text-xs text-gray-500">Default: {IS_DEV_BUILD ? 'on in dev' : 'off in production'}</span>
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
