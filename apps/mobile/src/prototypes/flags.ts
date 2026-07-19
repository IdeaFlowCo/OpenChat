import { Platform } from 'react-native';

export const isThoughtStreamPrototype =
  Platform.OS === 'web' &&
  typeof globalThis.location !== 'undefined' &&
  new URLSearchParams(globalThis.location.search).get('prototype') === 'thought-stream';

export const THOUGHT_STREAM_PROXY_PREFIX = '/__thought-stream-proxy';

// Local web evaluation uses Metro's fixed-target proxy to avoid changing the
// production APIs' CORS allowlists for a private Tailscale origin.
export const thoughtStreamPrototypeProxyOrigin =
  isThoughtStreamPrototype && __DEV__ && typeof globalThis.location !== 'undefined'
    ? globalThis.location.origin
    : null;
