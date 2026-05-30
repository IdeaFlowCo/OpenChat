import { useEffect, useRef, useState } from 'react';
import { useChat } from '../contexts/ChatContext';
import {
  BeforeInstallPromptEvent,
  getDeferredPrompt,
  getEngagement,
  isCurrentlySnoozed,
  isIOSSafari,
  isStandalone,
  recordEngagementTick,
  recordSessionStart,
  snoozeInstallPrompt,
  subscribeDeferredPrompt,
  triggerInstall,
} from '../utils/installPrompt';

// Engagement thresholds for showing the install prompt. The intent is to
// only nag people who have actually adopted OpenChat — not first-time
// visitors who might have shown up via a random link.
const MIN_SESSIONS = 2;
const MIN_SECONDS = 3 * 60; // 3 minutes cumulative
const POST_MOUNT_DELAY_MS = 5000;
const ENGAGEMENT_TICK_MS = 30_000;

type Variant = 'native' | 'ios';

export function InstallPrompt() {
  const { token } = useChat();
  const [visible, setVisible] = useState(false);
  const [mountedAnimation, setMountedAnimation] = useState(false);
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(getDeferredPrompt());
  const [variant, setVariant] = useState<Variant | null>(null);
  const [installing, setInstalling] = useState(false);
  const sessionRecordedRef = useRef(false);
  const showTimerRef = useRef<number | null>(null);

  // Subscribe to deferred-prompt changes so if the event arrives AFTER
  // mount we still pick it up.
  useEffect(() => {
    const unsub = subscribeDeferredPrompt((evt) => setDeferred(evt));
    return unsub;
  }, []);

  // Record session start once we know there's a logged-in user. We
  // deliberately *don't* count anonymous visits — they're not engaged
  // sessions in the product sense.
  useEffect(() => {
    if (!token || sessionRecordedRef.current) return;
    sessionRecordedRef.current = true;
    recordSessionStart();
  }, [token]);

  // Tick cumulative engagement seconds every 30s while focused + signed
  // in. document.hidden guards background tabs.
  useEffect(() => {
    if (!token) return;
    const id = window.setInterval(() => {
      if (document.hidden) return;
      recordEngagementTick(ENGAGEMENT_TICK_MS / 1000);
    }, ENGAGEMENT_TICK_MS);
    return () => window.clearInterval(id);
  }, [token]);

  // Decide whether/when to show the prompt.
  useEffect(() => {
    if (!token) {
      setVisible(false);
      return;
    }
    if (isStandalone()) return;
    if (isCurrentlySnoozed()) return;

    const { sessions, seconds } = getEngagement();
    if (sessions < MIN_SESSIONS || seconds < MIN_SECONDS) return;

    let chosen: Variant | null = null;
    if (deferred) {
      chosen = 'native';
    } else if (isIOSSafari()) {
      chosen = 'ios';
    } else {
      return;
    }

    if (showTimerRef.current) window.clearTimeout(showTimerRef.current);
    showTimerRef.current = window.setTimeout(() => {
      setVariant(chosen);
      setVisible(true);
      // Trigger fade-in on next frame so the transition runs.
      requestAnimationFrame(() => setMountedAnimation(true));
    }, POST_MOUNT_DELAY_MS);

    return () => {
      if (showTimerRef.current) {
        window.clearTimeout(showTimerRef.current);
        showTimerRef.current = null;
      }
    };
  }, [token, deferred]);

  const hide = () => {
    setMountedAnimation(false);
    window.setTimeout(() => setVisible(false), 200);
  };

  const handleInstall = async () => {
    setInstalling(true);
    const result = await triggerInstall();
    setInstalling(false);
    if (result === 'accepted') {
      hide();
    } else if (result === 'dismissed') {
      snoozeInstallPrompt(30);
      hide();
    } else {
      // unavailable — fall back to snooze so we don't loop
      snoozeInstallPrompt(7);
      hide();
    }
  };

  const handleSnooze = () => {
    snoozeInstallPrompt(30);
    hide();
  };

  if (!visible || !variant) return null;

  const headline = variant === 'ios' ? 'Add OpenChat to your Home Screen' : 'Install OpenChat';
  const subhead =
    variant === 'ios'
      ? 'Tap the Share icon, then “Add to Home Screen”.'
      : 'Faster access, push notifications, works offline.';

  // z-40 sits above page content and the Noos feedback widget (which we
  // run at z-30 / unset), but below the react-hot-toast container
  // (z-9999 by default).
  return (
    <div
      className={[
        'fixed z-40 pointer-events-none',
        // Mobile: bottom sheet. Desktop: top-right card.
        'inset-x-0 bottom-0 sm:inset-auto sm:top-16 sm:right-4 sm:bottom-auto sm:left-auto',
        'transition-all duration-200 ease-out',
        mountedAnimation
          ? 'opacity-100 translate-y-0'
          : 'opacity-0 translate-y-4 sm:translate-y-0 sm:-translate-y-2',
      ].join(' ')}
      role="dialog"
      aria-labelledby="openchat-install-headline"
    >
      <div
        className={[
          'pointer-events-auto bg-white border border-gray-200 shadow-xl',
          // Mobile sheet: full width, top corners rounded, safe-area padding.
          'rounded-t-2xl pb-safe sm:pb-0 sm:rounded-2xl',
          'sm:w-[22rem] sm:mr-0 sm:max-w-[calc(100vw-2rem)]',
        ].join(' ')}
      >
        <div className="p-4 sm:p-5">
          <div className="flex items-start gap-3">
            <div className="flex-shrink-0 w-10 h-10 rounded-xl bg-blue-500 text-white flex items-center justify-center">
              {variant === 'ios' ? <ShareIcon /> : <DownloadIcon />}
            </div>
            <div className="flex-1 min-w-0">
              <div id="openchat-install-headline" className="font-semibold text-gray-900 text-sm">
                {headline}
              </div>
              <div className="text-xs text-gray-500 mt-0.5 leading-snug">{subhead}</div>
            </div>
            <button
              onClick={handleSnooze}
              aria-label="Dismiss"
              className="flex-shrink-0 -mr-1 -mt-1 w-7 h-7 rounded-full text-gray-400 hover:text-gray-600 hover:bg-gray-100 active:bg-gray-200 flex items-center justify-center text-lg leading-none"
            >
              ×
            </button>
          </div>

          <div className="flex items-center gap-2 mt-4">
            {variant === 'native' ? (
              <>
                <button
                  onClick={handleSnooze}
                  className="flex-1 px-4 py-2 min-h-[40px] text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 active:bg-gray-300 rounded-full transition-colors"
                >
                  Not now
                </button>
                <button
                  onClick={handleInstall}
                  disabled={installing}
                  className="flex-1 px-4 py-2 min-h-[40px] text-sm font-medium text-white bg-blue-500 hover:bg-blue-600 active:bg-blue-700 disabled:opacity-60 rounded-full transition-colors"
                >
                  {installing ? 'Installing…' : 'Install'}
                </button>
              </>
            ) : (
              <button
                onClick={handleSnooze}
                className="flex-1 px-4 py-2 min-h-[40px] text-sm font-medium text-white bg-blue-500 hover:bg-blue-600 active:bg-blue-700 rounded-full transition-colors"
              >
                Got it
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function DownloadIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="w-5 h-5"
      aria-hidden="true"
    >
      <path d="M12 3v12" />
      <path d="m7 10 5 5 5-5" />
      <path d="M5 21h14" />
    </svg>
  );
}

function ShareIcon() {
  // iOS-style share glyph: square with arrow up.
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="w-5 h-5"
      aria-hidden="true"
    >
      <path d="M12 3v13" />
      <path d="m7 8 5-5 5 5" />
      <path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" />
    </svg>
  );
}
