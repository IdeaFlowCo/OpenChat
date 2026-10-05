/**
 * ThoughtCard — one thought in a feed. Shared by the global ThoughtsScreen
 * and the chat-scoped ConversationThoughtsScreen (OpenChat-zi1 / chat-scoped
 * thoughts + pinning).
 *
 * Shows: text, kind badge (color-coded), status badge, relative time, tag
 * chips, optional provenance line ("from <chat>" / "by <author>"), and an
 * optional pin toggle.
 */

import React, { useState } from 'react';
import { Modal, Platform, Pressable, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';
import type { Thought } from '../api/client';
import { AppIcon } from './AppIcon';

// Ink & Paper: warm, muted kind colors (was stock Tailwind indigo/amber/etc).
const KIND_COLORS: Record<string, string> = {
  fact:        '#6d5f8f', // muted plum
  decision:    '#b3541e', // sienna
  commitment:  '#4a7c59', // moss
  reminder:    '#c07b28', // ochre
  observation: '#8a7f6d', // stone
};

const KIND_LABELS: Record<string, string> = {
  fact:        'Fact',
  decision:    'Decision',
  commitment:  'Commitment',
  reminder:    'Reminder',
  observation: 'Observation',
};

export function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return new Date(iso).toLocaleDateString();
}

interface ThoughtCardProps {
  item: Thought;
  /** Tap → usually edit. Omit for read-only cards (e.g. others' pinned). */
  onPress?: () => void;
  /** Long-press → delete confirm. Omit to disable. */
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

  const kindColor = KIND_COLORS[item.kind] ?? '#8a7f6d';
  const kindLabel = KIND_LABELS[item.kind] ?? item.kind;
  const tags = item.tags ?? [];
  const [actions, setActions] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const openActions = () => { setConfirmDelete(false); setActions(true); };
  const action = (label: string, run: () => void) => <TouchableOpacity onPress={() => { setActions(false); run(); }} accessibilityRole="button" style={{ padding: 14 }}><Text style={{ color: c.primary }}>{label}</Text></TouchableOpacity>;

  return (
    // RN-web's touch responder replaces onContextMenu on TouchableOpacity.
    // Keep right-click on its View parent and long-press on the touchable.
    <View {...(Platform.OS === 'web' ? { onContextMenu: (event: { preventDefault: () => void; stopPropagation: () => void }) => { event.preventDefault(); event.stopPropagation(); openActions(); } } : {})}>
    <TouchableOpacity
      onPress={onPress}
      disabled={!onPress && !onDelete && !onOpenContext && !onTogglePin}
      onLongPress={openActions}
      activeOpacity={0.7}
      style={[
        styles.card,
        {
          backgroundColor: c.surface,
          borderColor: c.border,
          borderLeftColor: item.pinned ? c.primary : kindColor,
        },
      ]}
    >
      {/* Header: time leads; pin + status + kind pill float right. The kind
          pill is hidden for 'observation' (the catch-all default) to keep
          cards quiet — only meaningful types show. */}
      <View style={styles.cardHeader}>
        <Text style={[styles.time, { color: c.textMetadata }]}>
          {formatRelativeTime(item.createdAt)}
        </Text>
        <View style={styles.headerSpacer} />
        {item.status !== 'none' && (
          <View
            style={[
              styles.badge,
              { backgroundColor: item.status === 'open' ? '#4a7c5922' : '#8a7f6d22' },
            ]}
          >
            <Text
              style={[
                styles.badgeText,
                { color: item.status === 'open' ? '#4a7c59' : '#8a7f6d' },
              ]}
            >
              {item.status === 'open' ? 'Open' : 'Closed'}
            </Text>
          </View>
        )}
        {item.kind !== 'observation' && (
          <View style={[styles.badge, { backgroundColor: kindColor + '22' }]}>
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
      </View>

      <Modal visible={actions} transparent animationType="fade" onRequestClose={() => setActions(false)}>
        <Pressable onPress={() => setActions(false)} style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#0006' }}>
          <Pressable onPress={event => event.stopPropagation()} style={{ backgroundColor: c.surface, padding: 12, borderRadius: 12, width: 300 }}>
            <Text style={{ color: c.textPrimary, padding: 14, fontWeight: '600' }}>{confirmDelete ? 'Delete Stream entry?' : 'Stream entry actions'}</Text>
            {confirmDelete ? <>
              {onDelete && action('Delete entry', onDelete)}
            </> : <>
              {onPress && action('Edit entry', onPress)}
              {onOpenContext && action('Original message', onOpenContext)}
              {onTogglePin && action(item.pinned ? 'Unpin from chat' : 'Pin to chat', onTogglePin)}
              {onDelete && <TouchableOpacity onPress={() => setConfirmDelete(true)} style={{ padding: 14 }}><Text style={{ color: c.danger }}>Delete entry…</Text></TouchableOpacity>}
            </>}
            {action('Cancel', () => undefined)}
          </Pressable>
        </Pressable>
      </Modal>
      {onOpenContext && <TouchableOpacity onPress={onOpenContext} accessibilityRole="button" style={{ paddingVertical: 8 }}><Text style={{ color: c.primary }}>Original message</Text></TouchableOpacity>}
      {/* Body text */}
      <Text style={[styles.bodyText, { color: c.textPrimary }]}>{item.text}</Text>

      {/* Provenance / attribution */}
      {!!subtitle && (
        <Text style={[styles.subtitle, { color: c.textMetadata }]} numberOfLines={1}>
          {subtitle}
        </Text>
      )}

      {/* Tag chips — visually distinct from the kind badge (pill, monospace #). */}
      {tags.length > 0 && (
        <View style={styles.tagRow}>
          {tags.map((tag) => (
            <TouchableOpacity
              key={tag}
              onPress={onTagPress ? () => onTagPress(tag) : undefined}
              disabled={!onTagPress}
              activeOpacity={0.7}
              style={[styles.chip, { backgroundColor: c.primaryMuted }]}
            >
              <Text style={[styles.chipText, { color: c.primary }]}>
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
    borderTopLeftRadius: 2,
    borderBottomLeftRadius: 2,
    borderTopRightRadius: 10,
    borderBottomRightRadius: 10,
    borderWidth: 1,
    borderLeftWidth: 3,
    padding: 14,
    marginBottom: 10,
    shadowColor: '#1c1917',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 2,
    elevation: 1,
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
    borderRadius: 10,
  },
  badgeText: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  time: {
    fontSize: 11,
  },
  pinBtn: {
    marginLeft: 2,
  },
  bodyText: {
    fontSize: 15,
    lineHeight: 22,
  },
  subtitle: {
    fontSize: 12,
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
    borderRadius: 999, // fully rounded pill — distinct from the squared kind badge
  },
  chipText: {
    fontSize: 12,
    fontWeight: '500',
  },
});
