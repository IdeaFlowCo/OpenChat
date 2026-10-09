/**
 * Jump-to-latest arrow (OpenChat-krsw).
 *
 * A small round down-arrow over the bottom-right of the message list, shown
 * whenever the user has scrolled up — the iMessage/Telegram convention. When
 * new messages arrived meanwhile it carries an unread badge (replacing the
 * wide "N new messages" pill). Tapping scrolls to the latest message.
 *
 * Positioning is `absolute`; the parent anchors it inside the list container.
 */
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';
import { AppIcon } from './AppIcon';

interface Props {
  unreadCount: number;
  onPress: () => void;
}

export function JumpToBottomButton({ unreadCount, onPress }: Props) {
  const { scheme } = useTheme();
  const c = getColors(scheme);
  const label =
    unreadCount > 0
      ? `${unreadCount === 1 ? '1 new message' : `${unreadCount} new messages`}, jump to latest`
      : 'Jump to latest message';
  return (
    <Pressable
      onPress={onPress}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: c.surface, borderColor: c.border, shadowColor: '#000', opacity: pressed ? 0.8 : 1 },
      ]}
    >
      <AppIcon name="chevron-down" color={c.textPrimary} size={20} />
      {unreadCount > 0 && (
        <View style={[styles.badge, { backgroundColor: c.primary }]}>
          <Text style={[styles.badgeText, { color: c.onPrimary }]}>
            {unreadCount > 99 ? '99+' : unreadCount}
          </Text>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    position: 'absolute',
    right: 12,
    bottom: 12,
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.15,
    shadowRadius: 4,
    elevation: 3,
  },
  badge: {
    position: 'absolute',
    top: -6,
    right: -4,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    paddingHorizontal: 5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { fontSize: 11, fontWeight: '700' },
});
