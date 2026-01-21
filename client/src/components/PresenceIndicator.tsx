interface PresenceIndicatorProps {
  status?: string;
  size?: 'sm' | 'md' | 'lg';
}

export function PresenceIndicator({ status = 'offline', size = 'md' }: PresenceIndicatorProps) {
  const sizeClasses = {
    sm: 'w-2 h-2',
    md: 'w-3 h-3',
    lg: 'w-4 h-4',
  };

  const statusColors: Record<string, string> = {
    available: 'bg-green-500',
    away: 'bg-yellow-500',
    busy: 'bg-red-500',
    invisible: 'bg-gray-400',
    offline: 'bg-gray-400',
  };

  const color = statusColors[status] || statusColors.offline;

  return (
    <span
      className={`inline-block rounded-full ${sizeClasses[size]} ${color}`}
      title={status}
    />
  );
}
