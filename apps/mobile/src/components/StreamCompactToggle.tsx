import React from 'react';
import { StyleSheet, Text, TouchableOpacity } from 'react-native';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';
import { useStreamCompact } from '../services/streamDisplay';
import { radius, roles, space, type } from '../theme/tokens';

/** One switch for Compact view, shared by the personal and chat Streams. */
export function StreamCompactToggle() {
  const c = getColors(useTheme().scheme);
  const [compact, setCompact] = useStreamCompact();
  const r = roles(c);
  return (
    <TouchableOpacity
      accessibilityRole="switch"
      accessibilityLabel="Compact view"
      accessibilityState={{ checked: compact }}
      onPress={() => setCompact(!compact)}
      hitSlop={{ top: 6, bottom: 6, left: 2, right: 2 }}
      style={{ minHeight: 32, justifyContent: 'center', paddingHorizontal: space[3], borderRadius: radius.pill, borderWidth: StyleSheet.hairlineWidth, borderColor: compact ? 'transparent' : r.line, backgroundColor: compact ? r.accentSoft : r.card }}
    >
      <Text style={[type.label, { color: compact ? r.onAccentSoft : r.textSecondary }]}>{compact ? '✓ Compact view' : 'Compact view'}</Text>
    </TouchableOpacity>
  );
}
