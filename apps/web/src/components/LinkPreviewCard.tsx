import { LinkPreview } from '../api';

interface Props {
  preview: LinkPreview;
  isOwn: boolean;
}

// Open Graph link preview card rendered below a message bubble (bmp.8).
// Mirrors apps/mobile/src/components/LinkPreviewCard.tsx.
export function LinkPreviewCard({ preview, isOwn }: Props) {
  if (!preview.title && !preview.description && !preview.image) return null;
  return (
    <a
      href={preview.url}
      target="_blank"
      rel="noopener noreferrer"
      className={`mt-1.5 flex overflow-hidden rounded-lg border transition-colors ${
        isOwn
          ? 'border-white/20 bg-white/10 hover:bg-white/20'
          : 'border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-800 hover:bg-gray-100 dark:hover:bg-slate-700'
      }`}
    >
      {preview.image && (
        <img src={preview.image} alt="" className="h-16 w-16 shrink-0 object-cover" loading="lazy" />
      )}
      <div className="min-w-0 flex-1 p-2">
        {preview.title && (
          <p className={`line-clamp-2 text-xs font-semibold ${isOwn ? 'text-white' : 'text-gray-900 dark:text-slate-100'}`}>
            {preview.title}
          </p>
        )}
        {preview.description && (
          <p className={`line-clamp-2 text-xs ${isOwn ? 'text-white/75' : 'text-gray-600 dark:text-slate-400'}`}>
            {preview.description}
          </p>
        )}
        {preview.siteName && (
          <p className={`mt-0.5 truncate text-[11px] ${isOwn ? 'text-white/55' : 'text-gray-400 dark:text-slate-500'}`}>
            {preview.siteName}
          </p>
        )}
      </div>
    </a>
  );
}
