/**
 * Thoughts list screen — shows the user's personal notes feed. (OpenChat-zi1)
 *
 * Each card shows: text, kind badge (color-coded), status badge, relative time,
 * and edit/delete actions.
 *
 * - Tap a card → edit modal
 * - Long-press a card → delete confirmation
 * - FAB (+) → add modal
 * - Pull-to-refresh
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useFocusEffect } from '@react-navigation/native';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';
import { fetchThoughts, deleteThought, Thought } from '../services/thoughts';
import type { ThoughtsNavProp } from '../navigation/types';

// ── Badge colors ──────────────────────────────────────────────────────────────

const KIND_COLORS: Record<string, string> = {
  fact:        '#6366f1', // indigo
  decision:    '#f59e0b', // amber
  commitment:  '#10b981', // emerald
  reminder:    '#f97316', // orange
  observation: '#3b82f6', // blue
};

const KIND_LABELS: Record<string, string> = {
  fact:        'Fact',
  decision:    'Decision',
  commitment:  'Commitment',
  reminder:    'Reminder',
  observation: 'Observation',
};

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return new Date(iso).toLocaleDateString();
}

// ── ThoughtCard ───────────────────────────────────────────────────────────────

interface ThoughtCardProps {
  item: Thought;
  onEdit: () => void;
  onDelete: () => void;
  surface: string;
  border: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
}

function ThoughtCard({
  item,
  onEdit,
  onDelete,
  surface,
  border,
  textPrimary,
  textSecondary,
  textMuted,
}: ThoughtCardProps) {
  const kindColor = KIND_COLORS[item.kind] ?? '#3b82f6';
  const kindLabel = KIND_LABELS[item.kind] ?? item.kind;

  return (
    <TouchableOpacity
      onPress={onEdit}
      onLongPress={() =>
        Alert.alert('Delete thought?', item.text.slice(0, 80), [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Delete', style: 'destructive', onPress: onDelete },
        ])
      }
      activeOpacity={0.7}
      style={[styles.card, { backgroundColor: surface, borderColor: border }]}
    >
      {/* Header: badges + time */}
      <View style={styles.cardHeader}>
        <View style={[styles.badge, { backgroundColor: kindColor + '22' }]}>
          <Text style={[styles.badgeText, { color: kindColor }]}>{kindLabel}</Text>
        </View>
        {item.status !== 'none' && (
          <View
            style={[
              styles.badge,
              { backgroundColor: item.status === 'open' ? '#3b82f622' : '#6b728022' },
            ]}
          >
            <Text
              style={[
                styles.badgeText,
                { color: item.status === 'open' ? '#3b82f6' : '#6b7280' },
              ]}
            >
              {item.status === 'open' ? 'Open' : 'Closed'}
            </Text>
          </View>
        )}
        <Text style={[styles.time, { color: textMuted }]}>
          {formatRelativeTime(item.createdAt)}
        </Text>
      </View>

      {/* Body text */}
      <Text style={[styles.bodyText, { color: textPrimary }]}>{item.text}</Text>
    </TouchableOpacity>
  );
}

// ── ThoughtsScreen ────────────────────────────────────────────────────────────

export function ThoughtsScreen() {
  const navigation = useNavigation<ThoughtsNavProp<'ThoughtsList'>>();
  const { scheme } = useTheme();
  const c = getColors(scheme);

  const [thoughts, setThoughts] = useState<Thought[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const data = await fetchThoughts({ limit: 50 });
      if (mountedRef.current) setThoughts(data);
    } catch (e) {
      if (mountedRef.current) setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      if (mountedRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  // Reload whenever the screen comes into focus (e.g., returning from add/edit).
  useFocusEffect(useCallback(() => { load(false); }, [load]));

  const handleDelete = useCallback(async (id: string) => {
    try {
      await deleteThought(id);
      if (mountedRef.current) {
        setThoughts((prev) => prev.filter((t) => t.id !== id));
      }
    } catch (e) {
      Alert.alert('Error', e instanceof Error ? e.message : 'Failed to delete');
    }
  }, []);

  const openAdd = useCallback(() => {
    navigation.navigate('AddEditThought', undefined);
  }, [navigation]);

  const openEdit = useCallback(
    (thought: Thought) => {
      navigation.navigate('AddEditThought', { thought });
    },
    [navigation]
  );

  // Empty state
  const renderEmpty = () => {
    if (loading) return null;
    return (
      <View style={styles.emptyContainer}>
        <Text style={[styles.emptyText, { color: c.textMuted }]}>
          No thoughts yet. Tap + to add one.
        </Text>
      </View>
    );
  };

  if (error && thoughts.length === 0) {
    return (
      <View style={[styles.centered, { backgroundColor: c.background }]}>
        <Text style={[styles.errorText, { color: c.danger }]}>{error}</Text>
        <TouchableOpacity onPress={() => load(false)} style={styles.retryButton}>
          <Text style={{ color: c.primary }}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={[styles.root, { backgroundColor: c.background }]}>
      <FlatList
        data={thoughts}
        keyExtractor={(t) => t.id}
        contentContainerStyle={styles.list}
        renderItem={({ item }) => (
          <ThoughtCard
            item={item}
            onEdit={() => openEdit(item)}
            onDelete={() => handleDelete(item.id)}
            surface={c.surface}
            border={c.border}
            textPrimary={c.textPrimary}
            textSecondary={c.textSecondary}
            textMuted={c.textMuted}
          />
        )}
        ListEmptyComponent={renderEmpty}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => load(true)}
            tintColor={c.primary}
          />
        }
      />

      {/* FAB */}
      <TouchableOpacity
        style={[styles.fab, { backgroundColor: c.primary }]}
        onPress={openAdd}
        activeOpacity={0.8}
      >
        <Text style={styles.fabIcon}>+</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  list: { padding: 12, paddingBottom: 88 },
  card: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 14,
    marginBottom: 10,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 6,
    marginBottom: 8,
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
  },
  badgeText: {
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.2,
  },
  time: {
    fontSize: 11,
    marginLeft: 'auto',
  },
  bodyText: {
    fontSize: 15,
    lineHeight: 22,
  },
  emptyContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 80,
  },
  emptyText: {
    fontSize: 15,
    textAlign: 'center',
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  errorText: {
    fontSize: 14,
    marginBottom: 12,
    textAlign: 'center',
    paddingHorizontal: 24,
  },
  retryButton: { padding: 8 },
  fab: {
    position: 'absolute',
    bottom: 24,
    right: 20,
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 4,
  },
  fabIcon: {
    color: '#fff',
    fontSize: 28,
    lineHeight: 32,
    fontWeight: '300',
  },
});
