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

/**
 * Trigger a browser download of a remote URL — used for file-attachment
 * "Download" buttons (OpenChat-85q.1). The `download` attribute is a hint
 * that browsers honor for same-origin and many cross-origin URLs (our GCS
 * object URLs); same-origin policy aside, the worst case is the browser
 * opens the file in a new tab instead of saving it directly, which is still
 * a working fallback.
 */
export function downloadUrl(url: string, filename: string): void {
  const safeName = filename.replace(/[/\\?%*:|"<>]/g, '-').slice(0, 120) || 'download';
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = safeName;
  anchor.target = '_blank';
  anchor.rel = 'noopener noreferrer';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}
