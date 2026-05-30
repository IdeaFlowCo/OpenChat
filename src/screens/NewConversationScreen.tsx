/**
 * Compose / new-conversation flow.
 *
 * Single screen with two modes (toggle): "Direct" (pick one contact, start
 * DM) and "Group" (pick 2+ contacts, optional title, create). Mirrors the
 * web ChatSidebar picker but adapted to a full-screen mobile presentation.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  useColorScheme,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { api, User } from '../api/client';
import { useChat } from '../contexts/ChatContext';
import { getColors } from '../theme/colors';
import { Avatar } from '../components/Avatar';
import { BotBadge } from '../components/BotBadge';
import type { NavProp } from '../navigation/types';

type Mode = 'direct' | 'group';

function useDebounced<T>(value: T, delay = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return v;
}

export function NewConversationScreen() {
  const navigation = useNavigation<NavProp<'NewConversation'>>();
  const scheme = useColorScheme() || 'light';
  const c = getColors(scheme);
  const { createConversation, currentUser, presence } = useChat();

  const [mode, setMode] = useState<Mode>('direct');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<User[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<User[]>([]);
  const [groupTitle, setGroupTitle] = useState('');
  const [creating, setCreating] = useState(false);

  const debounced = useDebounced(query, 300);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.getContacts(debounced || undefined)
      .then(rows => {
        if (!cancelled) setResults(rows.filter(u => u.id !== currentUser?.userId));
      })
      .catch(err => {
        console.warn('[NewConversation] search failed:', err);
        if (!cancelled) setResults([]);
      })
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [debounced, currentUser?.userId]);

  const isSelected = (id: string) => selected.some(u => u.id === id);

  const handleSelect = async (user: User) => {
    if (mode === 'direct') {
      if (creating) return;
      setCreating(true);
      try {
        const conv = await createConversation([user.id], { type: 'direct' });
        navigation.replace('Chat', { conversationId: conv.id });
      } catch (err) {
        Alert.alert('Could not start chat', err instanceof Error ? err.message : String(err));
      } finally {
        setCreating(false);
      }
    } else {
      // group: toggle selection
      setSelected(prev => isSelected(user.id) ? prev.filter(u => u.id !== user.id) : [...prev, user]);
    }
  };

  const handleCreateGroup = async () => {
    if (selected.length < 2 || creating) return;
    setCreating(true);
    try {
      const conv = await createConversation(
        selected.map(u => u.id),
        { type: 'group', title: groupTitle.trim() || undefined }
      );
      navigation.replace('Chat', { conversationId: conv.id });
    } catch (err) {
      Alert.alert('Could not create group', err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  };

  const headerInstructions = useMemo(() => {
    if (mode === 'direct') return 'Pick someone to start chatting';
    if (selected.length === 0) return 'Pick people to start a group';
    if (selected.length === 1) return 'Pick one more — groups need at least 2 others';
    return `${selected.length} selected — tap Create when ready`;
  }, [mode, selected.length]);

  return (
    <View style={[styles.root, { backgroundColor: c.background }]}>
      {/* Mode toggle */}
      <View style={styles.modeRow}>
        {(['direct', 'group'] as Mode[]).map(m => {
          const active = mode === m;
          return (
            <TouchableOpacity
              key={m}
              style={[
                styles.modeBtn,
                {
                  backgroundColor: active ? c.primary : c.surfaceElevated,
                  borderColor: active ? c.primary : c.border,
                },
              ]}
              onPress={() => { setMode(m); setSelected([]); setGroupTitle(''); }}
            >
              <Text style={{ color: active ? '#fff' : c.textPrimary, fontWeight: '600' }}>
                {m === 'direct' ? 'Direct Message' : 'Group'}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      <Text style={[styles.subtitle, { color: c.textSecondary }]}>{headerInstructions}</Text>

      <TextInput
        style={[styles.search, { backgroundColor: c.surfaceElevated, color: c.textPrimary, borderColor: c.border }]}
        value={query}
        onChangeText={setQuery}
        placeholder="Search by name or email"
        placeholderTextColor={c.textMuted}
        autoCapitalize="none"
        autoCorrect={false}
      />

      {mode === 'group' && (
        <View style={styles.groupTitleWrap}>
          <TextInput
            style={[styles.search, { backgroundColor: c.surfaceElevated, color: c.textPrimary, borderColor: c.border }]}
            value={groupTitle}
            onChangeText={setGroupTitle}
            placeholder="Group name (optional)"
            placeholderTextColor={c.textMuted}
          />
        </View>
      )}

      {mode === 'group' && selected.length > 0 && (
        <View style={styles.pillsRow}>
          {selected.map(u => (
            <TouchableOpacity
              key={u.id}
              style={[styles.pill, { backgroundColor: c.primaryMuted, borderColor: c.primary }]}
              onPress={() => setSelected(prev => prev.filter(x => x.id !== u.id))}
              accessibilityLabel={`Remove ${u.name || u.email}`}
            >
              <Text style={{ color: c.primary, fontSize: 12, fontWeight: '600' }}>
                {u.name || u.email}  ✕
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      )}

      {loading && results.length === 0 ? (
        <View style={styles.center}>
          <ActivityIndicator color={c.primary} />
        </View>
      ) : (
        <FlatList
          data={results}
          keyExtractor={u => u.id}
          ListEmptyComponent={
            <View style={styles.center}>
              <Text style={{ color: c.textSecondary, marginTop: 24 }}>
                {query ? `No contacts found for "${query}"` : 'No contacts yet'}
              </Text>
            </View>
          }
          renderItem={({ item }) => {
            const checked = isSelected(item.id);
            const live = presence.get(item.id);
            return (
              <TouchableOpacity
                style={[styles.row, { borderColor: c.divider, backgroundColor: checked ? c.primaryMuted : 'transparent' }]}
                onPress={() => handleSelect(item)}
                activeOpacity={0.7}
              >
                <Avatar
                  name={item.name}
                  email={item.email}
                  isBot={item.isBot}
                  presenceStatus={live?.status || item.presenceStatus}
                  size={40}
                />
                <View style={{ flex: 1 }}>
                  <View style={styles.rowTop}>
                    <Text style={[styles.name, { color: c.textPrimary }]} numberOfLines={1}>
                      {item.name || item.email}
                    </Text>
                    <BotBadge isBot={item.isBot} compact />
                  </View>
                  <Text style={[styles.email, { color: c.textSecondary }]} numberOfLines={1}>
                    {item.email}
                  </Text>
                </View>
                {mode === 'group' && (
                  <View style={[styles.check, {
                    borderColor: checked ? c.primary : c.border,
                    backgroundColor: checked ? c.primary : 'transparent',
                  }]}>
                    {checked && <Text style={{ color: '#fff', fontWeight: '700' }}>✓</Text>}
                  </View>
                )}
              </TouchableOpacity>
            );
          }}
        />
      )}

      {mode === 'group' && (
        <View style={[styles.footer, { backgroundColor: c.surface, borderColor: c.border }]}>
          <TouchableOpacity
            style={[
              styles.createBtn,
              {
                backgroundColor: selected.length >= 2 ? c.primary : c.surfaceElevated,
                opacity: creating ? 0.6 : 1,
              },
            ]}
            onPress={handleCreateGroup}
            disabled={selected.length < 2 || creating}
          >
            <Text style={{
              color: selected.length >= 2 ? '#fff' : c.textMuted,
              fontWeight: '600',
              fontSize: 16,
            }}>
              {creating ? 'Creating…' : selected.length < 2
                ? `Pick ${2 - selected.length} more`
                : `Create group (${selected.length})`}
            </Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, paddingHorizontal: 16, paddingTop: 12 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 32 },
  modeRow: { flexDirection: 'row', gap: 8 },
  modeBtn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 10,
    alignItems: 'center',
    borderWidth: StyleSheet.hairlineWidth,
  },
  subtitle: { fontSize: 13, marginTop: 12 },
  search: {
    marginTop: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    fontSize: 16,
  },
  groupTitleWrap: { marginTop: 4 },
  pillsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 },
  pill: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 12,
    marginHorizontal: -16,
    paddingLeft: 16,
    paddingRight: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 12,
  },
  rowTop: { flexDirection: 'row', alignItems: 'center' },
  name: { fontSize: 16, fontWeight: '600' },
  email: { fontSize: 13, marginTop: 2 },
  check: {
    width: 24, height: 24, borderRadius: 12,
    borderWidth: 2, alignItems: 'center', justifyContent: 'center',
  },
  footer: {
    marginHorizontal: -16,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 24,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  createBtn: {
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
  },
});
