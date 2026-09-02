import Svg, { Circle, Line, Path, Polyline } from 'react-native-svg';

export type AppIconName =
  | 'attach'
  | 'block'
  | 'bot'
  | 'chat'
  | 'chevron-left'
  | 'chevron-right'
  | 'copy'
  | 'download'
  | 'edit'
  | 'flag'
  | 'forward'
  | 'heart'
  | 'info'
  | 'mic'
  | 'more'
  | 'mute'
  | 'pause'
  | 'pin'
  | 'play'
  | 'plus'
  | 'reply'
  | 'search'
  | 'settings'
  | 'sparkle'
  | 'stop'
  | 'thought'
  | 'trash'
  | 'x';

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
        /* Sliders — unambiguous "preferences" (the old radiating-gear read as
           a sun/theme-toggle at small sizes; see 2026-09-02 feedback). */
        <>
          <Line x1="4" y1="7" x2="20" y2="7" {...common} />
          <Circle cx="9.5" cy="7" r="2" {...common} fill="none" />
          <Line x1="4" y1="12" x2="20" y2="12" {...common} />
          <Circle cx="15" cy="12" r="2" {...common} fill="none" />
          <Line x1="4" y1="17" x2="20" y2="17" {...common} />
          <Circle cx="8" cy="17" r="2" {...common} fill="none" />
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
      {name === 'copy' && (
        <>
          <Path d="M9 9h11a1.5 1.5 0 0 1 1.5 1.5V20A1.5 1.5 0 0 1 20 21.5H9A1.5 1.5 0 0 1 7.5 20v-9.5A1.5 1.5 0 0 1 9 9z" {...common} />
          <Path d="M4.5 15H4a1.5 1.5 0 0 1-1.5-1.5V4A1.5 1.5 0 0 1 4 2.5h9.5A1.5 1.5 0 0 1 15 4v.5" {...common} />
        </>
      )}
      {name === 'reply' && (
        <>
          <Polyline points="9 14 4 9 9 4" {...common} />
          <Path d="M4 9h10a6 6 0 0 1 6 6v4" {...common} />
        </>
      )}
      {name === 'forward' && (
        <>
          <Polyline points="15 14 20 9 15 4" {...common} />
          <Path d="M20 9H10a6 6 0 0 0-6 6v4" {...common} />
        </>
      )}
      {name === 'bot' && (
        <>
          <Path d="M6 8h12a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z" {...common} />
          <Line x1="12" y1="8" x2="12" y2="4.5" {...common} />
          <Circle cx="12" cy="3.5" r="1" fill={color} />
          <Circle cx="9" cy="12.5" r="1" fill={color} />
          <Circle cx="15" cy="12.5" r="1" fill={color} />
          <Path d="M9.5 16h5" {...common} />
        </>
      )}
      {name === 'edit' && (
        <>
          <Path d="M17 3a2.83 2.83 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" {...common} />
        </>
      )}
      {name === 'trash' && (
        <>
          <Path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" {...common} />
          <Path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" {...common} />
          <Line x1="10" y1="11" x2="10" y2="17" {...common} />
          <Line x1="14" y1="11" x2="14" y2="17" {...common} />
        </>
      )}
      {name === 'block' && (
        <>
          <Circle cx="12" cy="12" r="9" {...common} />
          <Line x1="5.6" y1="5.6" x2="18.4" y2="18.4" {...common} />
        </>
      )}
      {name === 'flag' && (
        <>
          <Path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V4s-1 1-4 1-5-2-8-2-4 1-4 1z" {...common} />
          <Line x1="4" y1="22" x2="4" y2="15" {...common} />
        </>
      )}
      {name === 'info' && (
        <>
          <Circle cx="12" cy="12" r="9" {...common} />
          <Line x1="12" y1="11" x2="12" y2="16.5" {...common} />
          <Circle cx="12" cy="7.5" r="1" fill={color} />
        </>
      )}
      {name === 'sparkle' && (
        <>
          <Path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z" {...common} />
          <Path d="M19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8L19 16z" {...common} />
        </>
      )}
      {name === 'play' && (
        <Path d="M7 5.2v13.6c0 .8.9 1.3 1.6.9l10.8-6.8c.6-.4.6-1.4 0-1.8L8.6 4.3c-.7-.4-1.6.1-1.6.9z" fill={color} stroke="none" />
      )}
      {name === 'pause' && (
        <>
          <Path d="M7.5 5h2.2v14H7.5z" fill={color} stroke="none" />
          <Path d="M14.3 5h2.2v14h-2.2z" fill={color} stroke="none" />
        </>
      )}
      {name === 'x' && (
        <>
          <Line x1="6" y1="6" x2="18" y2="18" {...common} />
          <Line x1="18" y1="6" x2="6" y2="18" {...common} />
        </>
      )}
    </Svg>
  );
}
