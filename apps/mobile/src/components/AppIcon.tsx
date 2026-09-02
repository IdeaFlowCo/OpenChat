import Svg, { Circle, Line, Path, Polyline } from 'react-native-svg';

export type AppIconName =
  | 'attach'
  | 'chat'
  | 'chevron-left'
  | 'chevron-right'
  | 'download'
  | 'heart'
  | 'mic'
  | 'more'
  | 'mute'
  | 'pin'
  | 'plus'
  | 'search'
  | 'settings'
  | 'stop'
  | 'thought';

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
      {name === 'thought' && (
        <>
          {/* Cloud-style thought bubble with trailing dots */}
          <Path
            d="M18.5 13.5a4 4 0 0 0-1-7.9 5 5 0 0 0-9.4.9A3.6 3.6 0 0 0 8 13.7c.4 0 9.5 0 10.5-.2z"
            {...common}
          />
          <Circle cx="8" cy="17.5" r="1.3" {...common} />
          <Circle cx="5" cy="20.5" r="0.8" {...common} />
        </>
      )}
      {name === 'pin' && (
        <>
          {/* Push-pin: head + body + point */}
          <Path d="M9 4h6M10 4l-.5 6L6.8 12a1 1 0 0 0 .7 1.7h9a1 1 0 0 0 .7-1.7L14.5 10 14 4" {...common} />
          <Line x1="12" y1="13.7" x2="12" y2="20" {...common} />
        </>
      )}
      {name === 'chat' && (
        /* Speech bubble with tail (feather message-circle style) */
        <Path
          d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"
          {...common}
        />
      )}
      {name === 'attach' && (
        /* Paperclip (feather-style) */
        <Path
          d="M21.44 11.05l-8.49 8.49a5.5 5.5 0 0 1-7.78-7.78l8.49-8.49a3.67 3.67 0 0 1 5.19 5.19l-8.49 8.48a1.83 1.83 0 0 1-2.59-2.59l7.78-7.78"
          {...common}
        />
      )}
      {name === 'mic' && (
        <>
          <Path d="M12 2a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3z" {...common} />
          <Path d="M19 10v1a7 7 0 0 1-14 0v-1" {...common} />
          <Line x1="12" y1="18" x2="12" y2="22" {...common} />
        </>
      )}
      {name === 'stop' && (
        /* Filled rounded square — stop recording */
        <Path d="M7 7h10a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1z" fill={color} stroke={color} strokeWidth={strokeWidth} />
      )}
      {name === 'heart' && (
        <Path
          d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"
          {...common}
        />
      )}
    </Svg>
  );
}
