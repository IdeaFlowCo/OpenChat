/**
 * attachments.ts — image pick + upload helpers (OpenChat-6bg).
 *
 * Flow:
 *   1. pickImage() → shows system photo picker, returns a local asset descriptor.
 *   2. uploadImage(asset) → calls /api/chat/attachments/presign for a presigned
 *      PUT URL, uploads the binary via fetch PUT, returns the public GET URL +
 *      metadata suitable for storing on a Message.
 *
 * Works on iOS native, Android native, and Expo web (file input falls through
 * expo-image-picker's web implementation).
 */

import * as ImagePicker from 'expo-image-picker';
import { uploadAsync, FileSystemUploadType } from 'expo-file-system/legacy';
import { Platform } from 'react-native';
import { api, Attachment } from '../api/client';

// ── Audio MIME helpers ────────────────────────────────────────────────────────

/** Infer a sensible MIME type from a local audio URI. */
function mimeTypeFromUri(uri: string): string {
  const lower = uri.toLowerCase();
  if (lower.endsWith('.m4a') || lower.endsWith('.aac')) return 'audio/m4a';
  if (lower.endsWith('.mp3')) return 'audio/mpeg';
  if (lower.endsWith('.wav')) return 'audio/wav';
  if (lower.endsWith('.webm')) return 'audio/webm';
  // Default to m4a — that's what our recorder produces on iOS/Android.
  return 'audio/m4a';
}

export interface PickedAsset {
  uri: string;
  mimeType: string;
  width: number;
  height: number;
  fileName: string;
  fileSize: number;
}

const ALLOWED_IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/gif',
  'image/webp',
]);
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** Convert an image pasted in a web composer into the normal picker shape. */
export async function pickedAssetFromWebFile(file: File): Promise<PickedAsset> {
  if (Platform.OS !== 'web') throw new Error('Clipboard images are only available on web');
  if (!ALLOWED_IMAGE_MIME_TYPES.has(file.type)) {
    throw new Error('Paste a JPEG, PNG, GIF, or WEBP image');
  }
  if (file.size > MAX_IMAGE_BYTES) {
    throw new Error('Image must be smaller than 20 MB');
  }

  const uri = URL.createObjectURL(file);
  let width = 0;
  let height = 0;
  try {
    const bitmap = await createImageBitmap(file);
    width = bitmap.width;
    height = bitmap.height;
    bitmap.close();
  } catch {
    // Dimensions are optional metadata; the upload itself can still proceed.
  }

  return {
    uri,
    mimeType: file.type === 'image/jpg' ? 'image/jpeg' : file.type,
    width,
    height,
    fileName: file.name || `pasted-image-${Date.now()}.png`,
    fileSize: file.size,
  };
}

/** Release temporary browser object URLs without affecting native file URIs. */
export function releasePickedAsset(asset: PickedAsset | null): void {
  if (Platform.OS === 'web' && asset?.uri.startsWith('blob:')) {
    URL.revokeObjectURL(asset.uri);
  }
}

/**
 * Open the system image picker. Returns null if the user cancels or permission
 * is denied. Requests permission automatically on first call.
 */
export async function pickImage(): Promise<PickedAsset | null> {
  // On iOS / Android, request permission if not already granted.
  if (Platform.OS !== 'web') {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      return null;
    }
  }

  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsEditing: false,
    quality: 0.85,
    exif: false,
  });

  if (result.canceled || result.assets.length === 0) return null;

  const asset = result.assets[0];
  const uri = asset.uri;

  // Determine MIME type
  let mimeType = asset.mimeType || 'image/jpeg';
  // Normalise — expo sometimes returns 'image/jpg'
  if (mimeType === 'image/jpg') mimeType = 'image/jpeg';

  // Infer filename from URI if expo didn't provide one
  const fileName = asset.fileName || uri.split('/').pop() || `photo_${Date.now()}.jpg`;

  // Use the file size from expo (available on web and recent iOS/Android).
  const fileSize = asset.fileSize ?? 0;

  return {
    uri,
    mimeType,
    width: asset.width ?? 0,
    height: asset.height ?? 0,
    fileName,
    fileSize,
  };
}

/**
 * Upload a picked asset to GCS via a presigned PUT URL.
 * Returns an Attachment descriptor ready to embed in a message.
 */
export async function uploadImage(asset: PickedAsset): Promise<Attachment> {
  // 1. Get presigned PUT URL from the server
  const { putUrl, getUrl } = await api.presignAttachment({
    filename: asset.fileName,
    mimeType: asset.mimeType,
    sizeBytes: asset.fileSize || 1, // fallback: server cap will still protect
  });

  // 2. Upload to the presigned URL
  if (Platform.OS === 'web') {
    // On web expo-image-picker returns a blob URL or data URL.
    // Fetch it as a blob and PUT.
    const res = await fetch(asset.uri);
    const blob = await res.blob();
    const putRes = await fetch(putUrl, {
      method: 'PUT',
      headers: { 'Content-Type': asset.mimeType },
      body: blob,
    });
    if (!putRes.ok) {
      throw new Error(`Upload failed: ${putRes.status}`);
    }
  } else {
    // On native, use expo-file-system/legacy uploadAsync to upload binary content.
    const uploadResult = await uploadAsync(putUrl, asset.uri, {
      httpMethod: 'PUT',
      uploadType: FileSystemUploadType.BINARY_CONTENT,
      headers: { 'Content-Type': asset.mimeType },
    });
    if (uploadResult.status < 200 || uploadResult.status >= 300) {
      throw new Error(`Upload failed: ${uploadResult.status}`);
    }
  }

  // 3. Return the public URL + metadata
  return {
    url: getUrl,
    mimeType: asset.mimeType,
    width: asset.width || undefined,
    height: asset.height || undefined,
  };
}

/**
 * Upload a recorded audio file to GCS via a presigned PUT URL.
 * Returns an Attachment descriptor with type:'audio' ready to embed in a message.
 *
 * Max size enforced server-side is 10 MB; we check here too for a fast failure.
 */
export async function uploadAudio(
  localUri: string,
  durationMs: number
): Promise<Attachment> {
  const mimeType = mimeTypeFromUri(localUri);
  const filename = `voice_${Date.now()}.m4a`;

  // Fetch the file size. expo-file-system is available on native; on web we
  // don't expose the mic button so this path is native-only.
  let sizeBytes = 1;
  if (Platform.OS !== 'web') {
    try {
      const { getInfoAsync } = await import('expo-file-system/legacy');
      const info = await getInfoAsync(localUri);
      if (info.exists && 'size' in info && typeof info.size === 'number') {
        sizeBytes = info.size;
      }
    } catch {
      // Fall through — server cap still protects us.
    }
  }

  const MAX_AUDIO_BYTES = 10 * 1024 * 1024; // 10 MB
  if (sizeBytes > MAX_AUDIO_BYTES) {
    throw new Error('Voice message is too large (max 10 MB)');
  }

  // 1. Get presigned PUT URL.
  const { putUrl, getUrl } = await api.presignAttachment({
    filename,
    mimeType,
    sizeBytes,
  });

  // 2. Upload binary content.
  const uploadResult = await uploadAsync(putUrl, localUri, {
    httpMethod: 'PUT',
    uploadType: FileSystemUploadType.BINARY_CONTENT,
    headers: { 'Content-Type': mimeType },
  });
  if (uploadResult.status < 200 || uploadResult.status >= 300) {
    throw new Error(`Audio upload failed: ${uploadResult.status}`);
  }

  return {
    type: 'audio',
    url: getUrl,
    mimeType,
    durationMs,
  };
}
