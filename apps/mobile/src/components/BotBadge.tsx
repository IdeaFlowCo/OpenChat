/**
 * Renders a small "🤖 AI" pill next to a name when the user is an AI agent
 * (isBot=true on the server User node). Mirrors the web client BotBadge.
 */
import { StyleSheet, Text, View } from 'react-native';
import { AppIcon } from './AppIcon';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';

interface Props {
  isBot?: boolean;
  compact?: boolean;
}

export function BotBadge({ isBot, compact }: Props) {
  const { scheme } = useTheme();
  const c = getColors(scheme);
  if (!isBot) return null;
  if (compact) {
    return (
      <View style={styles.compact} accessible accessibilityLabel="AI participant">
        <AppIcon name="bot" color={c.textMetadata} size={13} />
      </View>
    );
  }
  return (
    <View style={[styles.pill, { backgroundColor: c.surfaceElevated }]} accessible accessibilityLabel="AI participant">
      <AppIcon name="bot" color={c.textMetadata} size={12} />
      <Text style={[styles.pillText, { color: c.textMetadata }]}>AI</Text>
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
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  pillText: { fontSize: 10, fontWeight: '600' },
});
