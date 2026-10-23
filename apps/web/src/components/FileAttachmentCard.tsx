import type { Attachment } from '../api';
import { formatFileSize } from '../utils/fileSize';
import { downloadUrl } from '../utils/download';

interface Props {
  attachment: Attachment;
  isOwn: boolean;
}

/** Mime-icon lookup for the file card (OpenChat-85q.1). No icon dependency —
 * reuses the emoji style already used elsewhere in the composer/attach UI. */
function iconFor(mimeType: string): string {
  if (mimeType === 'application/pdf') return '📄';
  if (mimeType.includes('zip')) return '🗜️';
  if (mimeType.includes('word') || mimeType === 'application/msword') return '📝';
  if (mimeType.includes('sheet') || mimeType === 'application/vnd.ms-excel' || mimeType === 'text/csv') return '📊';
  if (mimeType.includes('presentation') || mimeType === 'application/vnd.ms-powerpoint') return '📈';
  if (mimeType === 'text/plain') return '📃';
  return '📎';
}

function filenameFromUrl(url: string): string {
  try {
    const path = new URL(url).pathname;
    return decodeURIComponent(path.slice(path.lastIndexOf('/') + 1)) || 'File';
  } catch {
    return 'File';
  }
}

/** File card: mime icon, filename, human-readable size, Download button (OpenChat-85q.1). */
export function FileAttachmentCard({ attachment, isOwn }: Props) {
  const filename = attachment.filename || filenameFromUrl(attachment.url);
  const size = typeof attachment.sizeBytes === 'number' ? formatFileSize(attachment.sizeBytes) : null;

  return (
    <div
      className={`flex items-center gap-3 rounded-xl px-3 py-2 mb-1 ${
        isOwn ? 'bg-blue-400/30' : 'bg-gray-100 dark:bg-slate-700/60'
      }`}
    >
      <span className="text-2xl shrink-0" aria-hidden="true">{iconFor(attachment.mimeType)}</span>
      <div className="flex-1 min-w-0">
        <div className={`text-sm font-medium truncate ${isOwn ? 'text-white' : 'text-gray-900 dark:text-slate-100'}`}>
          {filename}
        </div>
        {size && (
          <div className={`text-xs ${isOwn ? 'text-blue-100' : 'text-gray-500 dark:text-slate-400'}`}>
            {size}
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={() => downloadUrl(attachment.url, filename)}
        aria-label={`Download ${filename}`}
        className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
          isOwn
            ? 'bg-white/20 text-white hover:bg-white/30'
            : 'bg-white dark:bg-slate-800 text-blue-600 dark:text-blue-400 border border-gray-200 dark:border-slate-600 hover:bg-gray-50 dark:hover:bg-slate-700'
        }`}
      >
        Download
      </button>
    </div>
  );
}
