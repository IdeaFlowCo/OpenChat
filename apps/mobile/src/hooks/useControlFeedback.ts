import { useState } from 'react';

/** Instant hover/focus feedback; no animated opacity, including reduced motion. */
export function useControlFeedback() {
  const [hovered, setHovered] = useState(false), [focused, setFocused] = useState(false);
  return {
    active: hovered || focused,
    activeOpacity: 1,
    events: 'document' in globalThis ? {
      onMouseEnter: () => setHovered(true), onMouseLeave: () => setHovered(false),
      onFocus: () => setFocused(true), onBlur: () => setFocused(false),
    } : {},
  };
}
