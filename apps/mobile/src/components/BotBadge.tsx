/**
 * Renders a small "🤖 AI" pill next to a name when the user is an AI agent
 * (isBot=true on the server User node). Mirrors the web client BotBadge.
 */
import { StyleSheet, Text, View } from 'react-native';
import { AppIcon } from './AppIcon';

interface Props {
  isBot?: boolean;
  compact?: boolean;
}

export function BotBadge({ isBot, compact }: Props) {
  if (!isBot) return null;
  if (compact) {
    return <View style={styles.compact} accessibilityLabel="AI agent"><AppIcon name="bot" color="#78716c" size={13} /></View>;
  }
  return (
    <View style={styles.pill} accessibilityLabel="AI agent">
      <AppIcon name="bot" color="#78716c" size={12} />
      <Text style={styles.pillText}>AI</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  compact: { marginLeft: 4, fontSize: 12 },
  pill: {
    marginLeft: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    backgroundColor: 'rgba(168, 85, 247, 0.18)',
    flexDirection: 'row',
    alignItems: 'center',
  },
  pillText: { fontSize: 10, fontWeight: '600', color: '#7e22ce' },
});
