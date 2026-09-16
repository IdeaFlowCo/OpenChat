import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { Platform } from 'react-native';
import {
  api,
  type ExperienceMode,
  type SocialPreferences,
} from '../api/client';
import { useChat } from './ChatContext';

export type LayoutPreference = 'auto' | 'compact' | 'split';

const LAYOUT_KEY = 'openchat.layout-preference';
const STORIES_COLLAPSED_KEY = 'openchat.stories-collapsed';
const STORIES_INTRO_KEY = 'openchat.stories-intro-dismissed';

const DEFAULT_PREFERENCES: SocialPreferences = {
  experienceMode: 'enhanced',
  networkPaused: false,
  updatedAt: null,
};

interface SocialExperienceValue {
  preferences: SocialPreferences;
  loading: boolean;
  error: string | null;
  enhanced: boolean;
  layoutPreference: LayoutPreference;
  storiesCollapsed: boolean;
  storiesIntroDismissed: boolean;
  setExperienceMode: (mode: ExperienceMode, pauseNetwork?: boolean) => Promise<void>;
  setNetworkPaused: (paused: boolean) => Promise<void>;
  setLayoutPreference: (preference: LayoutPreference) => Promise<void>;
  setStoriesCollapsed: (collapsed: boolean) => Promise<void>;
  dismissStoriesIntro: () => Promise<void>;
  refreshPreferences: () => Promise<void>;
}

const SocialExperienceContext = createContext<SocialExperienceValue | null>(null);

function webOverride(name: string): string | null {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get(name);
}

export function SocialExperienceProvider({ children }: { children: ReactNode }) {
  const { isAuthed } = useChat();
  const [preferences, setPreferences] = useState<SocialPreferences>(DEFAULT_PREFERENCES);
  const [layoutPreference, setLayoutPreferenceState] = useState<LayoutPreference>('auto');
  const [storiesCollapsed, setStoriesCollapsedState] = useState(false);
  const [storiesIntroDismissed, setStoriesIntroDismissed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      AsyncStorage.getItem(LAYOUT_KEY),
      AsyncStorage.getItem(STORIES_COLLAPSED_KEY),
      AsyncStorage.getItem(STORIES_INTRO_KEY),
    ]).then(([layout, collapsed, intro]) => {
      if (cancelled) return;
      if (layout === 'auto' || layout === 'compact' || layout === 'split') {
        setLayoutPreferenceState(layout);
      }
      setStoriesCollapsedState(collapsed === 'true');
      setStoriesIntroDismissed(intro === 'true');
    }).catch(() => {
      // Device-local display preferences are helpful, not boot-critical.
    });
    return () => { cancelled = true; };
  }, []);

  const refreshPreferences = useCallback(async () => {
    if (!isAuthed) {
      setPreferences(DEFAULT_PREFERENCES);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setPreferences(await api.getSocialPreferences());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load coordination preferences.');
    } finally {
      setLoading(false);
    }
  }, [isAuthed]);

  useEffect(() => {
    void refreshPreferences();
  }, [refreshPreferences]);

  const setExperienceMode = useCallback(async (mode: ExperienceMode, pauseNetwork = false) => {
    const next = await api.updateSocialPreferences({
      experienceMode: mode,
      ...(pauseNetwork ? { networkPaused: true } : {}),
    });
    setPreferences(next);
  }, []);

  const setNetworkPaused = useCallback(async (paused: boolean) => {
    setPreferences(await api.updateSocialPreferences({ networkPaused: paused }));
  }, []);

  const setLayoutPreference = useCallback(async (preference: LayoutPreference) => {
    setLayoutPreferenceState(preference);
    await AsyncStorage.setItem(LAYOUT_KEY, preference);
  }, []);

  const setStoriesCollapsed = useCallback(async (collapsed: boolean) => {
    setStoriesCollapsedState(collapsed);
    await AsyncStorage.setItem(STORIES_COLLAPSED_KEY, String(collapsed));
  }, []);

  const dismissStoriesIntro = useCallback(async () => {
    setStoriesIntroDismissed(true);
    await AsyncStorage.setItem(STORIES_INTRO_KEY, 'true');
  }, []);

  const experienceOverride = webOverride('experience');
  const layoutOverride = webOverride('layout');
  const effectivePreferences: SocialPreferences = experienceOverride === 'simple' || experienceOverride === 'enhanced'
    ? { ...preferences, experienceMode: experienceOverride }
    : preferences;
  const effectiveLayout = layoutOverride === 'auto' || layoutOverride === 'compact' || layoutOverride === 'split'
    ? layoutOverride
    : layoutPreference;

  const value = useMemo<SocialExperienceValue>(() => ({
    preferences: effectivePreferences,
    loading,
    error,
    enhanced: effectivePreferences.experienceMode === 'enhanced',
    layoutPreference: effectiveLayout,
    storiesCollapsed,
    storiesIntroDismissed,
    setExperienceMode,
    setNetworkPaused,
    setLayoutPreference,
    setStoriesCollapsed,
    dismissStoriesIntro,
    refreshPreferences,
  }), [
    effectivePreferences,
    loading,
    error,
    effectiveLayout,
    storiesCollapsed,
    storiesIntroDismissed,
    setExperienceMode,
    setNetworkPaused,
    setLayoutPreference,
    setStoriesCollapsed,
    dismissStoriesIntro,
    refreshPreferences,
  ]);

  return (
    <SocialExperienceContext.Provider value={value}>
      {children}
    </SocialExperienceContext.Provider>
  );
}

export function useSocialExperience(): SocialExperienceValue {
  const value = useContext(SocialExperienceContext);
  if (!value) throw new Error('useSocialExperience must be used inside SocialExperienceProvider');
  return value;
}
