/**
 * ThoughtCard — one thought in a feed. Shared by the global ThoughtsScreen
 * and the chat-scoped ConversationThoughtsScreen (OpenChat-zi1 / chat-scoped
 * thoughts + pinning).
 *
 * Shows: text, kind badge (color-coded), status badge, relative time, tag
 * chips, optional provenance line ("from <chat>" / "by <author>"), and an
 * optional pin toggle.
 */

import { Alert, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
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
}

export function ThoughtCard({ item, onPress, onDelete, onTagPress, subtitle, onTogglePin }: ThoughtCardProps) {
  const { scheme } = useTheme();
  const c = getColors(scheme);

  const kindColor = KIND_COLORS[item.kind] ?? '#8a7f6d';
  const kindLabel = KIND_LABELS[item.kind] ?? item.kind;
  const tags = item.tags ?? [];

  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={!onPress && !onDelete}
      onLongPress={
        onDelete
          ? () =>
              Alert.alert('Delete thought?', item.text.slice(0, 80), [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Delete', style: 'destructive', onPress: onDelete },
              ])
          : undefined
      }
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
        <Text style={[styles.time, { color: c.textMuted }]}>
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

      {/* Body text */}
      <Text style={[styles.bodyText, { color: c.textPrimary }]}>{item.text}</Text>

      {/* Provenance / attribution */}
      {!!subtitle && (
        <Text style={[styles.subtitle, { color: c.textMuted }]} numberOfLines={1}>
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
