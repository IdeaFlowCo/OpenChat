/**
 * BlockedUsersScreen — lists blocked users and allows unblocking each one.
 * Navigated to from Settings → "Blocked users" row (OpenChat-46p).
 *
 * GET /api/chat/blocks  → array of blocked User objects
 * DELETE /api/chat/users/:id/block  → unblocks
 */

import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';
import { api, User } from '../api/client';
import { Avatar } from '../components/Avatar';

export function BlockedUsersScreen() {
  const { scheme } = useTheme();
  const c = getColors(scheme);

  const [blocked, setBlocked] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [unblocking, setUnblocking] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const users = await api.listBlocked();
      setBlocked(users);
    } catch (err) {
      console.warn('[BlockedUsersScreen] load failed:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const handleUnblock = useCallback((user: User) => {
    const name = user.name || user.email;
    Alert.alert(
      `Unblock ${name}?`,
      `They will be able to send you messages again.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Unblock',
          onPress: async () => {
            setUnblocking(user.id);
            try {
              await api.unblockUser(user.id);
              setBlocked(prev => prev.filter(u => u.id !== user.id));
            } catch (err) {
              console.warn('[BlockedUsersScreen] unblock failed:', err);
              Alert.alert('Error', 'Could not unblock user. Please try again.');
            } finally {
              setUnblocking(null);
            }
          },
        },
      ]
    );
  }, []);

  if (loading) {
    return (
      <View style={[styles.center, { backgroundColor: c.background }]}>
        <ActivityIndicator color={c.primary} />
      </View>
    );
  }

  return (
    <View style={[styles.root, { backgroundColor: c.background }]}>
      {blocked.length === 0 ? (
        <View style={styles.center}>
          <Text style={{ color: c.textMuted, fontSize: 15 }}>No blocked users</Text>
        </View>
      ) : (
        <FlatList
          data={blocked}
          keyExtractor={u => u.id}
          contentContainerStyle={{ padding: 16, gap: 8 }}
          renderItem={({ item }) => (
            <View
              style={[
                styles.row,
                { backgroundColor: c.surface, borderColor: c.border },
              ]}
            >
              <Avatar name={item.name || item.email} email={item.email} size={38} />
              <View style={{ flex: 1, marginLeft: 12 }}>
                <Text style={[styles.name, { color: c.textPrimary }]} numberOfLines={1}>
                  {item.name || item.email}
                </Text>
                {item.name && (
                  <Text style={[styles.email, { color: c.textSecondary }]} numberOfLines={1}>
                    {item.email}
                  </Text>
                )}
              </View>
              <TouchableOpacity
                style={[styles.unblockBtn, { borderColor: c.primary }]}
                onPress={() => handleUnblock(item)}
                disabled={unblocking === item.id}
                activeOpacity={0.7}
              >
                {unblocking === item.id ? (
                  <ActivityIndicator size="small" color={c.primary} />
                ) : (
                  <Text style={{ color: c.primary, fontWeight: '600', fontSize: 14 }}>Unblock</Text>
                )}
              </TouchableOpacity>
            </View>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
  },
  name: { fontSize: 15, fontWeight: '500' },
  email: { fontSize: 12, marginTop: 2 },
  unblockBtn: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 8,
    borderWidth: 1,
    minWidth: 72,
    alignItems: 'center',
  },
});
