import React from 'react';
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const scrollTo = vi.hoisted(() => vi.fn());
const picker = vi.hoisted(() => ({
  launchImageLibraryAsync: vi.fn(),
  requestMediaLibraryPermissionsAsync: vi.fn(async () => ({ status: 'granted' })),
}));

vi.mock('react-native', async () => {
  const React = await import('react');
  const host = (name: string) => ({ children, ...props }: any) => React.createElement(name, props, children);
  return {
    Platform: { OS: 'ios', select: (v: any) => v.ios ?? v.default },
    StyleSheet: { create: (s: unknown) => s, absoluteFillObject: {} },
    Image: host('Image'),
    Modal: ({ visible, children }: any) => (visible ? React.createElement('Modal', null, children) : null),
    ScrollView: React.forwardRef(({ children, ...props }: any, ref: any) => {
      React.useImperativeHandle(ref, () => ({ scrollTo: scrollTo }));
      return React.createElement('ScrollView', props, children);
    }),
    Text: host('Text'),
    TouchableOpacity: host('TouchableOpacity'),
    View: host('View'),
  };
});
vi.mock('expo-image-picker', () => picker);
vi.mock('expo-file-system/legacy', () => ({ uploadAsync: vi.fn(), getInfoAsync: vi.fn(), FileSystemUploadType: { BINARY_CONTENT: 0 } }));
vi.mock('../../mobile/src/api/client.js', () => ({ api: {} }));
vi.mock('../../mobile/src/components/AppIcon', () => ({ AppIcon: () => null }));

import { PhotoGrid } from '../../mobile/src/components/PhotoGrid.js';
import { PhotoViewer } from '../../mobile/src/components/PhotoViewer.js';
import { MAX_IMAGES_PER_MESSAGE, pickImages } from '../../mobile/src/services/attachments.js';

const photos = (n: number) => Array.from({ length: n }, (_, i) => ({ url: `https://cdn.test/${i}.jpg`, mimeType: 'image/jpeg', width: 800, height: 600 }));

async function renderGrid(n: number, onOpen = vi.fn()) {
  let root!: ReturnType<typeof create>;
  await act(async () => { root = create(React.createElement(PhotoGrid, { photos: photos(n), onOpen, hasCaption: false })); });
  return root;
}

describe('multi-photo messages (OpenChat-wpmb)', () => {
  beforeEach(() => picker.launchImageLibraryAsync.mockReset());

  it('keeps a single photo as one full image', async () => {
    const root = await renderGrid(1);
    expect(root.root.findAll(n => n.type === 'Image')).toHaveLength(1);
  });

  it('tiles three photos and opens the viewer at the tapped one', async () => {
    const onOpen = vi.fn();
    const root = await renderGrid(3, onOpen);
    const tiles = root.root.findAll(n => n.type === 'TouchableOpacity');
    expect(tiles).toHaveLength(3);
    await act(async () => tiles[2].props.onPress());
    expect(onOpen).toHaveBeenCalledWith(2);
  });

  it('shows four tiles and a +N count past four photos', async () => {
    const root = await renderGrid(7);
    expect(root.root.findAll(n => n.type === 'Image')).toHaveLength(4);
    expect(JSON.stringify(root.toJSON())).toContain('"+","3"');
  });

  it('opens a multi-select picker capped at the remaining room and keeps selection order', async () => {
    picker.launchImageLibraryAsync.mockResolvedValue({
      canceled: false,
      assets: [
        { uri: 'file:///b.jpg', mimeType: 'image/jpg', width: 1, height: 2, fileName: 'b.jpg', fileSize: 10 },
        { uri: 'file:///a.png', mimeType: 'image/png', width: 3, height: 4, fileName: 'a.png', fileSize: 20 },
        { uri: 'file:///c.png', mimeType: 'image/png', width: 3, height: 4 },
      ],
    });
    const picked = await pickImages(2);
    expect(picker.launchImageLibraryAsync).toHaveBeenCalledWith(expect.objectContaining({
      allowsMultipleSelection: true, selectionLimit: 2, orderedSelection: true,
    }));
    expect(picked.map(p => p.fileName)).toEqual(['b.jpg', 'a.png']);
    expect(picked[0].mimeType).toBe('image/jpeg');
    expect(MAX_IMAGES_PER_MESSAGE).toBe(10);
  });

  it('returns nothing when the picker is cancelled or there is no room', async () => {
    picker.launchImageLibraryAsync.mockResolvedValue({ canceled: true, assets: null });
    expect(await pickImages()).toEqual([]);
    expect(await pickImages(0)).toEqual([]);
    expect(picker.launchImageLibraryAsync).toHaveBeenCalledTimes(1);
  });

  it('opens the viewer at the tapped photo and pages with Next / Previous', async () => {
    (globalThis as any).requestAnimationFrame ??= (cb: () => void) => { cb(); return 0; };
    (globalThis as any).cancelAnimationFrame ??= () => {};
    const urls = photos(3).map(p => p.url);
    let root!: ReturnType<typeof create>;
    await act(async () => { root = create(React.createElement(PhotoViewer, { state: { urls, index: 1 }, onClose: vi.fn() })); });
    const overlay = root.root.find(n => n.type === 'View' && typeof n.props.onLayout === 'function');
    await act(async () => overlay.props.onLayout({ nativeEvent: { layout: { width: 400, height: 800 } } }));
    const text = () => JSON.stringify(root.toJSON());
    expect(scrollTo).toHaveBeenLastCalledWith({ x: 400, animated: false });
    expect(text()).toContain('"2"," of ","3"');
    const press = async (label: string) => {
      const btn = root.root.find(n => n.type === 'TouchableOpacity' && n.props.accessibilityLabel === label);
      await act(async () => btn.props.onPress());
    };
    await press('Next photo');
    expect(text()).toContain('"3"," of ","3"');
    expect(root.root.findAll(n => n.props.accessibilityLabel === 'Next photo')).toHaveLength(0);
    await press('Previous photo');
    await press('Previous photo');
    expect(text()).toContain('"1"," of ","3"');
    expect(scrollTo).toHaveBeenLastCalledWith({ x: 0, animated: true });
  });
});
