/**
 * Fullscreen photo viewer (OpenChat-6bg, paging OpenChat-wpmb, save/share
 * OpenChat-5wm2, save all + rotation + zoom OpenChat-zwt4).
 *
 * Shows every photo of one message. Swipe, the thumbnail strip, the arrow
 * buttons or ←/→ move between them; pinch zooms on iOS; the viewer follows
 * the device into landscape. Tapping a photo hides or shows the controls.
 *
 * Sent photos: Rotate (applied to what you save or share), Save, Save all,
 * and Share (phones). Photos still in the composer: Rotate (applied to what
 * gets sent) and Remove.
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
import { AppIcon, type AppIconName } from './AppIcon';
import {
  PhotoSaveError,
  describeSaveResult,
  normalizeRotation,
  photoActionLabel,
  savePhotos,
  sharePhoto,
} from '../services/photoActions';
import { radius, space, type } from '../theme/tokens';

export interface PhotoViewerState {
  urls: string[];
  index: number;
  /** 'composer' = photos not sent yet: rotate applies to the upload. */
  source?: 'message' | 'composer';
  /** Starting clockwise rotation per photo (composer photos keep theirs). */
  rotations?: number[];
}

interface Props {
  state: PhotoViewerState | null;
  onClose: () => void;
  /** Composer only: remember a photo's rotation for sending. */
  onRotate?: (index: number, rotation: number) => void;
  /** Composer only: take a photo out of the message. */
  onRemove?: (index: number) => void;
}

const ALL_ORIENTATIONS = ['portrait', 'portrait-upside-down', 'landscape', 'landscape-left', 'landscape-right'] as const;
const THUMB = 44;
const isRemote = (url: string | undefined) => !!url && /^https?:/.test(url);

type Action = {
  key: string;
  icon: AppIconName;
  label: string;
  a11y: string;
  onPress: () => void;
  busyKey?: 'save' | 'saveAll' | 'share';
};

export function PhotoViewer({ state, onClose, onRotate, onRemove }: Props) {
  // Measured from the overlay so pages track rotation and window resizes.
  const [{ width, height }, setSize] = useState({ width: 0, height: 0 });
  const scrollRef = useRef<ScrollView>(null);
  const [index, setIndex] = useState(0);
  const [rotations, setRotations] = useState<number[]>([]);
  const [busy, setBusy] = useState<'save' | 'saveAll' | 'share' | null>(null);
  const [toast, setToast] = useState('');
  const [chromeHidden, setChromeHidden] = useState(false);
  const urls = state?.urls ?? [];
  const count = urls.length;
  const composer = state?.source === 'composer';

  const goTo = useCallback((next: number, animated = true) => {
    if (count === 0) return;
    const clamped = Math.min(Math.max(next, 0), count - 1);
    setIndex(clamped);
    scrollRef.current?.scrollTo({ x: clamped * width, animated });
  }, [count, width]);

  // Open at the tapped photo once the overlay is measured; on a later resize
  // or device rotation, stay on the photo being viewed.
  const indexRef = useRef(index);
  indexRef.current = index;
  const openedRef = useRef<PhotoViewerState | null>(null);
  useEffect(() => {
    if (!state || width === 0) return;
    let target = indexRef.current;
    if (openedRef.current !== state) {
      openedRef.current = state;
      target = Math.min(state.index, state.urls.length - 1);
      setIndex(target);
      setRotations(state.urls.map((_, i) => normalizeRotation(state.rotations?.[i])));
      setChromeHidden(false);
      setToast('');
    }
    // Wait a frame so the ScrollView has laid out its pages.
    const id = requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ x: target * width, animated: false });
    });
    return () => cancelAnimationFrame(id);
  }, [state, width]);

  // A confirmation fades after a moment.
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(''), 2600);
    return () => clearTimeout(t);
  }, [toast]);

  const rotate = useCallback(() => {
    if (!count) return;
    const next = normalizeRotation((rotations[index] ?? 0) + 90);
    setRotations(prev => prev.map((r, i) => (i === index ? next : r)));
    if (composer) onRotate?.(index, next);
  }, [count, rotations, index, composer, onRotate]);

  const run = async (kind: 'save' | 'saveAll' | 'share') => {
    if (busy || !count) return;
    setBusy(kind);
    try {
      if (kind === 'share') {
        await sharePhoto(urls[index], rotations[index]);
      } else {
        const targets = kind === 'saveAll'
          ? urls.map((url, i) => ({ url, rotation: rotations[i] }))
          : [{ url: urls[index], rotation: rotations[index] }];
        const result = await savePhotos(targets.filter(t => isRemote(t.url)));
        const message = describeSaveResult(result);
        if (message) setToast(message);
      }
    } catch (err) {
      console.warn('[PhotoViewer] save/share failed:', err);
      Alert.alert(
        kind === 'share' ? 'Could not share photo' : 'Could not save',
        err instanceof PhotoSaveError ? err.message : 'Please check your connection and try again.'
      );
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    if (!state || Platform.OS !== 'web' || typeof window === 'undefined') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') goTo(index + 1);
      else if (e.key === 'ArrowLeft') goTo(index - 1);
      else if (e.key === 'Escape') onClose();
      else if (e.key === 'r' || e.key === 'R') rotate();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state, index, goTo, onClose, rotate]);

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (width > 0) setIndex(Math.round(e.nativeEvent.contentOffset.x / width));
  };

  const actions: Action[] = [
    { key: 'rotate', icon: 'rotate', label: 'Rotate', a11y: 'Rotate photo', onPress: rotate },
  ];
  if (composer) {
    if (onRemove) actions.push({ key: 'remove', icon: 'trash', label: 'Remove', a11y: 'Remove photo', onPress: () => onRemove(index) });
  } else if (isRemote(urls[index])) {
    actions.push({ key: 'save', icon: 'download', label: photoActionLabel, a11y: `${photoActionLabel} photo`, onPress: () => { void run('save'); }, busyKey: 'save' });
    if (count > 1) {
      actions.push({
        key: 'saveAll', icon: 'download', label: `${photoActionLabel} all ${count}`,
        a11y: `${photoActionLabel} all ${count} photos`, onPress: () => { void run('saveAll'); }, busyKey: 'saveAll',
      });
    }
    if (Platform.OS !== 'web') {
      actions.push({ key: 'share', icon: 'share', label: 'Share', a11y: 'Share photo', onPress: () => { void run('share'); }, busyKey: 'share' });
    }
  }

  return (
    <Modal
      visible={!!state}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      // iOS modals stay portrait unless told otherwise; follow the device.
      supportedOrientations={[...ALL_ORIENTATIONS]}
    >
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
            {urls.map((url, i) => {
              const turn = normalizeRotation(rotations[i]);
              const sideways = turn === 90 || turn === 270;
              return (
                <ScrollView
                  key={`${url}-${i}-${width}x${height}`}
                  style={{ width, height }}
                  contentContainerStyle={styles.page}
                  // Pinch to zoom (iOS ScrollView zoom; inert elsewhere).
                  maximumZoomScale={4}
                  minimumZoomScale={1}
                  bouncesZoom
                  centerContent
                  showsHorizontalScrollIndicator={false}
                  showsVerticalScrollIndicator={false}
                >
                  <TouchableOpacity
                    activeOpacity={1}
                    onPress={() => setChromeHidden(h => !h)}
                    style={{ width, height, alignItems: 'center', justifyContent: 'center' }}
                    accessibilityLabel={chromeHidden ? 'Show photo controls' : 'Hide photo controls'}
                  >
                    <Image
                      source={{ uri: url }}
                      style={{
                        // Sideways photos swap the box so they still fit the screen.
                        width: sideways ? height : width,
                        height: sideways ? width : height,
                        transform: [{ rotate: `${turn}deg` }],
                      }}
                      resizeMode="contain"
                    />
                  </TouchableOpacity>
                </ScrollView>
              );
            })}
          </ScrollView>
        )}

        {!chromeHidden && (
          <>
            <View style={styles.topBar} pointerEvents="box-none">
              {count > 1 && (
                <View style={styles.counter} pointerEvents="none">
                  <Text style={styles.counterText}>{index + 1} of {count}</Text>
                </View>
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

            <View style={styles.bottom} pointerEvents="box-none">
              {!!toast && (
                <View style={styles.toast} pointerEvents="none" accessibilityLiveRegion="polite">
                  <Text style={styles.toastText}>{toast}</Text>
                </View>
              )}
              {count > 1 && (
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.thumbs}
                  style={styles.thumbsWrap}
                >
                  {urls.map((url, i) => (
                    <TouchableOpacity
                      key={`thumb-${url}-${i}`}
                      onPress={() => goTo(i)}
                      accessibilityRole="button"
                      accessibilityLabel={`Show photo ${i + 1} of ${count}`}
                      style={[styles.thumb, i === index && styles.thumbActive]}
                    >
                      <Image
                        source={{ uri: url }}
                        style={[styles.thumbImage, { transform: [{ rotate: `${normalizeRotation(rotations[i])}deg` }] }]}
                        resizeMode="cover"
                      />
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              )}
              <View style={styles.toolbar}>
                {actions.map(action => (
                  <TouchableOpacity
                    key={action.key}
                    style={styles.action}
                    onPress={action.onPress}
                    disabled={!!busy}
                    accessibilityRole="button"
                    accessibilityLabel={action.a11y}
                  >
                    {busy && busy === action.busyKey
                      ? <ActivityIndicator size="small" color="white" />
                      : <AppIcon name={action.icon} color="white" size={20} />}
                    <Text style={styles.actionLabel} numberOfLines={1}>{action.label}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>
          </>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.95)' },
  page: { flexGrow: 1, alignItems: 'center', justifyContent: 'center' },
  topBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    paddingTop: 52,
    paddingHorizontal: space[4],
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 96,
  },
  counter: {
    paddingHorizontal: space[3],
    paddingVertical: space[1],
    borderRadius: radius.pill,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  counterText: { ...type.label, color: 'white' },
  close: {
    position: 'absolute',
    top: 46,
    right: space[4],
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
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
  bottom: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingBottom: 30,
    alignItems: 'center',
    gap: space[2],
  },
  toast: {
    paddingHorizontal: space[4],
    paddingVertical: space[2],
    borderRadius: radius.pill,
    backgroundColor: 'rgba(255,255,255,0.16)',
  },
  toastText: { ...type.label, color: 'white' },
  thumbsWrap: { maxWidth: '100%', flexGrow: 0 },
  thumbs: { paddingHorizontal: space[3], gap: space[1], alignItems: 'center' },
  thumb: {
    width: THUMB,
    height: THUMB,
    borderRadius: radius.sm,
    overflow: 'hidden',
    opacity: 0.55,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  thumbActive: { opacity: 1, borderColor: 'white' },
  thumbImage: { width: '100%', height: '100%' },
  toolbar: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: space[2],
    paddingHorizontal: space[3],
  },
  action: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[2],
    minHeight: 44,
    paddingHorizontal: space[4],
    borderRadius: radius.pill,
    backgroundColor: 'rgba(255,255,255,0.14)',
  },
  actionLabel: { ...type.bodyStrong, color: 'white' },
});
