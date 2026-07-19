import { Platform } from 'react-native';

export const isThoughtStreamPrototype =
  Platform.OS === 'web' &&
  typeof globalThis.location !== 'undefined' &&
  new URLSearchParams(globalThis.location.search).get('prototype') === 'thought-stream';
