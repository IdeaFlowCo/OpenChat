/**
 * Trigger a browser download of a text blob (used for data export — bmp.10).
 * Mirrors the web branch of mobile's saveJsonDownload.
 */
export function saveTextDownload(filename: string, text: string, mimeType = 'application/json;charset=utf-8'): string {
  const safeName = (filename.replace(/[/\\?%*:|"<>]/g, '-').slice(0, 120)) || 'openchat-export.json';
  const blob = new Blob([text], { type: mimeType });
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
