import { useState } from 'react';
import { Platform } from 'react-native';

/** Instant hover/focus feedback; no animated opacity, including reduced motion. */
export function useControlFeedback() {
  const [hovered, setHovered] = useState(false), [focused, setFocused] = useState(false);
  return {
    active: hovered || focused,
    activeOpacity: 1,
    events: Platform.OS === 'web' ? {
      onMouseEnter: () => setHovered(true), onMouseLeave: () => setHovered(false),
      onFocus: () => setFocused(true), onBlur: () => setFocused(false),
    } : {},
  };
}
