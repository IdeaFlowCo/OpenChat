/**
 * ThoughtCard — one thought in a feed. Shared by the global ThoughtsScreen
 * and the chat-scoped ConversationThoughtsScreen (OpenChat-zi1 / chat-scoped
 * thoughts + pinning).
 *
 * Shows: text, kind badge (color-coded), status badge, relative time, tag
 * chips, optional provenance line ("from <chat>" / "by <author>"), and an
 * optional pin toggle.
 *
 * Collapse (OpenChat-q60e) is the viewer's saved preference and applies in
 * every Stream view; a collapsed card shows one line. Compact view condenses
 * long entries to their first lines until "Show more".
 */

import React, { useState } from 'react';
import { Modal, Platform, Pressable, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';
import type { Thought } from '../api/client';
import { AppIcon } from './AppIcon';
import { StreamText } from './StreamText';
import { radius, space, type } from '../theme/tokens';
import * as Clipboard from 'expo-clipboard';
import { originalMessageUrl } from '../utils/parseOpenChatUrl';
import { COMPACT_VISIBLE_LINES, isLongStreamText, useStreamCompact, useThoughtCollapsed } from '../services/streamDisplay';

const KIND_LABELS: Record<string, string> = {
  fact:        'Fact',
  decision:    'Decision',
  commitment:  'Commitment',
  reminder:    'Reminder',
  observation: 'Observation',
};

export { formatRelativeTime } from '../utils/relativeTime';
import { formatRelativeTime } from '../utils/relativeTime';

interface ThoughtCardProps {
  item: Thought;
  /** Tap → usually edit. Omit for read-only cards (e.g. others' pinned). */
  onPress?: () => void;
  /** Enables Delete entry in the actions menu, with a separate confirmation. */
  onDelete?: () => void;
  onTagPress?: (tag: string) => void;
  /** Provenance / attribution line rendered under the text, e.g. "from Design chat". */
  subtitle?: string | null;
  /** When set, renders a pin toggle reflecting item.pinned. */
  onTogglePin?: () => void;
  onOpenContext?: () => void;
}

export function ThoughtCard({ item, onPress, onDelete, onTagPress, subtitle, onTogglePin, onOpenContext }: ThoughtCardProps) {
  const { scheme } = useTheme();
  const c = getColors(scheme);

  const kindColor = c.textMetadata;
  const kindLabel = KIND_LABELS[item.kind] ?? item.kind;
  const tags = item.tags ?? [];
  const [actions, setActions] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [collapsed, toggleCollapsedSaved] = useThoughtCollapsed(item.id, item.collapsed);
  const [compact] = useStreamCompact();
  const [revealed, setRevealed] = useState(false);
  const [collapseError, setCollapseError] = useState(false);
  const long = isLongStreamText(item.text);
  const condensed = !collapsed && compact && long && !revealed;
  const toggleCollapsed = () => {
    setCollapseError(false);
    toggleCollapsedSaved().catch(() => setCollapseError(true));
  };
  const openActions = () => { setConfirmDelete(false); setActions(true); };
  const action = (label: string, run: () => void) => <TouchableOpacity onPress={() => { setActions(false); run(); }} accessibilityRole="button" style={{ padding: 14 }}><Text style={{ color: c.primary }}>{label}</Text></TouchableOpacity>;

  return (
    // RN-web's touch responder replaces onContextMenu on TouchableOpacity.
    // Keep right-click on its View parent and long-press on the touchable.
    <View {...(Platform.OS === 'web' ? { onContextMenu: (event: { preventDefault: () => void; stopPropagation: () => void }) => { event.preventDefault(); event.stopPropagation(); openActions(); } } : {})}>
    <TouchableOpacity
      // A collapsed card's tap reveals it; editing starts from the expanded card.
      onPress={collapsed ? toggleCollapsed : onPress}
      accessibilityState={{ expanded: !collapsed }}
      onLongPress={openActions}
      activeOpacity={0.7}
      style={[
        styles.card,
        {
          backgroundColor: c.surface,
          borderColor: c.border,
          borderLeftWidth: item.pinned ? 3 : StyleSheet.hairlineWidth,
          borderLeftColor: item.pinned ? c.primary : c.border,

        },
      ]}
    >
      {/* Body text */}
      {collapsed
        ? <Text style={[styles.bodyText, { color: c.textMetadata }]} numberOfLines={1}>{item.text}</Text>
        // Selection stays a web affordance: on native a selectable body would take the card's tap.
        : <StreamText content={item.text} color={c.textPrimary} linkColor={c.primary} pathBackground={c.surfaceElevated}
            style={styles.bodyText} numberOfLines={condensed ? COMPACT_VISIBLE_LINES : undefined}
            selectable={Platform.OS === 'web'} onLongPress={openActions} />}
      <View style={styles.cardHeader}>
        <Text style={[styles.time, { color: c.textMetadata }]}>
          {formatRelativeTime(item.createdAt)}
        </Text>
        <View style={styles.headerSpacer} />
        {item.pinned && (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[1], marginRight: space[2] }}>
            <AppIcon name="pin" color={c.primary} size={16} strokeWidth={2.4} />
            <Text style={{ ...type.meta, color: c.textMetadata }}>Pinned</Text>
          </View>
        )}
        {item.status !== 'none' && (
          <View
            style={[
              styles.badge,
              { backgroundColor: c.surfaceElevated },
            ]}
          >
            <Text
              style={[
                styles.badgeText,
                { color: c.textMetadata },
              ]}
            >
              {item.status === 'open' ? 'Open' : 'Closed'}
            </Text>
          </View>
        )}
        {item.kind !== 'observation' && (
          <View style={[styles.badge, { backgroundColor: c.surfaceElevated }]}>
            <Text style={[styles.badgeText, { color: kindColor }]}>{kindLabel}</Text>
          </View>
        )}
        {onTogglePin && (
          <TouchableOpacity
            onPress={onTogglePin}
            hitSlop={{ top: 8, right: 8, bottom: 8, left: 8 }}
            accessibilityLabel={item.pinned ? 'Unpin from this chat' : 'Pin to this chat'}
            style={styles.pinBtn}
          >
            <AppIcon
              name="pin"
              color={item.pinned ? c.primary : c.textMuted}
              size={16}
              strokeWidth={item.pinned ? 2.4 : 2}
            />
          </TouchableOpacity>
        )}
        <TouchableOpacity
          onPress={toggleCollapsed}
          hitSlop={{ top: 12, right: 12, bottom: 12, left: 12 }}
          accessibilityRole="button"
          accessibilityLabel={collapsed ? 'Expand entry' : 'Collapse entry'}
          accessibilityState={{ expanded: !collapsed }}
          style={styles.pinBtn}
        >
          <AppIcon name={collapsed ? 'chevron-right' : 'chevron-down'} color={c.textMuted} size={16} strokeWidth={2} />
        </TouchableOpacity>
      </View>

      <Modal visible={actions} transparent animationType="fade" onRequestClose={() => setActions(false)}>
        <Pressable onPress={() => setActions(false)} style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#0006' }}>
          <Pressable onPress={event => event.stopPropagation()} style={{ backgroundColor: c.surface, padding: 12, borderRadius: radius.md, width: 300 }}>
            <Text style={{ color: c.textPrimary, padding: 14, fontWeight: '600' }}>{confirmDelete ? 'Delete Stream entry?' : 'Stream entry actions'}</Text>
            {confirmDelete ? <>
              {onDelete && action('Delete entry', onDelete)}
            </> : <>
              {action(collapsed ? 'Expand entry' : 'Collapse entry', toggleCollapsed)}
              {onPress && action('Edit entry', onPress)}
              {onOpenContext && action('Original message', onOpenContext)}
              {onOpenContext && action('Copy link to original', () => void Clipboard.setStringAsync(originalMessageUrl(item.id)).catch(() => undefined))}
              {onTogglePin && action(item.pinned ? 'Unpin from chat' : 'Pin to chat', onTogglePin)}
              {onDelete && <TouchableOpacity onPress={() => setConfirmDelete(true)} style={{ padding: 14 }}><Text style={{ color: c.danger }}>Delete entry…</Text></TouchableOpacity>}
            </>}
            {action('Cancel', () => undefined)}
          </Pressable>
        </Pressable>
      </Modal>
      {!collapsed && onOpenContext && <TouchableOpacity onPress={onOpenContext} accessibilityRole="button" style={{ paddingVertical: 8 }}><Text style={[type.meta, { color: c.textMetadata }]}>Original message</Text></TouchableOpacity>}
      {collapseError && <Text accessibilityRole="alert" style={[styles.subtitle, { color: c.danger }]}>Could not save. Try again.</Text>}
      {!collapsed && compact && long && (
        <TouchableOpacity onPress={() => setRevealed((r) => !r)} accessibilityRole="button" style={{ paddingVertical: 6 }}>
          <Text style={{ color: c.primary }}>{revealed ? 'Show less' : 'Show more'}</Text>
        </TouchableOpacity>
      )}

      {/* Provenance / attribution */}
      {!collapsed && !!subtitle && (
        <Text style={[styles.subtitle, { color: c.textMetadata }]} numberOfLines={1}>
          {subtitle}
        </Text>
      )}

      {/* Tag chips — visually distinct from the kind badge (pill, monospace #). */}
      {!collapsed && tags.length > 0 && (
        <View style={styles.tagRow}>
          {tags.map((tag) => (
            <TouchableOpacity
              key={tag}
              onPress={onTagPress ? () => onTagPress(tag) : undefined}
              disabled={!onTagPress}
              activeOpacity={0.7}
              style={[styles.chip, { backgroundColor: c.primaryMuted }]}
            >
              <Text style={[styles.chipText, { color: c.primaryActive }]}>
                #{tag.replace(/^#/, '')}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      )}
    </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  // Index card: sharp accent-ruled left edge, soft right corners, faint lift.
  card: {
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    padding: space[3],
    marginBottom: space[2],
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 6,
    marginBottom: 8,
  },
  headerSpacer: { flex: 1 },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radius.md,
  },
  badgeText: {
    fontSize: type.caption.fontSize,
    fontWeight: '700',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  time: {
    fontSize: type.caption.fontSize,
  },
  pinBtn: {
    marginLeft: 2,
  },
  bodyText: {
    fontSize: type.body.fontSize,
    lineHeight: 22,
  },
  subtitle: {
    fontSize: type.meta.fontSize,
    marginTop: 6,
  },
  tagRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 10,
  },
  chip: {
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: radius.pill, // fully rounded pill — distinct from the squared kind badge
  },
  chipText: {
    fontSize: type.meta.fontSize,
    fontWeight: '500',
  },
});
