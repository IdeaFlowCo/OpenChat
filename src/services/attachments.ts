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

export interface PickedAsset {
  uri: string;
  mimeType: string;
  width: number;
  height: number;
  fileName: string;
  fileSize: number;
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
