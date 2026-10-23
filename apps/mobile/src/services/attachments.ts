/**
 * attachments.ts — image pick + upload helpers (OpenChat-6bg).
 *
 * Flow:
 *   1. pickImages() → shows system photo picker (multi-select), returns local
 *      asset descriptors.
 *   2. uploadImage(asset) → calls /api/chat/attachments/presign for a presigned
 *      PUT URL, uploads the binary via fetch PUT, returns the public GET URL +
 *      metadata suitable for storing on a Message.
 *
 * Works on iOS native, Android native, and Expo web (file input falls through
 * expo-image-picker's web implementation).
 */

import * as ImagePicker from 'expo-image-picker';
import { uploadAsync, getInfoAsync, FileSystemUploadType } from 'expo-file-system/legacy';
import { Platform } from 'react-native';
import { api, ApiError, Attachment } from '../api/client';

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
  /** Clockwise degrees to rotate before sending (OpenChat-zwt4). */
  rotation?: number;
}

/** Most photos one message can carry; the server enforces the same cap. */
export const MAX_IMAGES_PER_MESSAGE = 10;

function toPickedAsset(asset: ImagePicker.ImagePickerAsset): PickedAsset {
  const uri = asset.uri;

  // Determine MIME type
  let mimeType = asset.mimeType || 'image/jpeg';
  // Normalise — expo sometimes returns 'image/jpg'
  if (mimeType === 'image/jpg') mimeType = 'image/jpeg';

  // Infer filename from URI if expo didn't provide one
  const fileName = asset.fileName || uri.split('/').pop() || `photo_${Date.now()}.jpg`;

  return {
    uri,
    mimeType,
    width: asset.width ?? 0,
    height: asset.height ?? 0,
    fileName,
    // Use the file size from expo (available on web and recent iOS/Android).
    fileSize: asset.fileSize ?? 0,
  };
}

/**
 * Open the system image picker with multi-select (OpenChat-wpmb). Returns the
 * picked photos in selection order, or [] if the user cancels or permission is
 * denied. Requests permission automatically on first call.
 */
export async function pickImages(limit = MAX_IMAGES_PER_MESSAGE): Promise<PickedAsset[]> {
  if (limit <= 0) return [];
  // On iOS / Android, request permission if not already granted.
  if (Platform.OS !== 'web') {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      return [];
    }
  }

  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsEditing: false,
    allowsMultipleSelection: limit > 1,
    selectionLimit: limit,
    orderedSelection: true,
    // iOS: hand back JPEG rather than HEIC; the server and browsers only take
    // JPEG/PNG/GIF/WebP (OpenChat-wpmb upload failures).
    preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
    quality: 0.85,
    exif: false,
  });

  if (result.canceled) return [];
  // Some platforms ignore selectionLimit (web file inputs), so trim here too.
  return result.assets.slice(0, limit).map(toPickedAsset);
}

/**
 * Take a photo with the camera from the chat composer (OpenChat-p4xo).
 * Returns null if the user cancels or denies camera access.
 */
export async function takePhoto(): Promise<PickedAsset | null> {
  if (Platform.OS !== 'web') {
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== 'granted') return null;
  }
  const result = await ImagePicker.launchCameraAsync({
    mediaTypes: ['images'],
    allowsEditing: false,
    quality: 0.85,
    exif: false,
  });
  if (result.canceled || result.assets.length === 0) return null;
  return toPickedAsset(result.assets[0]);
}

const PASTEABLE_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

/**
 * Turn image files from a web paste or drop into pending photos
 * (OpenChat-63zy). Non-image and unsupported files are skipped. Dimensions are
 * read so a single photo keeps its aspect ratio in the bubble.
 */
export async function filesToAssets(files: Iterable<File>, limit = MAX_IMAGES_PER_MESSAGE): Promise<PickedAsset[]> {
  const images = Array.from(files).filter(f => PASTEABLE_IMAGE_TYPES.has(f.type)).slice(0, Math.max(limit, 0));
  return Promise.all(images.map(async (file, i) => {
    const uri = URL.createObjectURL(file);
    const { width, height } = await imageSize(uri);
    const ext = file.type.split('/')[1] === 'jpeg' ? 'jpg' : file.type.split('/')[1];
    return {
      uri,
      mimeType: file.type,
      width,
      height,
      // Clipboard images are all called "image.png"; keep names distinct.
      fileName: file.name && file.name !== 'image.png' ? file.name : `pasted_${Date.now()}_${i}.${ext}`,
      fileSize: file.size,
    };
  }));
}

function imageSize(uri: string): Promise<{ width: number; height: number }> {
  return new Promise(resolve => {
    if (typeof window === 'undefined' || typeof window.Image !== 'function') {
      resolve({ width: 0, height: 0 });
      return;
    }
    const img = new window.Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve({ width: 0, height: 0 });
    img.src = uri;
  });
}

/** Why one photo failed to upload, in words a person can act on. */
export class PhotoUploadError extends Error {
  constructor(
    readonly fileName: string,
    readonly stage: 'file' | 'size' | 'presign' | 'upload',
    readonly reason: string,
    readonly status?: number,
  ) {
    super(`${fileName}: ${reason}`);
    this.name = 'PhotoUploadError';
  }
}

/** Server and storage limits, mirrored for a fast, specific error. */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const UPLOADABLE_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

function describeStatus(status: number): string {
  if (status === 0) return 'the connection dropped';
  if (status === 403) return 'storage refused the upload (signature or size mismatch)';
  if (status === 413) return 'the photo is too large';
  if (status >= 500) return `the server had a problem (${status})`;
  return `upload failed (${status})`;
}

/**
 * Upload a picked asset to GCS via a presigned PUT URL.
 * Returns an Attachment descriptor ready to embed in a message.
 * Throws PhotoUploadError naming the photo and what went wrong.
 */
export async function uploadImage(asset: PickedAsset): Promise<Attachment> {
  const name = asset.fileName;
  if (!UPLOADABLE_IMAGE_TYPES.has(asset.mimeType)) {
    const kind = asset.mimeType.split('/')[1]?.toUpperCase() || 'this';
    throw new PhotoUploadError(name, 'presign', `${kind} photos aren't supported yet (use JPEG or PNG)`);
  }

  // The presigned URL signs the exact Content-Length, so measure the file we
  // will actually send. The picker's fileSize can describe the original asset
  // rather than the compressed copy.
  let sizeBytes = 0;
  let webBlob: Blob | undefined;
  const missing = () => new PhotoUploadError(name, 'file', 'the photo is no longer on this device');
  if (Platform.OS === 'web') {
    // A blob: URL from paste/drop does not survive a page reload.
    try {
      const res = await fetch(asset.uri);
      webBlob = await res.blob();
    } catch {
      throw missing();
    }
    sizeBytes = webBlob.size;
  } else {
    let fileInfo: Awaited<ReturnType<typeof getInfoAsync>> | undefined;
    try {
      fileInfo = await getInfoAsync(asset.uri);
    } catch {
      // Fall through to the picker's size below.
    }
    if (fileInfo && !fileInfo.exists) throw missing();
    if (fileInfo?.exists && 'size' in fileInfo && typeof fileInfo.size === 'number') sizeBytes = fileInfo.size;
  }
  if (!sizeBytes) sizeBytes = asset.fileSize;
  if (!sizeBytes) throw new PhotoUploadError(name, 'size', "couldn't read the photo file");
  if (sizeBytes > MAX_IMAGE_BYTES) {
    throw new PhotoUploadError(name, 'size', `it's ${(sizeBytes / 1024 / 1024).toFixed(1)} MB; the limit is 20 MB`);
  }

  // 1. Get presigned PUT URL from the server
  let putUrl: string;
  let getUrl: string;
  try {
    ({ putUrl, getUrl } = await api.presignAttachment({
      filename: name,
      mimeType: asset.mimeType,
      sizeBytes,
    }));
  } catch (err) {
    const status = err instanceof ApiError ? err.status : undefined;
    const detail = err instanceof Error ? err.message.replace(/^\d{3}:\s*/, '') : String(err);
    throw new PhotoUploadError(name, 'presign', `the server wouldn't accept it (${detail})`, status);
  }

  // 2. Upload to the presigned URL
  let status: number;
  try {
    if (Platform.OS === 'web' && webBlob) {
      const putRes = await fetch(putUrl, {
        method: 'PUT',
        headers: { 'Content-Type': asset.mimeType },
        body: webBlob,
      });
      status = putRes.status;
    } else {
      // On native, use expo-file-system/legacy uploadAsync to upload binary content.
      const uploadResult = await uploadAsync(putUrl, asset.uri, {
        httpMethod: 'PUT',
        uploadType: FileSystemUploadType.BINARY_CONTENT,
        headers: { 'Content-Type': asset.mimeType },
      });
      status = uploadResult.status;
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new PhotoUploadError(name, 'upload', `the connection dropped (${detail})`, 0);
  }
  if (status < 200 || status >= 300) {
    throw new PhotoUploadError(name, 'upload', describeStatus(status), status);
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
 * Errors a retry won't fix: wrong type, too big, file gone, or the server
 * saying no (4xx other than timeout/rate limit). Weak-signal failures —
 * dropped connections, timeouts, 5xx — are worth retrying later.
 */
export function isPermanentUploadError(error: PhotoUploadError): boolean {
  if (error.stage === 'file' || error.stage === 'size') return true;
  if (error.reason.includes("aren't supported")) return true;
  const status = error.status;
  if (!status) return false;
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

/**
 * Check photos before queueing them so problems a retry can't fix are
 * reported while the user is still looking at the composer.
 */
export async function checkPhotosForSend(assets: PickedAsset[]): Promise<{
  ok: PickedAsset[];
  rejected: { asset: PickedAsset; reason: string }[];
}> {
  const ok: PickedAsset[] = [];
  const rejected: { asset: PickedAsset; reason: string }[] = [];
  for (const asset of assets) {
    if (!UPLOADABLE_IMAGE_TYPES.has(asset.mimeType)) {
      const kind = asset.mimeType.split('/')[1]?.toUpperCase() || 'this';
      rejected.push({ asset, reason: `${kind} photos aren't supported yet (use JPEG or PNG)` });
      continue;
    }
    let size = asset.fileSize;
    if (Platform.OS !== 'web') {
      try {
        const info = await getInfoAsync(asset.uri);
        if (info.exists && 'size' in info && typeof info.size === 'number') size = info.size;
      } catch { /* keep the picker's size */ }
    }
    if (size > MAX_IMAGE_BYTES) {
      rejected.push({ asset, reason: `it's ${(size / 1024 / 1024).toFixed(1)} MB; the limit is 20 MB` });
      continue;
    }
    ok.push(asset);
  }
  return { ok, rejected };
}

export interface PhotoUploadResults {
  /** Uploaded photos, in picked order, for the ones that succeeded. */
  uploaded: { asset: PickedAsset; attachment: Attachment }[];
  failed: { asset: PickedAsset; error: PhotoUploadError }[];
}

/**
 * Upload several photos a few at a time (a phone on cellular stalls with ten
 * 4 MB PUTs at once), retrying each failure once. Never throws; the caller
 * decides what to do with partial success.
 */
export async function uploadImages(
  assets: PickedAsset[],
  {
    concurrency = 3,
    retries = 1,
    upload = uploadImage,
    onUploaded,
  }: {
    concurrency?: number;
    retries?: number;
    upload?: typeof uploadImage;
    /** Called as each photo lands, so a queue can persist progress. */
    onUploaded?: (index: number, attachment: Attachment) => void | Promise<void>;
  } = {},
): Promise<PhotoUploadResults> {
  const outcomes: ({ attachment: Attachment } | { error: PhotoUploadError })[] = new Array(assets.length);
  let next = 0;
  const worker = async () => {
    while (next < assets.length) {
      const i = next++;
      for (let attempt = 0; ; attempt++) {
        try {
          const attachment = await upload(assets[i]);
          outcomes[i] = { attachment };
          await onUploaded?.(i, attachment);
          break;
        } catch (err) {
          const error = err instanceof PhotoUploadError
            ? err
            : new PhotoUploadError(assets[i].fileName, 'upload', err instanceof Error ? err.message : String(err));
          if (attempt >= retries || isPermanentUploadError(error)) {
            outcomes[i] = { error };
            break;
          }
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, assets.length) }, worker));
  const results: PhotoUploadResults = { uploaded: [], failed: [] };
  outcomes.forEach((o, i) => {
    if ('attachment' in o) results.uploaded.push({ asset: assets[i], attachment: o.attachment });
    else results.failed.push({ asset: assets[i], error: o.error });
  });
  return results;
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

/** Free the memory behind a pasted/dropped photo once it is sent or removed. */
export function releaseAsset(asset: PickedAsset): void {
  if (asset.uri.startsWith('blob:') && typeof URL.revokeObjectURL === 'function') {
    URL.revokeObjectURL(asset.uri);
  }
}

// ── General file attachments (OpenChat-85q.1) ──────────────────────────────
//
// Web-only for now: there is no document-picker native module installed
// (expo-document-picker), so picking an arbitrary file on iOS/Android is a
// follow-up — see the mobile note in the OpenChat-85q.1 ticket. On web,
// react-native-web still runs in a DOM, so we reach for the browser's native
// file input directly rather than adding a native dependency for a web-only
// affordance.

/** Must match apps/server/src/routes/chat.ts DOCUMENT_MIME_TYPES exactly. */
export const DOCUMENT_MIME_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/csv',
  'text/plain',
  'application/rtf',
  'application/zip',
  'application/x-zip-compressed',
]);

/** Must match apps/server/src/routes/chat.ts MAX_DOCUMENT_SIZE_BYTES. */
export const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024; // 50 MB

/**
 * Open the browser's native file picker restricted to DOCUMENT_MIME_TYPES
 * (web only). Resolves to null if the user cancels or this isn't web.
 */
export function pickDocumentWeb(): Promise<File | null> {
  return new Promise((resolve) => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') {
      resolve(null);
      return;
    }
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = Array.from(DOCUMENT_MIME_TYPES).join(',');
    let resolved = false;
    input.onchange = () => {
      resolved = true;
      resolve(input.files?.[0] ?? null);
    };
    // If the picker is dismissed without choosing a file, most browsers fire
    // neither 'change' nor 'cancel' reliably across engines; 'cancel' is the
    // modern standard event, so listen for it as a best-effort fallback.
    input.addEventListener('cancel', () => {
      if (!resolved) resolve(null);
    });
    input.click();
  });
}

/** Why a file attachment failed to upload, in words a person can act on. */
export class FileUploadError extends Error {
  constructor(readonly fileName: string, reason: string) {
    super(`${fileName}: ${reason}`);
    this.name = 'FileUploadError';
  }
}

/**
 * Upload a general (non-image, non-audio) file to GCS via a presigned PUT
 * URL (OpenChat-85q.1). Web only — see the module note above. Returns an
 * Attachment with type:'file', ready to embed in a message.
 */
export async function uploadFile(file: File): Promise<Attachment> {
  if (!DOCUMENT_MIME_TYPES.has(file.type)) {
    const kind = file.type || 'This file type';
    throw new FileUploadError(file.name, `${kind} isn't supported.`);
  }
  if (file.size > MAX_DOCUMENT_BYTES) {
    throw new FileUploadError(
      file.name,
      `it's ${(file.size / 1024 / 1024).toFixed(1)} MB; the limit is ${MAX_DOCUMENT_BYTES / 1024 / 1024} MB.`
    );
  }

  let putUrl: string;
  let getUrl: string;
  try {
    ({ putUrl, getUrl } = await api.presignAttachment({
      filename: file.name,
      mimeType: file.type,
      sizeBytes: file.size,
    }));
  } catch (err) {
    const detail = err instanceof ApiError ? err.message : String(err);
    throw new FileUploadError(file.name, `the server wouldn't accept it (${detail})`);
  }

  const putRes = await fetch(putUrl, {
    method: 'PUT',
    headers: { 'Content-Type': file.type },
    body: file,
  });
  if (!putRes.ok) {
    throw new FileUploadError(file.name, `upload failed (${putRes.status})`);
  }

  return {
    type: 'file',
    url: getUrl,
    mimeType: file.type,
    filename: file.name,
    sizeBytes: file.size,
  };
}
