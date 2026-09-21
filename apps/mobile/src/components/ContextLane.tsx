import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, FlatList, ActivityIndicator, TouchableOpacity, Alert } from 'react-native';
import { useTheme } from '../contexts/ThemeContext';
import { contextLaneManager } from '../services/contextLane';
import { ContextPost } from '../api/client';
import { useChat } from '../contexts/ChatContext';
import { getColors } from '../theme/colors';

export function ContextLane({ conversationId }: { conversationId: string }) {
  const { scheme } = useTheme();
  const c = getColors(scheme);
  const { currentUser } = useChat();
  const [state, setState] = useState(() => contextLaneManager.getState(conversationId));

  useEffect(() => {
    const unsub = contextLaneManager.subscribe(conversationId, setState);
    contextLaneManager.loadInitial(conversationId);
    return unsub;
  }, [conversationId]);

  const renderItem = ({ item }: { item: ContextPost }) => {
    return (
      <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }]}>
        <Text style={{ color: c.textMuted, fontSize: 12, marginBottom: 4 }}>
          {new Date(item.createdAt).toLocaleString()}
        </Text>
        <Text style={{ color: c.textPrimary, fontSize: 15 }}>{item.text}</Text>
        {item.authorId === currentUser?.userId && (
          <TouchableOpacity onPress={() => contextLaneManager.deletePost(conversationId, item.id)}>
            <Text style={{ color: c.danger, marginTop: 8, fontSize: 13 }}>Delete</Text>
          </TouchableOpacity>
        )}
      </View>
    );
  };

  return (
    <View style={styles.container}>
      {state.isLoading && state.posts.length === 0 ? (
        <ActivityIndicator style={{ marginTop: 24 }} color={c.primary} />
      ) : state.isError ? (
        <Text style={{ color: c.danger, margin: 16, textAlign: 'center' }}>Failed to load context.</Text>
      ) : (
        <FlatList
          data={state.posts}
          keyExtractor={(p) => p.id}
          renderItem={renderItem}
          contentContainerStyle={{ padding: 16, paddingBottom: 100 }}
          onEndReached={() => contextLaneManager.loadMore(conversationId)}
          onEndReachedThreshold={0.5}
          ListEmptyComponent={
            <Text style={{ color: c.textMuted, textAlign: 'center', marginTop: 32 }}>
              No context posts yet.
            </Text>
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  card: {
    padding: 12,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: 12,
  },
});
