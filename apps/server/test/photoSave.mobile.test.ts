import React from 'react';
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Save / Save all / rotate for chat photos (OpenChat-zwt4).
const m = vi.hoisted(() => ({
  download: vi.fn(async (url: string, dest: string) => ({ uri: dest, status: 200, url })),
  share: vi.fn(async () => ({ action: 'sharedAction' })),
  perm: vi.fn(async () => ({ granted: true })),
  save: vi.fn(async () => {}),
  rotate: vi.fn(async (uri: string, actions: any[]) => ({ uri: `${uri}#rot${actions[0].rotate}`, width: 3, height: 4 })),
  alert: vi.fn(),
}));

vi.mock('react-native', async () => {
  const React = await import('react');
  const host = (name: string) => ({ children, ...props }: any) => React.createElement(name, props, children);
  return {
    Platform: { OS: 'ios', select: (v: any) => v.ios ?? v.default },
    StyleSheet: { create: (s: unknown) => s, absoluteFillObject: {} },
    Share: { share: m.share, dismissedAction: 'dismissedAction' },
    Alert: { alert: m.alert },
    ActivityIndicator: host('ActivityIndicator'),
    Image: host('Image'),
    Modal: ({ visible, children }: any) => (visible ? React.createElement('Modal', null, children) : null),
    ScrollView: React.forwardRef(({ children, ...props }: any, ref: any) => {
      React.useImperativeHandle(ref, () => ({ scrollTo: () => {} }));
      return React.createElement('ScrollView', props, children);
    }),
    Text: host('Text'),
    TouchableOpacity: host('TouchableOpacity'),
    View: host('View'),
  };
});
vi.mock('expo-file-system/legacy', () => ({ cacheDirectory: 'file:///cache/', downloadAsync: m.download }));
vi.mock('expo-media-library', () => ({ requestPermissionsAsync: m.perm, saveToLibraryAsync: m.save }));
vi.mock('expo-image-manipulator', () => ({ manipulateAsync: m.rotate, SaveFormat: { JPEG: 'jpeg' } }));
vi.mock('../../mobile/src/components/AppIcon', () => ({ AppIcon: () => null }));

import { PhotoViewer } from '../../mobile/src/components/PhotoViewer.js';
import { PhotoSaveError, describeSaveResult, normalizeRotation, resetPhotoModulesForTests, savePhotos } from '../../mobile/src/services/photoActions.js';

const urls = ['https://cdn.test/a.jpg', 'https://cdn.test/b.jpg', 'https://cdn.test/c.jpg'];

beforeEach(() => {
  vi.clearAllMocks();
  resetPhotoModulesForTests();
  (globalThis as any).requestAnimationFrame ??= (cb: () => void) => { cb(); return 0; };
  (globalThis as any).cancelAnimationFrame ??= () => {};
});

describe('saving photos', () => {
  it('saves every photo straight to the library with add-only permission', async () => {
    const result = await savePhotos(urls.map(url => ({ url })));
    expect(m.perm).toHaveBeenCalledWith(true, ['photo']);
    expect(m.download).toHaveBeenCalledTimes(3);
    expect(m.save).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ saved: 3, failed: 0, method: 'library' });
    expect(describeSaveResult(result)).toBe('Saved 3 photos to Photos');
  });

  it('bakes the viewer rotation into the saved file', async () => {
    await savePhotos([{ url: urls[0], rotation: 90 }, { url: urls[1], rotation: 360 }]);
    expect(m.rotate).toHaveBeenCalledTimes(1);
    expect(m.rotate.mock.calls[0][1]).toEqual([{ rotate: 90 }]);
    expect(m.save.mock.calls.map(c => c[0])).toEqual(expect.arrayContaining([expect.stringMatching(/#rot90$/)]));
  });

  it('reports partial failures and explains a denied permission', async () => {
    m.save.mockRejectedValueOnce(new Error('disk full'));
    const result = await savePhotos(urls.map(url => ({ url })));
    expect(describeSaveResult(result)).toBe("Saved 2 photos to Photos · 1 couldn't be saved");
    m.perm.mockResolvedValueOnce({ granted: false });
    await expect(savePhotos([{ url: urls[0] }])).rejects.toBeInstanceOf(PhotoSaveError);
  });

  it('normalizes rotations to quarter turns', () => {
    expect([0, 90, 180, 270, 360, 450, -90].map(normalizeRotation)).toEqual([0, 90, 180, 270, 0, 90, 270]);
  });
});

describe('viewer toolbar', () => {
  async function open(state: any, props: any = {}) {
    let root!: ReturnType<typeof create>;
    await act(async () => { root = create(React.createElement(PhotoViewer, { state, onClose: vi.fn(), ...props })); });
    const overlay = root.root.find(n => n.type === 'View' && typeof n.props.onLayout === 'function');
    await act(async () => overlay.props.onLayout({ nativeEvent: { layout: { width: 400, height: 800 } } }));
    const press = async (label: string) => {
      const btn = root.root.find(n => n.type === 'TouchableOpacity' && n.props.accessibilityLabel === label);
      await act(async () => { btn.props.onPress(); await new Promise(r => setTimeout(r, 0)); });
    };
    const labels = () => root.root.findAll(n => n.type === 'TouchableOpacity').map(n => n.props.accessibilityLabel);
    return { root, press, labels };
  }

  it('offers Rotate, Save, Save all and Share for a sent multi-photo message, and saves all with rotation', async () => {
    const { root, press, labels } = await open({ urls, index: 1 });
    expect(labels()).toEqual(expect.arrayContaining(['Rotate photo', 'Save photo', 'Save all 3 photos', 'Share photo', 'Show photo 3 of 3', 'Close photo viewer']));
    await press('Rotate photo');
    const image = root.root.findAll(n => n.type === 'Image')[1];
    expect(image.props.style).toMatchObject({ width: 800, height: 400, transform: [{ rotate: '90deg' }] });
    await press('Save all 3 photos');
    expect(m.save).toHaveBeenCalledTimes(3);
    expect(m.rotate).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(root.toJSON())).toContain('Saved 3 photos to Photos');
  });

  it('shows Rotate and Remove for unsent composer photos and reports both', async () => {
    const onRotate = vi.fn();
    const onRemove = vi.fn();
    const { press, labels } = await open({ urls: ['file:///a.jpg'], index: 0, source: 'composer', rotations: [270] }, { onRotate, onRemove });
    expect(labels()).toEqual(expect.arrayContaining(['Rotate photo', 'Remove photo']));
    expect(labels()).not.toContain('Save photo');
    await press('Rotate photo');
    expect(onRotate).toHaveBeenCalledWith(0, 0);
    await press('Remove photo');
    expect(onRemove).toHaveBeenCalledWith(0);
  });

  it('follows the device into landscape', async () => {
    const { root } = await open({ urls, index: 0 });
    // The Modal mock drops props; check the real component passes them.
    expect(root.toJSON()).toBeTruthy();
    const src = (await import('node:fs')).readFileSync(new URL('../../mobile/src/components/PhotoViewer.tsx', import.meta.url), 'utf8');
    expect(src).toMatch(/supportedOrientations=\{\[\.\.\.ALL_ORIENTATIONS\]\}/);
  });
});
