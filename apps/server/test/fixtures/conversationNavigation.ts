import { useEffect, useSyncExternalStore } from 'react';

let route = { name: 'Chat', params: { conversationId: 'sailing' } };
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
const getRoute = () => route;
export const useRoute = () => useSyncExternalStore(subscribe, getRoute, getRoute);
export const useFocusEffect = (effect: () => void | (() => void)) => useEffect(effect, [effect]);
const navigation = {
  setOptions() {},
  navigate(name: string, params: { conversationId: string }) {
    route = { name, params };
    for (const listener of listeners) listener();
  },
};
export const useNavigation = () => navigation;
