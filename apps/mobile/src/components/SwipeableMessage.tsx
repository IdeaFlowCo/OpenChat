/**
 * Sideways swipes on a chat message (touch layouts).
 *
 *   swipe right  →  Reply, as in iMessage and WhatsApp
 *   swipe left   →  reveals To-do (private) and Save, which then wait for a tap
 *
 * Nothing destructive lives behind a swipe, and every action here is also in
 * the long-press menu, so a reader who never discovers the gesture misses
 * nothing. Vertical scrolling always wins: the row only claims a drag that is
 * clearly horizontal.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AccessibilityInfo, Animated, PanResponder, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';
import { roles, type } from '../theme/tokens';
import { AppIcon } from './AppIcon';
import { SWIPE_ACTION_WIDTH, SWIPE_REPLY_AT, SWIPE_REVEAL, isSidewaysDrag, swipeOffset, swipeOutcome } from '../utils/messageSwipe';

/** Only one row stays open; opening another closes it. */
let closeOpenRow: (() => void) | null = null;

interface Props {
  enabled: boolean;
  onReply?: () => void;
  onSave?: () => void;
  onTodo?: () => void;
  todoLabel?: string;
  children: ReactNode;
}

export function SwipeableMessage({ enabled, onReply, onSave, onTodo, todoLabel = 'To-do', children }: Props) {
  const { scheme } = useTheme();
  const r = roles(getColors(scheme));
  const x = useRef(new Animated.Value(0)).current;
  const [open, setOpen] = useState(false);
  const openRef = useRef(false);
  const reduceMotion = useRef(false);
  const handlers = useRef({ onReply, onSave, onTodo });
  handlers.current = { onReply, onSave, onTodo };

  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled?.().then(value => { if (alive) reduceMotion.current = !!value; }).catch(() => {});
    return () => { alive = false; };
  }, []);

  const settle = (to: number) => {
    const isOpen = to !== 0;
    openRef.current = isOpen;
    setOpen(isOpen);
    if (reduceMotion.current) x.setValue(to);
    else Animated.spring(x, { toValue: to, useNativeDriver: true, bounciness: 0, speed: 20 }).start();
  };
  const close = () => { if (closeOpenRow === close) closeOpenRow = null; settle(0); };
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => () => { if (closeOpenRow === closeRef.current) closeOpenRow = null; }, []);

  const responder = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_event, gesture) => isSidewaysDrag(gesture.dx, gesture.dy),
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: () => { if (closeOpenRow && closeOpenRow !== closeRef.current) closeOpenRow(); },
    onPanResponderMove: (_event, gesture) => {
      const offset = swipeOffset(gesture.dx, openRef.current);
      // Without a reply action there is nothing to the right.
      x.setValue(!handlers.current.onReply && offset > 0 ? 0 : offset);
    },
    onPanResponderRelease: (_event, gesture) => {
      const outcome = swipeOutcome(swipeOffset(gesture.dx, openRef.current));
      if (outcome === 'reply' && handlers.current.onReply) { settle(0); handlers.current.onReply(); return; }
      if (outcome === 'open' && (handlers.current.onSave || handlers.current.onTodo)) { closeOpenRow = closeRef.current; settle(-SWIPE_REVEAL); return; }
      closeRef.current();
    },
    onPanResponderTerminate: () => closeRef.current(),
  }), [x]);

  if (!enabled) return <>{children}</>;

  const act = (run?: () => void) => { close(); run?.(); };
  return (
    <View style={styles.wrap}>
      {/* Revealed by a swipe left. Hidden from assistive tech until open: the long-press menu holds the same actions. */}
      <Animated.View
        style={[styles.actions, { opacity: x.interpolate({ inputRange: [-SWIPE_REVEAL, -12, 0], outputRange: [1, 0, 0], extrapolate: 'clamp' }) }]}
        pointerEvents={open ? 'auto' : 'none'}
        accessibilityElementsHidden={!open}
        importantForAccessibility={open ? 'yes' : 'no-hide-descendants'}
      >
        {onTodo && (
          <TouchableOpacity accessibilityRole="button" accessibilityLabel="Private to-do: readable by you and your agents; saves a message excerpt" onPress={() => act(onTodo)} style={[styles.action, { backgroundColor: r.privateSoft }]}>
            <AppIcon name="todo" color={r.private} size={20} />
            <Text style={[type.caption, { color: r.private }]}>{todoLabel}</Text><Text style={[type.caption, { color: r.private }]}>You + agents</Text>
          </TouchableOpacity>
        )}
        {onSave && (
          <TouchableOpacity accessibilityRole="button" accessibilityLabel="Save to Stream" onPress={() => act(onSave)} style={[styles.action, { backgroundColor: r.pressed }]}>
            <AppIcon name="bookmark" color={r.text} size={20} />
            <Text style={[type.caption, { color: r.text }]}>Save</Text>
          </TouchableOpacity>
        )}
      </Animated.View>
      {onReply && (
        <Animated.View pointerEvents="none" style={[styles.replyHint, { opacity: x.interpolate({ inputRange: [0, SWIPE_REPLY_AT], outputRange: [0, 1], extrapolate: 'clamp' }) }]}>
          <AppIcon name="reply" color={r.textSecondary} size={18} />
        </Animated.View>
      )}
      <Animated.View style={{ transform: [{ translateX: x }] }} {...responder.panHandlers}>
        {children}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'relative' },
  actions: { position: 'absolute', top: 0, bottom: 0, right: 0, width: SWIPE_REVEAL, flexDirection: 'row', alignItems: 'stretch', justifyContent: 'flex-end' },
  action: { width: SWIPE_ACTION_WIDTH, minHeight: 44, alignItems: 'center', justifyContent: 'center', gap: 2 },
  replyHint: { position: 'absolute', left: 6, top: 0, bottom: 0, justifyContent: 'center' },
});
