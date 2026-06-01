/**
 * ReactionPicker — compact horizontal row of 6 emoji for message reactions.
 * Shown inside the MessageActionSheet when the user taps "React".
 * (OpenChat-7bd)
 */

import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';

export const REACTION_EMOJI = ['👍', '❤️', '😂', '😮', '😢', '🙏'] as const;
export type ReactionEmoji = (typeof REACTION_EMOJI)[number];

interface Props {
  /** Emoji strings that the current user has already reacted with (highlight them). */
  myReactions?: string[];
  onPick: (emoji: string) => void;
}

export function ReactionPicker({ myReactions = [], onPick }: Props) {
  const { scheme } = useTheme();
  const c = getColors(scheme);

  return (
    <View style={[styles.row, { backgroundColor: c.surfaceElevated, borderColor: c.border }]}>
      {REACTION_EMOJI.map(emoji => {
        const active = myReactions.includes(emoji);
        return (
          <TouchableOpacity
            key={emoji}
            style={[styles.btn, active && { backgroundColor: c.primaryMuted, borderRadius: 20 }]}
            onPress={() => onPick(emoji)}
            activeOpacity={0.7}
            accessibilityLabel={`React with ${emoji}`}
          >
            <Text style={styles.emoji}>{emoji}</Text>
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
  btn: {
    padding: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emoji: {
    fontSize: 26,
  },
});
