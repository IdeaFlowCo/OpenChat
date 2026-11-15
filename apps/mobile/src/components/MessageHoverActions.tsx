/**
 * The column a chat bubble sits in, plus the quick actions a mouse gets.
 *
 * With a pointer that can hover (desktop web) a small bar appears beside the
 * bubble: React, Reply, Save to Stream, private To-do, and More (the full
 * menu). The same bar appears when the More button takes keyboard focus, and
 * while it shows, R / S / T / E trigger Reply / Save / To-do / React.
 *
 * Touch layouts get none of this: they use swipe, long-press and the small
 * actions button inside the bubble (see SwipeableMessage and ChatScreen).
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Platform, Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';
import { radius, roles, sheetShadow, type } from '../theme/tokens';
import { AppIcon, type AppIconName } from './AppIcon';
import { REACTION_EMOJI } from './ReactionPicker';

/** True on web when the primary pointer can hover (a mouse or trackpad, not a finger). */
export function pointerCanHover(): boolean {
  if (Platform.OS !== 'web') return false;
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      && window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  } catch {
    return false;
  }
}

export interface MessageQuickActions {
  /** Accessible name of the More button; also what voice control says. */
  moreLabel: string;
  myReactions: string[];
  hasTodo: boolean;
  /** `anchor` is where the button was pressed, so the menu can open there. */
  onMore: (anchor?: { x: number; y: number } | null) => void;
  onReact: (emoji: string) => void;
  onReply?: () => void;
  onSave?: () => void;
  onTodo?: () => void;
}

interface Props {
  isOwn: boolean;
  /** Width the row has for this column plus the bar. With room, the bar sits beside the bubble; without, it straddles the bubble's top edge. */
  rowWidth: number;
  /** Cap in px so a line of chat stays readable in a wide pane; 78% of the pane until that is known. */
  maxWidth?: number;
  /** Quick actions, or null for rows that have none (pending or deleted messages). */
  actions: MessageQuickActions | null;
  onContextMenu?: (event: React.MouseEvent) => void;
  children: ReactNode;
}

function BarButton({ icon, label, shortcut, color, onPress }: { icon: AppIconName; label: string; shortcut?: string; color: string; onPress: (anchor: { x: number; y: number } | null) => void }) {
  const { scheme } = useTheme();
  const r = roles(getColors(scheme));
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={event => {
        // A keyboard press has no pointer position (0,0): the menu then opens as a dialog.
        const { pageX, pageY } = event?.nativeEvent ?? {};
        onPress(pageX && pageY ? { x: pageX, y: pageY } : null);
      }}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      // @ts-ignore — title is a web-only DOM attribute; RN-web passes it through.
      title={shortcut ? `${label} (${shortcut})` : label}
      style={[styles.barButton, hovered && { backgroundColor: r.pressed }]}
    >
      <AppIcon name={icon} color={color} size={17} strokeWidth={1.9} />
    </Pressable>
  );
}

export function MessageColumn({ isOwn, rowWidth, actions, maxWidth, onContextMenu, children }: Props) {
  const { scheme } = useTheme();
  const r = roles(getColors(scheme));
  const hover = pointerCanHover();
  const [active, setActive] = useState(false);
  const [picking, setPicking] = useState(false);
  const [width, setWidth] = useState(0);
  const showBar = hover && !!actions;

  // Hover shortcuts: only while this message's bar is showing, and never while typing.
  useEffect(() => {
    if (!active || !actions || typeof document === 'undefined') return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      const key = event.key.toLowerCase();
      if (key === 'r' && actions.onReply) { event.preventDefault(); actions.onReply(); }
      else if (key === 's' && actions.onSave) { event.preventDefault(); actions.onSave(); }
      else if (key === 't' && actions.onTodo) { event.preventDefault(); actions.onTodo(); }
      else if (key === 'e') { event.preventDefault(); setPicking(value => !value); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [active, actions]);

  const webProps = Platform.OS === 'web' ? {
    onContextMenu,
    ...(showBar ? {
      onMouseEnter: () => setActive(true),
      onMouseLeave: () => { setActive(false); setPicking(false); },
      onFocus: () => setActive(true),
      onBlur: (event: React.FocusEvent<HTMLElement>) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) { setActive(false); setPicking(false); }
      },
    } : {}),
  } : {};

  // Beside the bubble when the row has room for it (most messages are short).
  // Otherwise across the bubble's top edge, at the end away from where its text starts.
  const near = isOwn ? 'right' : 'left', far = isOwn ? 'left' : 'right';
  const beside = rowWidth - width >= BAR_WIDTH + 8;
  const position: ViewStyle = beside
    ? { top: 0, [near]: '100%', [isOwn ? 'paddingRight' : 'paddingLeft']: 6 }
    : { top: -(BAR_HEIGHT - 10), [width >= BAR_WIDTH + 12 ? far : near]: 6 };

  return (
    <View
      style={[styles.column, { alignItems: isOwn ? 'flex-end' : 'flex-start' }, maxWidth ? { maxWidth } : null]}
      onLayout={showBar ? event => setWidth(event.nativeEvent.layout.width) : undefined}
      {...webProps}
    >
      {children}
      {showBar && actions && (
        <View style={[styles.barWrap, position, { opacity: active ? 1 : 0 }]} pointerEvents={active ? 'auto' : 'none'}>
          <View style={[styles.bar, sheetShadow, { backgroundColor: r.card, borderColor: r.line }]} accessibilityRole={active ? 'toolbar' : undefined}>
            {!active ? (
              // At rest only More exists: one focusable, voice-reachable button per message, not five.
              <BarButton icon="more" label={actions.moreLabel} color={r.textSecondary} onPress={anchor => actions.onMore(anchor)} />
            ) : picking ? (
              <>
                {REACTION_EMOJI.map(emoji => (
                  <Pressable
                    key={emoji}
                    accessibilityRole="button"
                    accessibilityLabel={`React with ${emoji}`}
                    onPress={() => { setPicking(false); actions.onReact(emoji); }}
                    style={[styles.barButton, actions.myReactions.includes(emoji) && { backgroundColor: r.accentSoft }]}
                  >
                    <Text style={styles.emoji}>{emoji}</Text>
                  </Pressable>
                ))}
                <BarButton icon="x" label="Close reactions" color={r.textSecondary} onPress={() => setPicking(false)} />
              </>
            ) : (
              <>
                <BarButton icon="smile" label="React" shortcut="E" color={r.textSecondary} onPress={() => setPicking(true)} />
                {actions.onReply && <BarButton icon="reply" label="Reply" shortcut="R" color={r.textSecondary} onPress={() => actions.onReply?.()} />}
                {actions.onSave && <BarButton icon="bookmark" label="Save to Stream" shortcut="S" color={r.textSecondary} onPress={() => actions.onSave?.()} />}
                {actions.onTodo && <BarButton icon="todo" label={actions.hasTodo ? 'Open your private to-do' : 'Private to-do: only you see it'} shortcut="T" color={r.private} onPress={() => actions.onTodo?.()} />}
                <BarButton icon="more" label={actions.moreLabel} color={r.textSecondary} onPress={anchor => actions.onMore(anchor)} />
              </>
            )}
          </View>
        </View>
      )}
    </View>
  );
}

/** Five 30px buttons, their gaps, padding and border. */
const BAR_WIDTH = 160;
const BAR_HEIGHT = 36;

const styles = StyleSheet.create({
  column: { flexDirection: 'column', maxWidth: '78%', position: 'relative' },
  barWrap: { position: 'absolute', zIndex: 5 },
  bar: { flexDirection: 'row', alignItems: 'center', padding: 2, gap: 1, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth },
  barButton: { width: 30, height: 30, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center' },
  emoji: { ...type.title, fontWeight: '400' },
});
