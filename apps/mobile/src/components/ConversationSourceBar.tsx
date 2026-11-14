/**
 * Which messages a conversation shows when another network's chat has been
 * shared into it (OpenChat-c8to.4): everything in time order, only OpenChat,
 * or only the mirrored chat. Rendered only for conversations that have one.
 */
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';
import { radius, roles, space, touchTarget, type } from '../theme/tokens';
import { SOURCE_MODES, type SourceMode } from '../utils/unifiedTimeline';

interface Props {
  mode: SourceMode;
  onChange: (mode: SourceMode) => void;
  /** The mirrored network's name, e.g. "iMessage". */
  mirrorLabel: string;
  /** One line under the switch saying what the mirror is. */
  note?: string | null;
}

export function ConversationSourceBar({ mode, onChange, mirrorLabel, note }: Props) {
  const { scheme } = useTheme();
  const r = roles(getColors(scheme));
  const label = (value: SourceMode) => value === 'unified' ? 'Unified' : value === 'openchat' ? 'OpenChat' : mirrorLabel;
  return (
    <View style={[styles.bar, { backgroundColor: r.canvas, borderBottomColor: r.line }]} testID="conversation-source-bar">
      <View style={[styles.track, { backgroundColor: r.input }]} accessibilityRole="radiogroup" accessibilityLabel="Messages to show">
        {SOURCE_MODES.map(value => {
          const selected = mode === value;
          return (
            <TouchableOpacity
              key={value}
              style={[styles.segment, selected && { backgroundColor: r.card }]}
              onPress={() => onChange(value)}
              accessibilityRole="radio"
              accessibilityState={{ checked: selected }}
              accessibilityLabel={value === 'unified' ? `Unified: OpenChat and ${mirrorLabel} together` : `${label(value)} only`}
              testID={`source-mode-${value}`}
            >
              <Text style={[type.label, { color: selected ? r.text : r.textMeta }, selected && styles.selected]} numberOfLines={1}>{label(value)}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
      {note ? <Text style={[type.meta, styles.note, { color: r.textMeta }]} numberOfLines={2}>{note}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { paddingHorizontal: space[4], paddingVertical: space[2], borderBottomWidth: StyleSheet.hairlineWidth, gap: space[1] },
  track: { flexDirection: 'row', borderRadius: radius.md, padding: 2 },
  segment: { flex: 1, minHeight: touchTarget - 8, alignItems: 'center', justifyContent: 'center', borderRadius: radius.sm, paddingHorizontal: space[2] },
  selected: { fontWeight: '600' },
  note: { textAlign: 'center' },
});
