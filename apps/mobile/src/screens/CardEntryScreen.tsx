/**
 * CardEntryScreen — shown when an AddMe card (/c/<token>) is scanned or
 * opened in the app, including after sign-in via the entry-intent plumbing.
 * Renders the stranger projection and an explicit friend request action.
 */
import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { useTheme } from '../contexts/ThemeContext';
import { useChat } from '../contexts/ChatContext';
import { useEntryContext } from '../contexts/EntryContext';
import { getColors } from '../theme/colors';
import { api, ApiError, type FriendStatus, type StrangerCard } from '../api/client';
import { AddMeCardView } from '../components/AddMeCardView';
import type { NavProp, RouteProps } from '../navigation/types';

export function CardEntryScreen() {
  const navigation = useNavigation<NavProp<'CardEntry'>>();
  const route = useRoute<RouteProps<'CardEntry'>>();
  const { token } = route.params;
  const { scheme } = useTheme();
  const c = getColors(scheme);
  const { createConversation } = useChat();
  const { clearEntry } = useEntryContext();

  const [card, setCard] = useState<StrangerCard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [isOwnCard, setIsOwnCard] = useState(false);
  const [friend, setFriend] = useState<FriendStatus | null>(null);

  useEffect(() => {
    let active = true;
    api.getPublicCard(token)
      .then(async publicCard => {
        if (active) setCard(publicCard);
        try {
          const status = await api.getCardFriendStatus(token);
          if (active) setFriend(status);
        } catch (err) {
          if (active && err instanceof ApiError && err.status === 400) setIsOwnCard(true);
          else throw err;
        }
      })
      .catch((err) => {
        if (!active) return;
        setError(err instanceof ApiError && err.status === 404
          ? 'This card link has been reset or does not exist.'
          : 'Could not load this card.');
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [token]);

  const handleAdd = async () => {
    setAdding(true);
    setError(null);
    try {
      setFriend(await api.requestCardFriend(token));
    } catch (err) {
      // The server refuses self-adds rather than the client fetching (and so
      // minting) the scanner's own card just to compare tokens.
      if (err instanceof ApiError && err.status === 400) setIsOwnCard(true);
      else setError(err instanceof ApiError && err.status === 404
        ? 'This person is not available.'
        : 'Could not send a friend request. Try again.');
    } finally {
      setAdding(false);
    }
  };

  const handleStatusAction = async () => {
    if (!friend) return;
    setAdding(true);
    setError(null);
    try {
      if (friend.state === 'friends') {
        const conversation = await createConversation([friend.userId], { type: 'direct' });
        await clearEntry();
        navigation.replace('Chat', { conversationId: conversation.id });
      } else {
        setFriend(await api.changeFriend(friend.userId, friend.state === 'incoming' ? 'accept' : 'cancel'));
      }
    } catch {
      setError('Could not update this friend request. Try again.');
    } finally { setAdding(false); }
  };

  const handleClose = async () => {
    await clearEntry();
    if (navigation.canGoBack()) navigation.goBack();
    else navigation.replace('Conversations');
  };

  if (loading) {
    return (
      <View style={[styles.root, { backgroundColor: c.background }]}>
        <ActivityIndicator color={c.primary} size="large" />
      </View>
    );
  }

  return (
    <View style={[styles.root, { backgroundColor: c.background }]}>
      {card ? <AddMeCardView card={card} /> : (
        <Text style={[styles.errorHeading, { color: c.textPrimary }]}>Card unavailable</Text>
      )}

      {error ? <Text style={[styles.error, { color: c.danger }]}>{error}</Text> : null}

      {card && !isOwnCard ? (
        <TouchableOpacity
          style={[styles.primary, { backgroundColor: c.primary, opacity: adding ? 0.6 : 1 }]}
          onPress={friend?.state && friend.state !== 'none' ? handleStatusAction : handleAdd}
          disabled={adding}
          accessibilityRole="button"
        >
          {adding
            ? <ActivityIndicator color={c.onPrimary} size="small" />
            : <Text style={[styles.primaryText, { color: c.onPrimary }]}>{friend?.state === 'incoming' ? 'Accept friend request' : friend?.state === 'outgoing' ? 'Cancel friend request' : friend?.state === 'friends' ? 'Message' : `Add ${card.name} as a friend`}</Text>}
        </TouchableOpacity>
      ) : null}
      {card && isOwnCard ? (
        <Text style={[styles.note, { color: c.textMetadata }]}>This is your card — this is what others see.</Text>
      ) : null}

      <TouchableOpacity style={styles.secondary} onPress={handleClose}>
        <Text style={{ color: c.textSecondary, fontWeight: '600' }}>{card && !isOwnCard ? 'Not now' : 'Close'}</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 },
  primary: { width: '100%', maxWidth: 360, paddingVertical: 15, borderRadius: 12, alignItems: 'center', marginTop: 24 },
  primaryText: { fontSize: 17, fontWeight: '700' },
  secondary: { paddingVertical: 14 },
  error: { fontSize: 15, textAlign: 'center', marginTop: 16 },
  errorHeading: { fontSize: 20, fontWeight: '700' },
  note: { fontSize: 14, textAlign: 'center', marginTop: 20 },
});
