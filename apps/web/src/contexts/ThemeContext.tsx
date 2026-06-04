import { createContext, useContext, useEffect, useState, ReactNode } from 'react';

export type ThemePreference = 'light' | 'dark' | 'system';

interface ThemeContextValue {
  /** What the user picked (their override). */
  preference: ThemePreference;
  /** What's actually active right now (system pref resolved). */
  resolvedTheme: 'light' | 'dark';
  setPreference: (next: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

const STORAGE_KEY = 'openchat_theme';

function readSavedPreference(): ThemePreference {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'light' || saved === 'dark' || saved === 'system') return saved;
  } catch {
    /* localStorage unavailable */
  }
  return 'system';
}

function systemPrefersDark(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function applyToHtml(resolved: 'light' | 'dark'): void {
  const el = document.documentElement;
  if (resolved === 'dark') el.classList.add('dark');
  else el.classList.remove('dark');
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(() => readSavedPreference());
  const [resolvedTheme, setResolvedTheme] = useState<'light' | 'dark'>(() => {
    const initial = readSavedPreference();
    if (initial === 'dark') return 'dark';
    if (initial === 'light') return 'light';
    return systemPrefersDark() ? 'dark' : 'light';
  });

  // Recompute resolved theme on preference change OR system change.
  useEffect(() => {
    function recompute(): void {
      const next: 'light' | 'dark' =
        preference === 'dark'
          ? 'dark'
          : preference === 'light'
            ? 'light'
            : systemPrefersDark()
              ? 'dark'
              : 'light';
      setResolvedTheme(next);
      applyToHtml(next);
    }
    recompute();
    if (preference !== 'system') return;
    // In system mode, react to OS changes live.
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (): void => recompute();
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else mq.addListener(onChange); // older Safari
    return () => {
      if (mq.removeEventListener) mq.removeEventListener('change', onChange);
      else mq.removeListener(onChange);
    };
  }, [preference]);

  const setPreference = (next: ThemePreference): void => {
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* localStorage unavailable */
    }
    setPreferenceState(next);
  };

  return (
    <ThemeContext.Provider value={{ preference, resolvedTheme, setPreference }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used inside <ThemeProvider>');
  return ctx;
}
