/**
 * ReactionsBar — horizontal row of emoji pills shown below a message bubble.
 * Each pill shows the emoji + count. Tapping a pill calls onToggle(emoji),
 * which adds the reaction if the user hasn't reacted yet, or removes it if
 * byMe is true.
 * (OpenChat-7bd)
 */

import { Linking, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';
import type { ReactionSummary } from '../api/client';

interface Props {
  reactions: ReactionSummary[];
  /** Whether the bubble is an own-message bubble (affects pill color variant). */
  isOwn: boolean;
  onToggle: (emoji: string) => void;
}

export function ReactionsBar({ reactions, isOwn, onToggle }: Props) {
  const { scheme } = useTheme();
  const c = getColors(scheme);

  if (!reactions || reactions.length === 0) return null;

  return (
    <View style={[styles.bar, { justifyContent: isOwn ? 'flex-end' : 'flex-start' }]}>
      {reactions.map(r => {
        // Kind reactions with an href (e.g. a bot's filed receipt) render as a
        // tappable link that opens the target page, instead of a toggle pill
        // (openchat-reaction-kind).
        if (r.kind && r.href) {
          const href = r.href;
          return (
            <TouchableOpacity
              key={`${r.kind}:${r.emoji}:${r.href}`}
              style={[styles.pill, { backgroundColor: c.primaryMuted, borderColor: c.primary }]}
              onPress={() => void Linking.openURL(href)}
              activeOpacity={0.7}
              accessibilityRole="link"
              accessibilityLabel={`${r.kind} receipt, opens link`}
            >
              <Text style={styles.emoji}>{r.emoji}</Text>
              <Text style={[styles.kind, { color: c.primary }]}>{r.kind}</Text>
              {r.count > 1 && (
                <Text style={[styles.count, { color: c.primary }]}>{r.count}</Text>
              )}
            </TouchableOpacity>
          );
        }
        return (
          <TouchableOpacity
            key={r.emoji}
            style={[
              styles.pill,
              {
                backgroundColor: r.byMe ? c.primaryMuted : c.surfaceElevated,
                borderColor: r.byMe ? c.primary : c.border,
              },
            ]}
            onPress={() => onToggle(r.emoji)}
            activeOpacity={0.7}
            accessibilityLabel={`${r.emoji} ${r.count} reaction${r.count !== 1 ? 's' : ''}`}
          >
            <Text style={styles.emoji}>{r.emoji}</Text>
            {r.count > 1 && (
              <Text style={[styles.count, { color: r.byMe ? c.primary : c.textSecondary }]}>
                {r.count}
              </Text>
            )}
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
    marginTop: 3,
    paddingHorizontal: 2,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 7,
    paddingVertical: 3,
    gap: 3,
  },
  emoji: { fontSize: 14 },
  count: { fontSize: 12, fontWeight: '600' },
  kind: { fontSize: 12, fontWeight: '600', textTransform: 'capitalize' },
});
