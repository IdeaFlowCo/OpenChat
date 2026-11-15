/**
 * VisionNoteCard — Stream search result from Vision. Same index-card look as
 * ThoughtCard, but no pin, collapse, edit or delete: the note lives in Vision
 * and is edited there ("Open in Vision"). Its text is selectable and has an
 * explicit Copy. Search is Vision-backed (see utils/visionSearch.ts).
 */

import { Linking, Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';
import { radius, space, type } from '../theme/tokens';
import { formatRelativeTime } from './ThoughtCard';
import { isOpenableVisionUrl, type VisionSearchRow } from '../utils/visionSearch';
import { CopyButton } from './CopyButton';

export const OPEN_IN_VISION_LABEL = 'Open in Vision';

function openVisionUrl(url: string): void {
  if (!isOpenableVisionUrl(url)) return;
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    window.open(url, '_blank', 'noopener,noreferrer');
    return;
  }
  void Linking.openURL(url).catch(() => undefined);
}

export function VisionNoteCard({ row }: { row: VisionSearchRow }) {
  const { scheme } = useTheme();
  const c = getColors(scheme);
  return (
    <View
      testID="vision-note-card"
      style={[styles.card, { backgroundColor: c.surface, borderColor: c.border, borderLeftColor: c.primary }]}
    >
      <View style={styles.header}>
        {!!row.createdAt && <Text style={[styles.meta, { color: c.textMetadata }]}>{formatRelativeTime(row.createdAt)}</Text>}
        <View style={styles.spacer} />
        <Text style={[styles.meta, { color: c.textMetadata }]}>Vision</Text>
      </View>
      {!!row.title && <Text selectable style={[styles.title, { color: c.textPrimary }]} numberOfLines={2}>{row.title}</Text>}
      <Text selectable style={[styles.body, { color: c.textPrimary }]} numberOfLines={8}>{row.text}</Text>
      {!!row.sourcePlatform && <Text style={[styles.meta, styles.subtitle, { color: c.textMetadata }]} numberOfLines={1}>{`from ${row.sourcePlatform}`}</Text>}
      {row.tags.length > 0 && (
        <View style={styles.tagRow}>
          {row.tags.map((tag) => (
            <View key={tag} style={[styles.tag, { backgroundColor: c.primaryMuted }]}>
              <Text selectable style={[styles.tagText, { color: c.primary }]}>#{tag.replace(/^#/, '')}</Text>
            </View>
          ))}
        </View>
      )}
      <View style={styles.actions}>
      <CopyButton text={row.text} accessibilityLabel="Copy note text" testID="vision-note-copy" />
      {isOpenableVisionUrl(row.url) && (
        <TouchableOpacity
          onPress={() => openVisionUrl(row.url)}
          accessibilityRole="link"
          accessibilityLabel={OPEN_IN_VISION_LABEL}
          hitSlop={{ top: space[2], bottom: space[2], left: space[2], right: space[2] }}
          style={styles.link}
        >
          <Text style={[styles.linkText, { color: c.primary }]}>{OPEN_IN_VISION_LABEL}</Text>
        </TouchableOpacity>
      )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radius.md,
    borderWidth: 1,
    borderLeftWidth: 3,
    padding: space[3],
    marginBottom: space[3],
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: space[2], marginBottom: space[2] },
  spacer: { flex: 1 },
  meta: { ...type.meta },
  title: { ...type.bodyStrong, marginBottom: space[1] },
  body: { ...type.body },
  subtitle: { marginTop: space[2] },
  tagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space[2], marginTop: space[3] },
  tag: { paddingHorizontal: space[2], paddingVertical: space[1], borderRadius: radius.pill },
  tagText: { ...type.meta, fontWeight: '500' },
  actions: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: space[3], marginTop: space[2] },
  link: { alignSelf: 'flex-start', minHeight: space[6], justifyContent: 'center' },
  linkText: { ...type.label },
});
