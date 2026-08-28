import Svg, { Circle, Line, Path, Polyline } from 'react-native-svg';

export type AppIconName =
  | 'chevron-left'
  | 'chevron-right'
  | 'download'
  | 'more'
  | 'mute'
  | 'plus'
  | 'search'
  | 'settings';

interface AppIconProps {
  name: AppIconName;
  color: string;
  size?: number;
  strokeWidth?: number;
}

/**
 * Small, dependency-free line icon set for shared app chrome.
 *
 * These deliberately use react-native-svg (already required by OpenChat) so
 * toolbar actions render identically on iOS, Android, and RN web instead of
 * changing shape/color with each platform's emoji font.
 */
export function AppIcon({ name, color, size = 20, strokeWidth = 2 }: AppIconProps) {
  const common = {
    fill: 'none',
    stroke: color,
    strokeWidth,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };

  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      accessible={false}
      focusable={false}
    >
      {name === 'search' && (
        <>
          <Circle cx="11" cy="11" r="7" {...common} />
          <Line x1="16.2" y1="16.2" x2="21" y2="21" {...common} />
        </>
      )}
      {name === 'plus' && (
        <>
          <Line x1="12" y1="5" x2="12" y2="19" {...common} />
          <Line x1="5" y1="12" x2="19" y2="12" {...common} />
        </>
      )}
      {name === 'settings' && (
        <>
          <Circle cx="12" cy="12" r="3.25" {...common} />
          <Path
            d="M12 2v3M12 19v3M2 12h3M19 12h3M4.93 4.93l2.12 2.12M16.95 16.95l2.12 2.12M19.07 4.93l-2.12 2.12M7.05 16.95l-2.12 2.12"
            {...common}
          />
        </>
      )}
      {name === 'chevron-left' && (
        <Polyline points="15 18 9 12 15 6" {...common} />
      )}
      {name === 'chevron-right' && (
        <Polyline points="9 18 15 12 9 6" {...common} />
      )}
      {name === 'download' && (
        <>
          <Line x1="12" y1="3" x2="12" y2="15" {...common} />
          <Polyline points="7 10 12 15 17 10" {...common} />
          <Path d="M5 20h14" {...common} />
        </>
      )}
      {name === 'mute' && (
        <>
          <Path d="M8.5 17h7M10 20h4M6 14.5V10a6 6 0 0 1 9.7-4.7M18 10v4.5l1.5 2.5H8" {...common} />
          <Line x1="4" y1="4" x2="20" y2="20" {...common} />
        </>
      )}
      {name === 'more' && (
        <>
          <Circle cx="5" cy="12" r="1" fill={color} />
          <Circle cx="12" cy="12" r="1" fill={color} />
          <Circle cx="19" cy="12" r="1" fill={color} />
        </>
      )}
    </Svg>
  );
}
