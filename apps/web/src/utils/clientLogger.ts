type LogLevel = 'error' | 'warn' | 'info';

interface ClientLogPayload {
  level: LogLevel;
  message: string;
  error?: {
    name?: string;
    message?: string;
    stack?: string;
  };
  request?: {
    method?: string;
    url?: string;
    status?: number;
    statusText?: string;
    type?: 'fetch' | 'xhr' | 'websocket' | 'unknown';
  };
  context?: Record<string, unknown>;
  tags?: Record<string, string | number | boolean | null>;
}

const LOG_ENDPOINT = '/api/client-logs';
const SESSION_ID_KEY = 'oc_session_id';
const TAB_ID_KEY = 'oc_tab_id';

const getOrCreateId = (storage: Storage, key: string) => {
  const existing = storage.getItem(key);
  if (existing) return existing;
  const id = crypto.randomUUID();
  storage.setItem(key, id);
  return id;
};

const sessionId = getOrCreateId(localStorage, SESSION_ID_KEY);
const tabId = getOrCreateId(sessionStorage, TAB_ID_KEY);

let storageEstimate: { quota?: number; usage?: number } | null = null;
let storagePersisted: boolean | null = null;

const initStorageHints = async () => {
  try {
    if (navigator.storage?.estimate) {
      storageEstimate = await navigator.storage.estimate();
    }
    if (navigator.storage?.persisted) {
      storagePersisted = await navigator.storage.persisted();
    }
  } catch {
    // Best effort only.
  }
};

void initStorageHints();

const buildBaseContext = () => ({
  sessionId,
  tabId,
  url: window.location.href,
  referrer: document.referrer || null,
  userAgent: navigator.userAgent,
  language: navigator.language,
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  visibility: document.visibilityState,
  mode: import.meta.env.MODE,
  storage: {
    quota: storageEstimate?.quota ?? null,
    usage: storageEstimate?.usage ?? null,
    persisted: storagePersisted
  }
});

const sendLog = async (payload: ClientLogPayload) => {
  try {
    await fetch(LOG_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        timestamp: new Date().toISOString(),
        ...payload,
        context: {
          ...buildBaseContext(),
          ...(payload.context || {})
        }
      }),
      keepalive: true,
      credentials: 'include'
    });
  } catch {
    // Avoid recursive logging loops.
  }
};

export const initClientLogging = () => {
  window.addEventListener('error', (event) => {
    void sendLog({
      level: 'error',
      message: event.message || 'Unhandled error',
      error: {
        name: event.error?.name,
        message: event.error?.message,
        stack: event.error?.stack
      },
      tags: {
        source: 'window.onerror'
      }
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason as Error | null;
    void sendLog({
      level: 'error',
      message: reason?.message || 'Unhandled promise rejection',
      error: {
        name: reason?.name,
        message: reason?.message || String(event.reason),
        stack: reason?.stack
      },
      tags: {
        source: 'unhandledrejection'
      }
    });
  });
};

export const reportFetchError = (details: { url: string; method: string; error: unknown }) => {
  const err = details.error as Error | null;
  void sendLog({
    level: 'error',
    message: err?.message || 'Fetch failed',
    error: {
      name: err?.name,
      message: err?.message,
      stack: err?.stack
    },
    request: {
      method: details.method,
      url: details.url,
      type: 'fetch'
    },
    tags: {
      source: 'fetch'
    }
  });
};

export const reportHttpError = (details: { url: string; method: string; status: number; statusText: string }) => {
  void sendLog({
    level: 'warn',
    message: `HTTP ${details.status} ${details.statusText}`,
    request: {
      method: details.method,
      url: details.url,
      status: details.status,
      statusText: details.statusText,
      type: 'fetch'
    },
    tags: {
      source: 'http'
    }
  });
};
