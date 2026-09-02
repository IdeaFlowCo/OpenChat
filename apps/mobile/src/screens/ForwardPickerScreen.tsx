/**
 * ForwardPickerScreen — modal conversation picker for message forwarding.
 *
 * Long-press a message → ActionSheet → Forward → this screen.
 * Shows a filtered list of the user's conversations. Tap one to forward
 * the selected message there. (OpenChat-hhc)
 */

import { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { useTheme } from '../contexts/ThemeContext';
import { useChat } from '../contexts/ChatContext';
import { getColors } from '../theme/colors';
import { Avatar } from '../components/Avatar';
import { api, Conversation, CurrentUser } from '../api/client';
import type { NavProp, RouteProps } from '../navigation/types';
import {
  getDirectConversationParticipant,
  getDirectConversationTitle,
} from '../utils/conversationDisplay';

function getDisplayTitle(conv: Conversation, me: CurrentUser | null): string {
  if (conv.title) return conv.title;
  if (conv.type === 'direct') {
    return getDirectConversationTitle(conv, me, 'Unnamed');
  }
  return 'Unnamed';
}

export function ForwardPickerScreen() {
  const navigation = useNavigation<NavProp<'ForwardPicker'>>();
  const route = useRoute<RouteProps<'ForwardPicker'>>();
  const { messageId } = route.params;
  const { scheme } = useTheme();
  const c = getColors(scheme);
  const { conversations, currentUser } = useChat();

  const [query, setQuery] = useState('');
  const [forwarding, setForwarding] = useState(false);

  // Filter conversations by the search query, matching on title or participant names.
  const filtered = useMemo(() => {
    if (!query.trim()) return conversations;
    const lower = query.toLowerCase();
    return conversations.filter(conv => {
      const title = getDisplayTitle(conv, currentUser).toLowerCase();
      if (title.includes(lower)) return true;
      // Also match on participant names/emails for DMs
      return conv.participants?.some(p =>
        (p.user.name || '').toLowerCase().includes(lower) ||
        (p.user.email || '').toLowerCase().includes(lower)
      );
    });
  }, [conversations, query, currentUser]);

  const handleSelect = useCallback(async (conv: Conversation) => {
    if (forwarding) return;
    const title = getDisplayTitle(conv, currentUser);

    Alert.alert(
      `Forward to ${title}?`,
      undefined,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Forward',
          onPress: async () => {
            setForwarding(true);
            try {
              await api.forwardMessage(messageId, conv.id);
              navigation.goBack();
              // Brief toast is handled in ChatScreen after the message:new event.
            } catch (err) {
              console.warn('[ForwardPicker] forward failed:', err);
              Alert.alert('Error', 'Could not forward the message. Please try again.');
            } finally {
              setForwarding(false);
            }
          },
        },
      ]
    );
  }, [forwarding, messageId, navigation, currentUser]);

  const renderItem = useCallback(({ item: conv }: { item: Conversation }) => {
    const title = getDisplayTitle(conv, currentUser);
    const other = conv.type === 'direct'
      ? getDirectConversationParticipant(conv, currentUser)
      : undefined;
    const avatarName = other?.name || other?.email || title;
    const avatarEmail = other?.email;

    return (
      <TouchableOpacity
        style={[styles.row, { borderColor: c.divider }]}
        onPress={() => handleSelect(conv)}
        activeOpacity={0.7}
      >
        <Avatar name={avatarName} email={avatarEmail} size={40} />
        <View style={styles.rowText}>
          <Text style={[styles.title, { color: c.textPrimary }]} numberOfLines={1}>
            {title}
          </Text>
          {conv.lastMessagePreview ? (
            <Text style={[styles.preview, { color: c.textSecondary }]} numberOfLines={1}>
              {conv.lastMessagePreview}
            </Text>
          ) : null}
        </View>
      </TouchableOpacity>
    );
  }, [c, currentUser, handleSelect]);

  return (
    <View style={[styles.root, { backgroundColor: c.background }]}>
      {/* Search bar */}
      <View style={[styles.searchWrap, { backgroundColor: c.surface, borderColor: c.border }]}>
        <TextInput
          style={[styles.searchInput, { color: c.textPrimary }]}
          placeholder="Search conversations…"
          placeholderTextColor={c.textMuted}
          value={query}
          onChangeText={setQuery}
          autoFocus={false}
          clearButtonMode="while-editing"
        />
      </View>

      {forwarding && (
        <View style={styles.loadingWrap}>
          <ActivityIndicator color={c.primary} />
        </View>
      )}

      <FlatList
        data={filtered}
        keyExtractor={conv => conv.id}
        renderItem={renderItem}
        contentContainerStyle={{ paddingVertical: 4 }}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={[styles.emptyText, { color: c.textMuted }]}>
              {query ? 'No conversations match' : 'No conversations yet'}
            </Text>
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  searchWrap: {
    marginHorizontal: 12,
    marginVertical: 10,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  searchInput: {
    fontSize: 16,
  },
  loadingWrap: {
    alignItems: 'center',
    paddingVertical: 8,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowText: {
    flex: 1,
  },
  title: {
    fontSize: 16,
    fontWeight: '500',
  },
  preview: {
    fontSize: 13,
    marginTop: 2,
  },
  empty: {
    paddingTop: 48,
    alignItems: 'center',
  },
  emptyText: {
    fontSize: 15,
  },
});
