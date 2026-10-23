/**
 * Save, save all, share and rotate chat photos from the viewer
 * (OpenChat-5wm2; save all and rotation OpenChat-zwt4).
 *
 * iOS/Android: Save writes straight to the photo library (add-only
 * permission) via expo-media-library; Share opens the system share sheet with
 * the file. Rotation is baked into saved and sent files with
 * expo-image-manipulator. Both modules are native: on an app binary built
 * before they were added, Save falls back to the share sheet (which offers
 * Save Image) and rotation is view-only. Web: downloads, or one share sheet on
 * touch devices, with rotation applied by the manipulator's canvas code.
 */
import { Platform, Share } from 'react-native';
import { cacheDirectory, downloadAsync } from 'expo-file-system/legacy';
import { hasNativeModule } from '../utils/optionalNativeModule';

export type PhotoActionResult = 'shared' | 'downloaded' | 'opened' | 'dismissed';

export interface PhotoToSave {
  url: string;
  /** Clockwise degrees the user rotated it in the viewer. */
  rotation?: number;
}

export interface SaveResult {
  saved: number;
  failed: number;
  /** Where the photos went, for the confirmation text. */
  method: 'library' | 'share' | 'download' | 'opened';
}

export class PhotoSaveError extends Error {}

/** Label for the save button on this platform. */
export const photoActionLabel = Platform.OS === 'web' ? 'Download' : 'Save';

// ── Optional native modules (absent on binaries built before this change) ──

type MediaLibraryModule = typeof import('expo-media-library');
type ManipulatorModule = typeof import('expo-image-manipulator');

// Loaded on first use, not at startup, so an older binary without these
// native modules still runs this JS. hasNativeModule must pass before the
// import: a missing module throws fatally while loading, not as a rejection.
let mediaLibrary: Promise<MediaLibraryModule | null> | undefined;
function loadMediaLibrary(): Promise<MediaLibraryModule | null> {
  if (Platform.OS === 'web') return Promise.resolve(null);
  if (!hasNativeModule('ExpoMediaLibrary')) return Promise.resolve(null);
  mediaLibrary ??= import('expo-media-library').then(
    mod => (typeof mod.saveToLibraryAsync === 'function' ? mod : null),
    () => null,
  );
  return mediaLibrary;
}

let manipulator: Promise<ManipulatorModule | null> | undefined;
function loadManipulator(): Promise<ManipulatorModule | null> {
  if (Platform.OS !== 'web' && !hasNativeModule('ExpoImageManipulator')) return Promise.resolve(null);
  manipulator ??= import('expo-image-manipulator').then(
    mod => (typeof mod.manipulateAsync === 'function' ? mod : null),
    () => null,
  );
  return manipulator;
}

/** Can this app build save straight to the photo library? */
export async function canSaveToLibrary(): Promise<boolean> {
  return (await loadMediaLibrary()) !== null;
}

/** Can this app build bake a rotation into an image file? */
export async function canRotateFiles(): Promise<boolean> {
  return (await loadManipulator()) !== null;
}

/** Test hook: forget which optional modules loaded. */
export function resetPhotoModulesForTests(): void {
  mediaLibrary = undefined;
  manipulator = undefined;
}

export function normalizeRotation(degrees: number | undefined): 0 | 90 | 180 | 270 {
  const d = (((Math.round((degrees ?? 0) / 90) * 90) % 360) + 360) % 360;
  return d as 0 | 90 | 180 | 270;
}

/**
 * Rotate an image file (local file, blob: or data: URL; on web also a CORS-
 * readable https URL). Returns null when there is nothing to do or this build
 * can't rotate files.
 */
export async function rotateImageFile(
  uri: string,
  degrees: number,
): Promise<{ uri: string; width: number; height: number } | null> {
  const turn = normalizeRotation(degrees);
  if (turn === 0) return null;
  const mod = await loadManipulator();
  if (!mod) return null;
  const result = await mod.manipulateAsync(uri, [{ rotate: turn }], {
    compress: 0.9,
    format: mod.SaveFormat.JPEG,
  });
  let out = result.uri;
  // Web returns a data: URL; keep a compact blob: URL instead so a queued
  // message doesn't push megabytes of base64 into browser storage.
  if (Platform.OS === 'web' && out.startsWith('data:') && typeof URL.createObjectURL === 'function') {
    out = URL.createObjectURL(await (await fetch(out)).blob());
  }
  return { uri: out, width: result.width, height: result.height };
}

function fileNameFromUrl(url: string): string {
  const last = url.split('?')[0].split('/').pop() || '';
  return /\.(jpe?g|png|gif|webp)$/i.test(last) ? last : `photo_${Date.now()}.jpg`;
}

async function inBatches<T>(items: T[], size: number, run: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      await run(items[i], i);
    }
  }));
}

// ── Native ────────────────────────────────────────────────────────────────

async function downloadToCache(url: string, index: number): Promise<string> {
  if (!/^https?:/.test(url)) return url;
  const target = `${cacheDirectory}save_${Date.now()}_${index}_${fileNameFromUrl(url)}`;
  const { uri, status } = await downloadAsync(url, target);
  if (status < 200 || status >= 300) throw new Error(`Download failed (${status})`);
  return uri;
}

async function saveNative(photos: PhotoToSave[]): Promise<SaveResult> {
  const ml = await loadMediaLibrary();
  if (!ml) {
    // Older binary: the share sheet's "Save Image" is the way to the library.
    const outcome = await sharePhoto(photos[0].url, photos[0].rotation);
    return { saved: outcome === 'shared' ? 1 : 0, failed: 0, method: 'share' };
  }
  const permission = await ml.requestPermissionsAsync(true, ['photo']);
  if (!permission.granted) {
    throw new PhotoSaveError('Allow OpenChat to add photos in Settings › OpenChat › Photos, then try again.');
  }
  let saved = 0;
  let failed = 0;
  await inBatches(photos, 3, async (photo, i) => {
    try {
      let uri = await downloadToCache(photo.url, i);
      const rotated = photo.rotation ? await rotateImageFile(uri, photo.rotation) : null;
      if (rotated) uri = rotated.uri;
      await ml.saveToLibraryAsync(uri);
      saved++;
    } catch (err) {
      console.warn('[photoActions] save failed:', err);
      failed++;
    }
  });
  return { saved, failed, method: 'library' };
}

// ── Web ───────────────────────────────────────────────────────────────────

async function fetchBlob(url: string, rotation?: number): Promise<{ blob: Blob; rotated: boolean }> {
  let source = url;
  let rotated = false;
  if (rotation && normalizeRotation(rotation) !== 0) {
    const out = await rotateImageFile(url, rotation).catch(() => null);
    if (out) { source = out.uri; rotated = true; }
  }
  const res = await fetch(source, { mode: 'cors' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return { blob: await res.blob(), rotated };
}

function triggerDownload(blob: Blob, fileName: string): void {
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);
}

async function saveWeb(photos: PhotoToSave[]): Promise<SaveResult> {
  const files: File[] = [];
  let failed = 0;
  for (const photo of photos) {
    try {
      const { blob, rotated } = await fetchBlob(photo.url, photo.rotation);
      const base = fileNameFromUrl(photo.url);
      const name = rotated ? base.replace(/\.\w+$/, '-rotated.jpg') : base;
      files.push(new File([blob], name, { type: blob.type || 'image/jpeg' }));
    } catch {
      failed++;
    }
  }
  if (!files.length) {
    // The bucket refused a cross-origin read; let the browser open it instead.
    window.open(photos[0].url, '_blank', 'noopener');
    return { saved: 0, failed: Math.max(photos.length - 1, 0), method: 'opened' };
  }
  // Touch devices: one share sheet with every file ("Save N Images").
  const nav = navigator as Navigator & { canShare?: (data: ShareData) => boolean };
  const coarse = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
  if (coarse && nav.share && nav.canShare?.({ files })) {
    try {
      await nav.share({ files });
      return { saved: files.length, failed, method: 'share' };
    } catch {
      return { saved: 0, failed, method: 'share' };
    }
  }
  // Desktop: one download each, spaced so the browser keeps them all (it may
  // ask once to allow multiple downloads).
  for (let i = 0; i < files.length; i++) {
    triggerDownload(files[i], files[i].name);
    if (i < files.length - 1) await new Promise(r => setTimeout(r, 350));
  }
  return { saved: files.length, failed, method: 'download' };
}

// ── Public API ────────────────────────────────────────────────────────────

/** Save one or more photos: photo library on phones, downloads on web. */
export async function savePhotos(photos: PhotoToSave[]): Promise<SaveResult> {
  const remote = photos.filter(p => !!p.url);
  if (!remote.length) return { saved: 0, failed: 0, method: 'library' };
  return Platform.OS === 'web' ? saveWeb(remote) : saveNative(remote);
}

/** Open the system share sheet with one photo (AirDrop, Messages, …). */
export async function sharePhoto(url: string, rotation?: number): Promise<PhotoActionResult> {
  if (Platform.OS === 'web') {
    const result = await saveWeb([{ url, rotation }]);
    if (result.method === 'opened') return 'opened';
    if (!result.saved) return 'dismissed';
    return result.method === 'download' ? 'downloaded' : 'shared';
  }
  if (Platform.OS === 'ios' && cacheDirectory) {
    let { uri } = await downloadAsync(url, `${cacheDirectory}${Date.now()}_${fileNameFromUrl(url)}`);
    const rotated = rotation ? await rotateImageFile(uri, rotation).catch(() => null) : null;
    if (rotated) uri = rotated.uri;
    const result = await Share.share({ url: uri });
    return result.action === Share.dismissedAction ? 'dismissed' : 'shared';
  }
  const result = await Share.share({ message: url });
  return result.action === Share.dismissedAction ? 'dismissed' : 'shared';
}

/** Single-photo save/share used by #182 callers. */
export async function saveOrSharePhoto(url: string): Promise<PhotoActionResult> {
  return sharePhoto(url);
}

/** Short confirmation, e.g. "Saved 7 photos to Photos". Empty when the share
 * sheet already gave the user its own feedback. */
export function describeSaveResult(result: SaveResult): string {
  const n = result.saved;
  const noun = n === 1 ? 'photo' : 'photos';
  const tail = result.failed ? ` · ${result.failed} couldn't be saved` : '';
  switch (result.method) {
    case 'library': return n ? `Saved ${n} ${noun} to Photos${tail}` : `Couldn't save the ${result.failed === 1 ? 'photo' : 'photos'}`;
    case 'download': return `Downloaded ${n} ${noun}${tail}`;
    case 'share': return '';
    case 'opened': return 'Opened in a new tab — save it from there';
  }
}
