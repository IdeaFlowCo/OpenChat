/**
 * Theme preference with system-follow option.
 *
 * Mirrors web ThemeContext (`light` / `dark` / `system`). The choice is
 * persisted; the *effective* scheme either comes from useColorScheme()
 * when set to 'system' or from the explicit override. Consumed by all
 * screens via `useTheme()`; existing `useColorScheme()` callers should
 * migrate to `useTheme().scheme` so the manual toggle takes effect.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  ReactNode,
} from 'react';
import { useColorScheme } from 'react-native';

const STORAGE_KEY = 'openchat_theme_pref';

export type ThemePref = 'light' | 'dark' | 'system';
export type Scheme = 'light' | 'dark';

interface ThemeContextValue {
  /** What the user picked. Persisted. */
  preference: ThemePref;
  /** Resolved effective scheme — pass to getColors(). */
  scheme: Scheme;
  /** Set + persist the preference. */
  setPreference: (p: ThemePref) => Promise<void>;
}

const Ctx = createContext<ThemeContextValue | null>(null);

export function useTheme(): ThemeContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useTheme must be used inside <ThemeProvider>');
  return v;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const systemScheme = (useColorScheme() || 'light') as Scheme;
  const [preference, setPrefState] = useState<ThemePref>('system');
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const stored = await AsyncStorage.getItem(STORAGE_KEY);
        if (stored === 'light' || stored === 'dark' || stored === 'system') {
          setPrefState(stored);
        }
      } catch {
        // first run / bad json — leave default 'system'
      } finally {
        setHydrated(true);
      }
    })();
  }, []);

  const setPreference = useCallback(async (p: ThemePref) => {
    setPrefState(p);
    try {
      await AsyncStorage.setItem(STORAGE_KEY, p);
    } catch (err) {
      console.warn('[ThemeContext] persist failed:', err);
    }
  }, []);

  const scheme: Scheme = preference === 'system' ? systemScheme : preference;

  const value = useMemo<ThemeContextValue>(
    () => ({ preference, scheme, setPreference }),
    [preference, scheme, setPreference]
  );

  // Render even before hydration completes; the worst case is a brief
  // pre-hydration paint at 'system'. Block-rendering during AsyncStorage
  // I/O would show a black flash on cold start.
  void hydrated;

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
