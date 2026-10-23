import { describe, expect, it, vi } from 'vitest';

// App builds before OpenChat-zwt4 lack the native modules: Save must fall
// back to the share sheet and rotation must be a no-op, not a crash. Release
// builds report a module that throws while loading as fatal before an
// import() can reject, so the packages must never be loaded at all.
const m = vi.hoisted(() => ({
  loaded: [] as string[],
  download: vi.fn(async (_url: string, dest: string) => ({ uri: dest, status: 200 })),
  share: vi.fn(async () => ({ action: 'sharedAction' })),
}));
vi.mock('react-native', () => ({
  Platform: { OS: 'ios', select: (v: any) => v.ios ?? v.default },
  Share: { share: m.share, dismissedAction: 'dismissedAction' },
}));
vi.mock('expo-file-system/legacy', () => ({ cacheDirectory: 'file:///cache/', downloadAsync: m.download }));
vi.mock('expo', () => ({ requireOptionalNativeModule: () => null }));
vi.mock('expo-media-library', () => {
  m.loaded.push('expo-media-library');
  throw new Error("Cannot find native module 'ExpoMediaLibrary'");
});
vi.mock('expo-image-manipulator', () => {
  m.loaded.push('expo-image-manipulator');
  throw new Error("Cannot find native module 'ExpoImageManipulator'");
});

import { canRotateFiles, canSaveToLibrary, rotateImageFile, savePhotos } from '../../mobile/src/services/photoActions.js';

describe('older app binary', () => {
  it('saves through the share sheet and skips rotation', async () => {
    expect(await canSaveToLibrary()).toBe(false);
    expect(await canRotateFiles()).toBe(false);
    expect(await rotateImageFile('file:///a.jpg', 90)).toBeNull();
    const result = await savePhotos([{ url: 'https://cdn.test/a.jpg', rotation: 90 }]);
    expect(m.share).toHaveBeenCalledWith({ url: expect.stringMatching(/a\.jpg$/) });
    expect(result).toEqual({ saved: 1, failed: 0, method: 'share' });
    expect(m.loaded).toEqual([]);
  });
});
