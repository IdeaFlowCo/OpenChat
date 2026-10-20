/**
 * Fullscreen photo viewer (OpenChat-6bg, paging OpenChat-wpmb).
 *
 * Shows every photo of one message; swipe (native) or the arrow buttons and
 * ←/→ keys (web) move between them, with an "n of N" counter. Tapping the
 * backdrop or × closes it. Share (iOS/Android) or Download (web) saves the
 * current photo (OpenChat-5wm2).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Modal,
  NativeScrollEvent,
  NativeSyntheticEvent,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { AppIcon } from './AppIcon';
import { photoActionLabel, saveOrSharePhoto } from '../services/photoActions';
import { radius, space, type } from '../theme/tokens';

export interface PhotoViewerState {
  urls: string[];
  index: number;
}

interface Props {
  state: PhotoViewerState | null;
  onClose: () => void;
}

export function PhotoViewer({ state, onClose }: Props) {
  // Measured from the overlay so pages track window resizes on web/desktop.
  const [{ width, height }, setSize] = useState({ width: 0, height: 0 });
  const scrollRef = useRef<ScrollView>(null);
  const [index, setIndex] = useState(0);
  const [saving, setSaving] = useState(false);
  const urls = state?.urls ?? [];
  const count = urls.length;

  const goTo = useCallback((next: number, animated = true) => {
    if (count === 0) return;
    const clamped = Math.min(Math.max(next, 0), count - 1);
    setIndex(clamped);
    scrollRef.current?.scrollTo({ x: clamped * width, animated });
  }, [count, width]);

  // Open at the tapped photo once the overlay is measured; on a later resize,
  // stay on the photo being viewed.
  const indexRef = useRef(index);
  indexRef.current = index;
  const openedRef = useRef<PhotoViewerState | null>(null);
  useEffect(() => {
    if (!state || width === 0) return;
    let target = indexRef.current;
    if (openedRef.current !== state) {
      openedRef.current = state;
      target = state.index;
      setIndex(target);
    }
    // Wait a frame so the ScrollView has laid out its pages.
    const id = requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ x: target * width, animated: false });
    });
    return () => cancelAnimationFrame(id);
  }, [state, width]);

  useEffect(() => {
    if (!state || Platform.OS !== 'web' || typeof window === 'undefined') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') goTo(index + 1);
      else if (e.key === 'ArrowLeft') goTo(index - 1);
      else if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state, index, goTo, onClose]);

  const handleSave = async () => {
    const url = urls[index];
    if (!url || saving) return;
    setSaving(true);
    try {
      await saveOrSharePhoto(url);
    } catch (err) {
      console.warn('[PhotoViewer] save/share failed:', err);
      Alert.alert('Could not save photo', 'Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (width > 0) setIndex(Math.round(e.nativeEvent.contentOffset.x / width));
  };

  return (
    <Modal visible={!!state} transparent animationType="fade" onRequestClose={onClose}>
      <View
        style={styles.overlay}
        onLayout={e => setSize({ width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height })}
      >
        {width > 0 && (
          <ScrollView
            ref={scrollRef}
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            // onScroll (not momentum end) so trackpad/scroll-snap paging on web
            // keeps the counter and arrows in sync too.
            onScroll={onScroll}
            scrollEventThrottle={32}
            scrollEnabled={count > 1}
          >
            {urls.map((url, i) => (
              <TouchableOpacity
                key={`${url}-${i}`}
                activeOpacity={1}
                onPress={onClose}
                style={{ width, height }}
                accessibilityLabel="Close photo"
              >
                <Image source={{ uri: url }} style={styles.image} resizeMode="contain" />
              </TouchableOpacity>
            ))}
          </ScrollView>
        )}

        {count > 1 && (
          <View style={styles.counter} pointerEvents="none">
            <Text style={styles.counterText}>{index + 1} of {count}</Text>
          </View>
        )}
        {count > 1 && index > 0 && (
          <TouchableOpacity
            style={[styles.arrow, styles.arrowLeft]}
            onPress={() => goTo(index - 1)}
            accessibilityRole="button"
            accessibilityLabel="Previous photo"
          >
            <AppIcon name="chevron-left" color="white" size={28} />
          </TouchableOpacity>
        )}
        {count > 1 && index < count - 1 && (
          <TouchableOpacity
            style={[styles.arrow, styles.arrowRight]}
            onPress={() => goTo(index + 1)}
            accessibilityRole="button"
            accessibilityLabel="Next photo"
          >
            <AppIcon name="chevron-right" color="white" size={28} />
          </TouchableOpacity>
        )}
        {/^https?:/.test(urls[index] ?? '') && (
          <TouchableOpacity
            style={styles.saveButton}
            onPress={handleSave}
            disabled={saving}
            accessibilityRole="button"
            accessibilityLabel={`${photoActionLabel} photo`}
          >
            {saving
              ? <ActivityIndicator size="small" color="white" />
              : <AppIcon name={photoActionLabel === 'Download' ? 'download' : 'share'} color="white" size={18} />}
            <Text style={styles.saveLabel}>{photoActionLabel}</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity
          style={styles.close}
          onPress={onClose}
          hitSlop={{ top: 10, right: 10, bottom: 10, left: 10 }}
          accessibilityRole="button"
          accessibilityLabel="Close photo viewer"
        >
          <AppIcon name="x" color="white" size={26} />
        </TouchableOpacity>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.92)' },
  image: { width: '100%', height: '100%' },
  counter: {
    position: 'absolute',
    top: 58,
    alignSelf: 'center',
    paddingHorizontal: space[3],
    paddingVertical: space[1],
    borderRadius: radius.pill,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  counterText: { ...type.label, color: 'white' },
  arrow: {
    position: 'absolute',
    top: '50%',
    marginTop: -22,
    width: 44,
    height: 44,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(0,0,0,0.4)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  arrowLeft: { left: space[3] },
  arrowRight: { right: space[3] },
  saveButton: {
    position: 'absolute',
    bottom: 44,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[2],
    minHeight: 44,
    paddingHorizontal: space[4],
    borderRadius: radius.pill,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  saveLabel: { ...type.bodyStrong, color: 'white' },
  close: {
    position: 'absolute',
    top: 52,
    right: 20,
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
