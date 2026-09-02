type AppIconName = 'agent' | 'mute' | 'search';

interface AppIconProps {
  name: AppIconName;
  className?: string;
  size?: number;
  strokeWidth?: number;
}

export function AppIcon({ name, className, size = 20, strokeWidth = 2 }: AppIconProps) {
  const common = {
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {name === 'search' && (
        <>
          <circle cx="11" cy="11" r="7" {...common} />
          <line x1="16.2" y1="16.2" x2="21" y2="21" {...common} />
        </>
      )}
      {name === 'mute' && (
        <>
          <path d="M8.5 17h7M10 20h4M6 14.5V10a6 6 0 0 1 9.7-4.7M18 10v4.5l1.5 2.5H8" {...common} />
          <line x1="4" y1="4" x2="20" y2="20" {...common} />
        </>
      )}
      {name === 'agent' && (
        <>
          <rect x="5" y="7" width="14" height="11" rx="4" {...common} />
          <path d="M12 7V4M9.5 4h5" {...common} />
          <circle cx="9.5" cy="12" r="1" fill="currentColor" stroke="none" />
          <circle cx="14.5" cy="12" r="1" fill="currentColor" stroke="none" />
          <path d="M9.5 15h5" {...common} />
        </>
      )}
    </svg>
  );
}
