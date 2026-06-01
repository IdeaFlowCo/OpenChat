/**
 * Agent API key detail screen (OpenChat-7c9).
 * Navigated to from AgentKeysScreen by tapping a key row.
 *
 * Shows metadata + [View full key] → decrypt & display plaintext.
 * [Copy curl snippet] · [Revoke key]
 */

import { useState, useCallback } from 'react';
import {
  Alert,
  Clipboard,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useNavigation, useRoute, useFocusEffect } from '@react-navigation/native';
import { useTheme } from '../contexts/ThemeContext';
import { api, AgentKey, OPENCHAT_URL } from '../api/client';
import { getColors } from '../theme/colors';
import { McpSetupCard } from '../components/McpSetupCard';
import type { NavProp, RouteProps } from '../navigation/types';

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

export function AgentKeyDetailScreen() {
  const navigation = useNavigation<NavProp<'AgentKeyDetail'>>();
  const route = useRoute<RouteProps<'AgentKeyDetail'>>();
  const { keyId } = route.params;
  const { scheme } = useTheme();
  const c = getColors(scheme);

  const [key, setKey] = useState<AgentKey | null>(null);
  const [plainKey, setPlainKey] = useState<string | null>(null);
  const [revoking, setRevoking] = useState(false);

  const load = useCallback(async () => {
    try {
      const keys = await api.listAgentKeys();
      const found = keys.find((k) => k.id === keyId);
      if (found) setKey(found);
    } catch {
      /* ignore */
    }
  }, [keyId]);

  useFocusEffect(useCallback(() => { void load(); }, [load]));

  const handleReveal = async () => {
    Alert.alert(
      'View full key?',
      'The key will be displayed on screen. Make sure no one is watching.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Show key',
          onPress: async () => {
            try {
              const data = await api.revealAgentKey(keyId);
              setPlainKey(data.key);
            } catch (err) {
              Alert.alert('Error', err instanceof Error ? err.message : 'Failed to reveal key');
            }
          },
        },
      ]
    );
  };

  const handleCopyCurl = () => {
    if (!key) return;
    const bearerToken = plainKey ?? `${key.keyPrefix}…`;
    const snippet = `curl -H "Authorization: Bearer ${bearerToken}" \\\n  ${OPENCHAT_URL}/api/chat/conversations`;
    Clipboard.setString(snippet);
    Alert.alert('Copied', 'curl snippet copied to clipboard.');
  };

  const handleRevoke = () => {
    Alert.alert(
      'Revoke key?',
      `"${key?.name ?? 'This key'}" will be permanently revoked. All requests using it will fail immediately.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Revoke',
          style: 'destructive',
          onPress: async () => {
            setRevoking(true);
            try {
              await api.revokeAgentKey(keyId);
              navigation.goBack();
            } catch (err) {
              Alert.alert('Error', err instanceof Error ? err.message : 'Failed to revoke key');
            } finally {
              setRevoking(false);
            }
          },
        },
      ]
    );
  };

  if (!key) {
    return (
      <View style={[styles.root, { backgroundColor: c.background, alignItems: 'center', justifyContent: 'center' }]}>
        <Text style={{ color: c.textMuted }}>Loading…</Text>
      </View>
    );
  }

  const revoked = !!key.revokedAt;

  return (
    <ScrollView style={[styles.root, { backgroundColor: c.background }]} contentContainerStyle={styles.content}>
      {/* Name + revoked badge */}
      <View style={styles.titleRow}>
        <Text style={[styles.keyName, { color: c.textPrimary }]}>{key.name}</Text>
        {revoked && (
          <View style={[styles.badge, { backgroundColor: c.dangerMuted }]}>
            <Text style={[styles.badgeText, { color: c.danger }]}>Revoked</Text>
          </View>
        )}
      </View>

      {/* Metadata */}
      <View style={[styles.metaCard, { backgroundColor: c.surface, borderColor: c.border }]}>
        <MetaRow label="Prefix" value={`${key.keyPrefix}…`} mono c={c} />
        <MetaRow label="Scopes" value={key.scopes?.join(', ') ?? '—'} c={c} />
        <MetaRow label="Created" value={timeAgo(key.createdAt)} c={c} />
        <MetaRow label="Last used" value={key.lastUsedAt ? timeAgo(key.lastUsedAt) : 'Never'} c={c} />
        {key.expiresAt && <MetaRow label="Expires" value={timeAgo(key.expiresAt)} c={c} />}
        {key.agentName && <MetaRow label="Agent" value={key.agentName} c={c} />}
      </View>

      {/* Revealed key */}
      {plainKey && (
        <View style={[styles.codeBox, { backgroundColor: c.surfaceElevated, borderColor: c.border }]}>
          <Text style={[styles.codeText, { color: c.textPrimary }]} selectable>
            {plainKey}
          </Text>
          <TouchableOpacity
            onPress={() => { Clipboard.setString(plainKey); Alert.alert('Copied', 'Key copied.'); }}
            style={{ marginTop: 8 }}
          >
            <Text style={{ color: c.primary, fontSize: 13, fontWeight: '600' }}>Copy</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Actions */}
      {!revoked && (
        <>
          {!plainKey && (
            <TouchableOpacity
              style={[styles.actionBtn, { backgroundColor: c.surface, borderColor: c.border }]}
              onPress={handleReveal}
              activeOpacity={0.7}
            >
              <Text style={[styles.actionBtnText, { color: c.textPrimary }]}>View full key</Text>
            </TouchableOpacity>
          )}

          <TouchableOpacity
            style={[styles.actionBtn, { backgroundColor: c.surface, borderColor: c.border }]}
            onPress={handleCopyCurl}
            activeOpacity={0.7}
          >
            <Text style={[styles.actionBtnText, { color: c.textPrimary }]}>Copy curl snippet</Text>
          </TouchableOpacity>

          {/* Bi-directional MCP setup snippets. Pre-fills with the real key
              once the user has tapped "View full key", otherwise placeholders. */}
          <McpSetupCard apiKey={plainKey} />

          <TouchableOpacity
            style={[styles.actionBtn, { backgroundColor: c.dangerMuted, borderColor: c.danger }]}
            onPress={handleRevoke}
            disabled={revoking}
            activeOpacity={0.7}
          >
            <Text style={[styles.actionBtnText, { color: c.danger }]}>
              {revoking ? 'Revoking…' : 'Revoke key'}
            </Text>
          </TouchableOpacity>
        </>
      )}
    </ScrollView>
  );
}

function MetaRow({
  label,
  value,
  mono = false,
  c,
}: {
  label: string;
  value: string;
  mono?: boolean;
  c: ReturnType<typeof getColors>;
}) {
  return (
    <View style={[styles.metaRow, { borderBottomColor: c.divider }]}>
      <Text style={[styles.metaLabel, { color: c.textSecondary }]}>{label}</Text>
      <Text style={[styles.metaValue, { color: c.textPrimary, fontFamily: mono ? 'Courier' : undefined }]}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { padding: 20, gap: 12 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 4 },
  keyName: { fontSize: 20, fontWeight: '700', flex: 1 },
  badge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  badgeText: { fontSize: 11, fontWeight: '700' },
  metaCard: {
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  metaRow: {
    flexDirection: 'row',
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    gap: 12,
  },
  metaLabel: { fontSize: 13, width: 80 },
  metaValue: { fontSize: 14, flex: 1 },
  codeBox: {
    padding: 14,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
  },
  codeText: { fontSize: 13, fontFamily: 'Courier' },
  actionBtn: {
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
  },
  actionBtnText: { fontSize: 16, fontWeight: '600' },
});
