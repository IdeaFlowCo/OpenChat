/**
 * Renders a small "You" pill next to a name when the row refers to the
 * signed-in user (e.g. picking yourself for a "note to self" chat).
 * Mirrors BotBadge's compact/pill styling for visual consistency.
 */
import { StyleSheet, Text, View } from 'react-native';

interface Props {
  isSelf?: boolean;
  compact?: boolean;
}

export function YouBadge({ isSelf, compact }: Props) {
  if (!isSelf) return null;
  if (compact) {
    return (
      <View style={styles.compact} accessibilityLabel="You">
        <Text style={styles.compactText}>You</Text>
      </View>
    );
  }
  return (
    <View style={styles.pill} accessibilityLabel="You">
      <Text style={styles.pillText}>You</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  compact: {
    marginLeft: 4,
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 4,
    backgroundColor: 'rgba(59, 130, 246, 0.18)',
  },
  compactText: { fontSize: 10, fontWeight: '600', color: '#2563eb' },
  pill: {
    marginLeft: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    backgroundColor: 'rgba(59, 130, 246, 0.18)',
    flexDirection: 'row',
    alignItems: 'center',
  },
  pillText: { fontSize: 10, fontWeight: '600', color: '#2563eb' },
});
