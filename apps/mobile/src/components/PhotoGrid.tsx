/**
 * Photos inside a message bubble (OpenChat-6bg, multi-photo OpenChat-wpmb).
 *
 * One photo keeps its own aspect ratio. Several photos tile iMessage-style:
 * an odd count leads with one wide tile, the rest pair up as squares, and
 * past four the last tile shows "+N". Tapping a tile opens the viewer at that
 * photo so the user can page through all of them.
 */
import { Image, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import type { Attachment } from '../api/client';
import { radius, type } from '../theme/tokens';

const MAX_TILES = 4;

interface Props {
  photos: Attachment[];
  onOpen: (index: number) => void;
  /** Gap below the grid when a caption follows. */
  hasCaption: boolean;
}

export function PhotoGrid({ photos, onOpen, hasCaption }: Props) {
  if (photos.length === 0) return null;

  if (photos.length === 1) {
    const att = photos[0];
    const aspectRatio = att.width && att.height ? att.width / att.height : 1;
    return (
      <TouchableOpacity
        onPress={() => onOpen(0)}
        activeOpacity={0.85}
        style={{ marginBottom: hasCaption ? 6 : 0 }}
        accessibilityRole="imagebutton"
        accessibilityLabel="Photo, open full screen"
      >
        <Image
          source={{ uri: att.url }}
          style={[styles.single, { aspectRatio: Math.min(Math.max(aspectRatio, 0.5), 2) }]}
          resizeMode="cover"
        />
      </TouchableOpacity>
    );
  }

  const shown = photos.slice(0, MAX_TILES);
  const hidden = photos.length - shown.length;
  const leadWide = shown.length % 2 === 1;

  return (
    <View
      style={[styles.grid, { marginBottom: hasCaption ? 6 : 0 }]}
      accessibilityLabel={`${photos.length} photos`}
    >
      {shown.map((att, i) => {
        const wide = leadWide && i === 0;
        const isLast = i === shown.length - 1;
        return (
          <TouchableOpacity
            key={`${att.url}-${i}`}
            onPress={() => onOpen(i)}
            activeOpacity={0.85}
            style={[styles.tile, wide ? styles.tileWide : styles.tileHalf]}
            accessibilityRole="imagebutton"
            accessibilityLabel={`Photo ${i + 1} of ${photos.length}, open full screen`}
          >
            <Image
              source={{ uri: att.url }}
              style={[styles.tileImage, { aspectRatio: wide ? 1.6 : 1 }]}
              resizeMode="cover"
            />
            {isLast && hidden > 0 && (
              <View style={styles.moreOverlay} pointerEvents="none">
                <Text style={styles.moreText}>+{hidden}</Text>
              </View>
            )}
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  single: {
    width: '100%',
    borderRadius: radius.md,
    overflow: 'hidden',
  },
  grid: {
    width: '100%',
    flexDirection: 'row',
    flexWrap: 'wrap',
    borderRadius: radius.md,
    overflow: 'hidden',
    // Pull the tiles' 1px outer padding flush with the bubble edge.
    margin: -1,
  },
  tile: { padding: 1 },
  tileWide: { width: '100%' },
  tileHalf: { width: '50%' },
  tileImage: { width: '100%' },
  moreOverlay: {
    ...StyleSheet.absoluteFillObject,
    margin: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  moreText: { ...type.heading, color: 'white' },
});
