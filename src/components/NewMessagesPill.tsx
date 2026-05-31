/**
 * Floating pill shown over the message list when new messages have arrived
 * while the user is scrolled away from the bottom. Discord-style: "↓ N new
 * messages". Tapping it scrolls to the latest and clears the unread count.
 *
 * Positioning is `absolute`; the parent screen anchors it just above the
 * composer. The pill is intentionally non-modal — the list stays interactive
 * underneath so the user can keep reading history.
 */
import { StyleSheet, Text, TouchableOpacity } from 'react-native';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';

interface Props {
  count: number;
  onPress: () => void;
}

export function NewMessagesPill({ count, onPress }: Props) {
  const { scheme } = useTheme();
  const c = getColors(scheme);
  if (count <= 0) return null;
  const label = count === 1 ? '1 new message' : `${count} new messages`;
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.85}
      style={[styles.pill, { backgroundColor: c.primary, shadowColor: '#000' }]}
      accessibilityLabel={`${label}, tap to scroll to latest`}
      accessibilityRole="button"
    >
      <Text style={styles.arrow}>↓</Text>
      <Text style={styles.text}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  pill: {
    position: 'absolute',
    alignSelf: 'center',
    bottom: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 22,
    minHeight: 44,
    // Subtle shadow so the pill reads as floating above the messages.
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.18,
    shadowRadius: 6,
    elevation: 4,
  },
  arrow: { color: '#fff', fontSize: 14, fontWeight: '700' },
  text: { color: '#fff', fontSize: 13, fontWeight: '600' },
});
