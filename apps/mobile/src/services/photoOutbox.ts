/**
 * Photos waiting in the offline outbox (OpenChat-ciom follow-up).
 *
 * A photo message is queued the moment Send is tapped, before anything is
 * uploaded, so weak or absent signal never loses it. On iOS/Android the
 * picked files are copied into the app's documents directory, which the OS
 * does not purge, and removed once the message is sent or discarded. On the
 * web the queue holds the page's blob/data URLs: queued photos survive going
 * offline but not a page reload.
 */
import { Platform } from 'react-native';
import { copyAsync, deleteAsync, documentDirectory, makeDirectoryAsync } from 'expo-file-system/legacy';
import type { Attachment } from '../api/client';
import type { PickedAsset } from './attachments';

export type QueuedPhoto = { local: PickedAsset; attachment?: Attachment };

function outboxDir(clientId: string): string | null {
  return documentDirectory ? `${documentDirectory}openchat-outbox/${clientId}/` : null;
}

/** Copy picked photos somewhere durable for the life of the queued message. */
export async function keepPhotosForOutbox(clientId: string, assets: PickedAsset[]): Promise<QueuedPhoto[]> {
  const dir = Platform.OS === 'web' ? null : outboxDir(clientId);
  if (!dir) return assets.map(local => ({ local }));
  await makeDirectoryAsync(dir, { intermediates: true });
  return Promise.all(assets.map(async (asset, i) => {
    const safeName = asset.fileName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-80) || 'photo.jpg';
    const to = `${dir}${i}-${safeName}`;
    await copyAsync({ from: asset.uri, to });
    return { local: { ...asset, uri: to } };
  }));
}

/** Free a queued message's local photo copies. Best effort; never throws. */
export async function releaseOutboxPhotos(clientId: string, photos: QueuedPhoto[] | undefined): Promise<void> {
  if (!photos?.length) return;
  if (Platform.OS === 'web') {
    for (const { local } of photos) {
      if (local.uri.startsWith('blob:') && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(local.uri);
    }
    return;
  }
  const dir = outboxDir(clientId);
  if (dir) await deleteAsync(dir, { idempotent: true }).catch(() => {});
}

/**
 * iOS moves the app container on every app update, so a saved absolute path
 * can go stale; re-root outbox paths under the current documents directory.
 */
export function resolveOutboxUri(uri: string): string {
  const marker = '/openchat-outbox/';
  const at = uri.indexOf(marker);
  if (at < 0 || !documentDirectory) return uri;
  return `${documentDirectory}openchat-outbox/${uri.slice(at + marker.length)}`;
}

/** What the bubble shows: uploaded photos by URL, the rest from the device. */
export function displayAttachments(photos: QueuedPhoto[]): Attachment[] {
  return photos.map(({ local, attachment }) => attachment ?? {
    url: resolveOutboxUri(local.uri),
    mimeType: local.mimeType,
    width: local.width || undefined,
    height: local.height || undefined,
  });
}
