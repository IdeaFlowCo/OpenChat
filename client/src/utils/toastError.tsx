// Dismissible error toast helper (OpenChat-X).
//
// The plain react-hot-toast `toast.error(msg)` renders without any dismiss
// affordance: no × button, no click-to-dismiss, no keyboard shortcut, no
// aria-live region for assistive tech. Users who hit a transient error see
// a banner appear for 6s and then disappear without ever being acknowledged.
// During an auth-expired cascade (multiple endpoints 401 simultaneously)
// the same toast can fire 5+ times and stack with no way to clear them.
//
// This helper renders a `toast.custom` toast that:
//   - has an explicit × close button (real <button aria-label="Dismiss">)
//   - is itself click-anywhere-to-dismiss
//   - uses role="alert" + aria-live="assertive" for screen readers
//   - supports stable `id` for callers that re-fire (e.g. loadConversations
//     on every focus event): a duplicate id replaces the existing toast
//     instead of stacking
//   - keeps the same default 6-second auto-dismiss as the original config
//
// Usage:
//   toastError('Failed to load conversations', { id: 'load-conversations' });
//   toastError('Search failed: timeout', { id: 'search', duration: 4000 });

import toast from 'react-hot-toast';

export interface ToastErrorOptions {
  /**
   * Stable identifier — passing the same `id` from multiple call sites
   * makes the latest toast replace any in-flight one rather than stacking.
   * Crucial for callers that re-fire on focus / reconnect / poll loops.
   */
  id?: string;
  /** Override the default 6000ms auto-dismiss. Use 0 for "stay forever". */
  duration?: number;
}

const DEFAULT_DURATION = 6000;

export function toastError(message: string, options: ToastErrorOptions = {}): string {
  const { id, duration = DEFAULT_DURATION } = options;

  return toast.custom(
    (t) => (
      <div
        role="alert"
        aria-live="assertive"
        onClick={() => toast.dismiss(t.id)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          background: '#fee2e2',
          color: '#991b1b',
          lineHeight: 1.4,
          maxWidth: 380,
          padding: '10px 14px',
          borderRadius: 8,
          boxShadow: '0 4px 12px rgba(0, 0, 0, 0.08), 0 2px 4px rgba(0, 0, 0, 0.05)',
          fontFamily: 'system-ui, sans-serif',
          fontSize: 14,
          cursor: 'pointer',
          opacity: t.visible ? 1 : 0,
          transform: t.visible ? 'translateY(0)' : 'translateY(-4px)',
          transition: 'opacity 150ms ease, transform 150ms ease',
          pointerEvents: 'auto',
        }}
      >
        <span aria-hidden="true" style={{ fontSize: 16, lineHeight: 1 }}>
          ⚠
        </span>
        <span style={{ flex: 1, minWidth: 0 }}>{message}</span>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={(e) => {
            e.stopPropagation();
            toast.dismiss(t.id);
          }}
          style={{
            background: 'transparent',
            border: 'none',
            color: '#991b1b',
            padding: 4,
            margin: -4,
            cursor: 'pointer',
            fontSize: 18,
            lineHeight: 1,
            borderRadius: 4,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background =
              'rgba(153, 27, 27, 0.1)';
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
          }}
        >
          ×
        </button>
      </div>
    ),
    { id, duration }
  );
}
