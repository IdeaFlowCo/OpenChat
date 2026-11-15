import { useEffect, useState } from 'react';
import { AppState, Platform } from 'react-native';
import Constants from 'expo-constants';
import { exactStamp, relativeStamp, stampTime, type AppStampData } from '../utils/appStamp';

export function useAppStamp() {
  const [now, setNow] = useState(Date.now);
  const [exact, setExact] = useState(false);
  const stamp: AppStampData = { ...(Constants.expoConfig?.extra?.appStamp ?? {}), version: Constants.expoConfig?.version ?? '?' };
  const time = stampTime(stamp);
  useEffect(() => {
    if (!time) return;
    let timer: ReturnType<typeof setInterval> | undefined;
    const refresh = () => setNow(Date.now());
    const active = (visible: boolean) => {
      clearInterval(timer);
      timer = undefined;
      if (visible) { refresh(); timer = setInterval(refresh, 60000); }
    };
    if (Platform.OS === 'web' && typeof document !== 'undefined') {
      const visibility = () => active(document.visibilityState === 'visible');
      document.addEventListener('visibilitychange', visibility);
      visibility();
      return () => { clearInterval(timer); document.removeEventListener('visibilitychange', visibility); };
    }
    active(AppState.currentState === 'active');
    const subscription = AppState.addEventListener('change', state => active(state === 'active'));
    return () => { clearInterval(timer); subscription.remove(); };
  }, [time]);
  const detail = time ? exactStamp(stamp, time) : null;
  return { version: stamp.version, time, detail, exact, toggle: () => setExact(value => !value), label: time ? `Updated ${exact ? detail : relativeStamp(time, now)}` : null };
}
