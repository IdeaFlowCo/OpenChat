import React from 'react';
import { Text, TouchableOpacity } from 'react-native';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';
import { useStreamCompact } from '../services/streamDisplay';
import { radius, touchTarget } from '../theme/tokens';

/** One switch for Compact view, shared by the personal and chat Streams. */
export function StreamCompactToggle() {
  const c = getColors(useTheme().scheme);
  const [compact, setCompact] = useStreamCompact();
  return (
    <TouchableOpacity
      accessibilityRole="switch"
      accessibilityLabel="Compact view"
      accessibilityState={{ checked: compact }}
      onPress={() => setCompact(!compact)}
      style={{ minHeight: touchTarget, justifyContent: 'center', paddingHorizontal: 8, borderRadius: radius.sm, backgroundColor: compact ? c.primaryMuted : undefined }}
    >
      <Text style={{ color: c.primary }}>{compact ? '✓ Compact view' : 'Compact view'}</Text>
    </TouchableOpacity>
  );
}
