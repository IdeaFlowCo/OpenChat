import { StyleSheet, Text, View } from 'react-native';
import type { MessageStatusEntry } from '../api/client';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';
import { radius, space, type } from '../theme/tokens';

/** Same words as Stream items' status choices. */
export function messageStatusChipLabel(entry: MessageStatusEntry): string {
  const state = entry.status === 'closed' ? '✓ Closed' : '● Open';
  if (entry.own) return entry.visibility === 'chat' ? `${state} · you` : `${state} · only you`;
  return `${state} · ${entry.userName}`;
}

/** Compact status chips under a message. Own status first, then others by name. */
export function MessageStatusChips({ statuses, isOwn }: { statuses?: MessageStatusEntry[]; isOwn: boolean }) {
  const { scheme } = useTheme();
  const c = getColors(scheme);
  if (!statuses?.length) return null;
  const ordered = [...statuses].sort((a, b) => Number(b.own) - Number(a.own) || a.userName.localeCompare(b.userName));
  return <View style={[styles.row, { justifyContent: isOwn ? 'flex-end' : 'flex-start' }]} testID="message-status-chips">
    {ordered.map(entry => {
      const label = messageStatusChipLabel(entry);
      const open = entry.status === 'open';
      return <View
        key={entry.userId}
        accessible
        accessibilityLabel={`Status ${entry.status === 'closed' ? 'Closed' : 'Open'}, set by ${entry.own ? 'you' : entry.userName}${entry.own && entry.visibility === 'private' ? ', visible only to you' : ''}`}
        style={[styles.chip, { borderColor: open ? c.primary : c.border, backgroundColor: c.surface }]}
      >
        <Text numberOfLines={1} style={[styles.label, { color: open ? c.primary : c.textMetadata }]}>{label}</Text>
      </View>;
    })}
  </View>;
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: space[1], marginTop: 2, maxWidth: '100%' },
  chip: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.pill, paddingHorizontal: space[2], paddingVertical: 1, maxWidth: 220 },
  label: { ...type.meta },
});
