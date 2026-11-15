/**
 * ReactionPicker — compact horizontal row of 6 emoji for message reactions.
 * Shown inside the MessageActionSheet when the user taps "React".
 * (OpenChat-7bd)
 */

import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';
import { radius, type } from '../theme/tokens';

export const REACTION_EMOJI = ['👍', '❤️', '😂', '😮', '😢', '🙏'] as const;
export type ReactionEmoji = (typeof REACTION_EMOJI)[number];

interface Props {
  /** Emoji strings that the current user has already reacted with (highlight them). */
  myReactions?: string[];
  onPick: (emoji: string) => void;
  /** Tighter row for the desktop pointer menu. */
  compact?: boolean;
}

export function ReactionPicker({ myReactions = [], onPick, compact = false }: Props) {
  const { scheme } = useTheme();
  const c = getColors(scheme);

  return (
    <View style={[styles.row, compact && styles.rowCompact, { backgroundColor: c.surfaceElevated, borderColor: c.border }]}>
      {REACTION_EMOJI.map(emoji => {
        const active = myReactions.includes(emoji);
        return (
          <TouchableOpacity
            key={emoji}
            style={[styles.btn, compact && styles.btnCompact, active && { backgroundColor: c.primaryMuted, borderRadius: 20 }]}
            onPress={() => onPick(emoji)}
            activeOpacity={0.7}
            accessibilityLabel={`React with ${emoji}`}
          >
            <Text style={compact ? styles.emojiCompact : styles.emoji}>{emoji}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginHorizontal: 16,
    marginBottom: 8,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
  },
  rowCompact: { paddingHorizontal: 4, paddingVertical: 2, marginHorizontal: 8, marginBottom: 4, marginTop: 4, borderRadius: radius.md },
  btnCompact: { padding: 5 },
  emojiCompact: { ...type.heading, fontWeight: '400', letterSpacing: 0 },
  btn: {
    padding: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emoji: {
    fontSize: 26,
  },
});
