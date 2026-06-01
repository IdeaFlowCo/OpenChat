/**
 * Agent API Keys list screen (OpenChat-7c9).
 * Settings → DEVELOPER → Agent keys
 *
 * Shows all keys for the current user. Each row is tappable → navigates to
 * AgentKeyDetailScreen. Floating "+ New key" button → AddAgentKeyScreen.
 */

import { useCallback, useState } from 'react';
import {
  Alert,
  FlatList,
  Linking,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { useTheme } from '../contexts/ThemeContext';
import { api, AgentKey, OPENCHAT_URL } from '../api/client';
import { getColors } from '../theme/colors';
import type { NavProp } from '../navigation/types';

const GUIDE_URL = `${OPENCHAT_URL}/about/connect-your-bot`;

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function KeyRow({
  item,
  c,
  onTap,
}: {
  item: AgentKey;
  c: ReturnType<typeof getColors>;
  onTap: () => void;
}) {
  const revoked = !!item.revokedAt;
  const prefix = `${item.keyPrefix}…`;

  return (
    <TouchableOpacity
      style={[
        styles.row,
        { backgroundColor: c.surface, borderBottomColor: c.divider, borderBottomWidth: StyleSheet.hairlineWidth },
      ]}
      onPress={onTap}
      activeOpacity={0.7}
    >
      <View style={{ flex: 1 }}>
        <View style={styles.rowHeader}>
          <Text style={[styles.keyName, { color: revoked ? c.textMuted : c.textPrimary }]}>{item.name}</Text>
          {revoked && (
            <View style={[styles.badge, { backgroundColor: c.dangerMuted }]}>
              <Text style={[styles.badgeText, { color: c.danger }]}>Revoked</Text>
            </View>
          )}
        </View>
        <Text style={[styles.keyPrefix, { color: c.textSecondary }]}>{prefix}</Text>
        <Text style={[styles.meta, { color: c.textMuted }]}>
          {item.lastUsedAt ? `Last used ${timeAgo(item.lastUsedAt)}` : 'Never used'}
          {item.expiresAt ? ` · Expires ${timeAgo(item.expiresAt)}` : ''}
          {item.scopes?.length ? ` · ${item.scopes.join(', ')}` : ''}
        </Text>
      </View>
      <Text style={{ color: c.textMuted, fontSize: 18 }}>›</Text>
    </TouchableOpacity>
  );
}

export function AgentKeysScreen() {
  const navigation = useNavigation<NavProp<'AgentKeys'>>();
  const { scheme } = useTheme();
  const c = getColors(scheme);

  const [keys, setKeys] = useState<AgentKey[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.listAgentKeys();
      setKeys(data);
    } catch (err) {
      Alert.alert('Error', err instanceof Error ? err.message : 'Failed to load keys');
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { void load(); }, [load]));

  // Persistent guide banner shown at the top of both the list and the
  // empty state. Tapping it opens the human-readable setup guide in the
  // device browser. Surfaces the agent-integration story even when the
  // user hasn't minted any keys yet.
  const GuideBanner = () => (
    <TouchableOpacity
      style={[styles.guideBanner, { backgroundColor: c.surface, borderColor: c.border }]}
      onPress={() => void Linking.openURL(GUIDE_URL)}
      activeOpacity={0.7}
    >
      <Text style={styles.guideEmoji}>📖</Text>
      <View style={{ flex: 1 }}>
        <Text style={[styles.guideTitle, { color: c.textPrimary }]}>Setup guide</Text>
        <Text style={[styles.guideHint, { color: c.textSecondary }]}>
          Claude Desktop, Cursor, Codex CLI, Claude Code — paste-and-go
        </Text>
      </View>
      <Text style={{ color: c.textMuted, fontSize: 18 }}>↗</Text>
    </TouchableOpacity>
  );

  return (
    <View style={[styles.root, { backgroundColor: c.background }]}>
      {!loading && keys.length === 0 ? (
        <View style={styles.empty}>
          <GuideBanner />
          <View style={{ alignItems: 'center', marginTop: 24 }}>
            <Text style={[styles.emptyTitle, { color: c.textPrimary }]}>No keys yet</Text>
            <Text style={[styles.emptyHint, { color: c.textSecondary }]}>
              Tap + to create one for your bot or script.{'\n'}
              Each key gives an agent bi-directional access to your conversations.
            </Text>
          </View>
        </View>
      ) : (
        <FlatList
          data={keys}
          keyExtractor={(k) => k.id}
          ListHeaderComponent={<GuideBanner />}
          renderItem={({ item }) => (
            <KeyRow
              item={item}
              c={c}
              onTap={() => navigation.navigate('AgentKeyDetail', { keyId: item.id })}
            />
          )}
          contentContainerStyle={{ paddingBottom: 80 }}
        />
      )}

      {/* Floating + button */}
      <TouchableOpacity
        style={[styles.fab, { backgroundColor: c.primary }]}
        onPress={() => navigation.navigate('AddAgentKey')}
        activeOpacity={0.85}
      >
        <Text style={styles.fabText}>+</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14 },
  rowHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 2 },
  keyName: { fontSize: 16, fontWeight: '600' },
  keyPrefix: { fontSize: 13, fontFamily: 'Courier', marginBottom: 2 },
  meta: { fontSize: 12 },
  badge: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6 },
  badgeText: { fontSize: 11, fontWeight: '700' },
  empty: { flex: 1, justifyContent: 'center', paddingHorizontal: 16, paddingVertical: 32 },

  // Persistent setup-guide banner (OpenChat-i9h)
  guideBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 14,
    marginHorizontal: 16,
    marginTop: 14,
    marginBottom: 6,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
  },
  guideEmoji: { fontSize: 22 },
  guideTitle: { fontSize: 15, fontWeight: '600' },
  guideHint: { fontSize: 12, marginTop: 2 },

  emptyTitle: { fontSize: 18, fontWeight: '600', marginBottom: 8 },
  emptyHint: { fontSize: 14, textAlign: 'center' },
  fab: {
    position: 'absolute',
    bottom: 24,
    right: 24,
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 4,
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
  },
  fabText: { color: '#fff', fontSize: 28, fontWeight: '300', lineHeight: 34 },
});
