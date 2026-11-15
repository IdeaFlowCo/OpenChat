import { useState } from 'react';

/** Instant web hover/focus feedback; native controls retain pressed opacity. */
export function useControlFeedback() {
  const [hovered, setHovered] = useState(false), [focused, setFocused] = useState(false);
  const web = 'document' in globalThis;
  return {
    active: hovered || focused,
    activeOpacity: web ? 1 : 0.7,
    events: web ? {
      onMouseEnter: () => setHovered(true), onMouseLeave: () => setHovered(false),
      onFocus: () => setFocused(true), onBlur: () => setFocused(false),
    } : {},
  };
}
