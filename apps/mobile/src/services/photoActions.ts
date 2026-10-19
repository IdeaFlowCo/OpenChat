/**
 * Save or share a chat photo from the fullscreen viewer (OpenChat-5wm2).
 *
 * iOS: download to the cache and open the share sheet with the file, which
 * offers Save Image, AirDrop, Messages and the rest. Android's Share API takes
 * text only, so it shares the link. Web: share the file where the browser can
 * (phones), otherwise download it; if the bucket refuses a cross-origin fetch,
 * open the photo in a new tab so it can still be saved.
 */
import { Platform, Share } from 'react-native';
import { cacheDirectory, downloadAsync } from 'expo-file-system/legacy';

export type PhotoActionResult = 'shared' | 'downloaded' | 'opened' | 'dismissed';

/** Label for the viewer button on this platform. */
export const photoActionLabel = Platform.OS === 'web' ? 'Download' : 'Share';

function fileNameFromUrl(url: string): string {
  const last = url.split('?')[0].split('/').pop() || '';
  return /\.(jpe?g|png|gif|webp)$/i.test(last) ? last : `photo_${Date.now()}.jpg`;
}

export async function saveOrSharePhoto(url: string): Promise<PhotoActionResult> {
  const fileName = fileNameFromUrl(url);

  if (Platform.OS === 'web') {
    let blob: Blob;
    try {
      const res = await fetch(url, { mode: 'cors' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      blob = await res.blob();
    } catch {
      window.open(url, '_blank', 'noopener');
      return 'opened';
    }
    const file = new File([blob], fileName, { type: blob.type || 'image/jpeg' });
    const nav = navigator as Navigator & { canShare?: (data: ShareData) => boolean };
    // Touch devices: the share sheet has "Save Image". Desktop: a download.
    const coarse = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
    if (coarse && nav.share && nav.canShare?.({ files: [file] })) {
      try {
        await nav.share({ files: [file] });
        return 'shared';
      } catch {
        return 'dismissed';
      }
    }
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);
    return 'downloaded';
  }

  if (Platform.OS === 'ios' && cacheDirectory) {
    const { uri } = await downloadAsync(url, `${cacheDirectory}${Date.now()}_${fileName}`);
    const result = await Share.share({ url: uri });
    return result.action === Share.dismissedAction ? 'dismissed' : 'shared';
  }

  const result = await Share.share({ message: url });
  return result.action === Share.dismissedAction ? 'dismissed' : 'shared';
}
