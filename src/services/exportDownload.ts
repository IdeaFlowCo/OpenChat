import { Platform, Share } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';

function sanitizeFilename(filename: string): string {
  return filename.replace(/[/\\?%*:|"<>]/g, '-').slice(0, 120) || 'openchat-export.json';
}

export async function saveJsonDownload(filename: string, text: string): Promise<string> {
  const safeName = sanitizeFilename(filename);

  if (Platform.OS === 'web') {
    const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = safeName;
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    return safeName;
  }

  const baseDir = FileSystem.documentDirectory || FileSystem.cacheDirectory;
  if (!baseDir) throw new Error('File storage is not available on this device.');

  const uri = `${baseDir}${safeName}`;
  await FileSystem.writeAsStringAsync(uri, text, {
    encoding: FileSystem.EncodingType.UTF8,
  });

  await Share.share({
    title: safeName,
    message: `OpenChat export: ${safeName}`,
    url: uri,
  });

  return safeName;
}
