/** Compact, touch-first hashtag suggestions shown above the composer. */

import React, { useEffect, useRef } from 'react';
import {
  FlatList,
  ListRenderItemInfo,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { getColors } from '../theme/colors';
import type { Scheme } from '../utils/colorForUserId';
import type { HashtagSuggestion } from '../services/hashtagSuggestions';

interface Props {
  suggestions: HashtagSuggestion[];
  selectedIndex: number;
  onSelect: (suggestion: HashtagSuggestion) => void;
  scheme: Scheme;
}

function sourceLabel(source: HashtagSuggestion['source']): string {
  if (source === 'both') return 'Mine + this chat';
  if (source === 'mine') return 'My tag';
  return 'This chat';
}

export function HashtagAutocomplete({ suggestions, selectedIndex, onSelect, scheme }: Props) {
  const c = getColors(scheme);
  const listRef = useRef<FlatList<HashtagSuggestion>>(null);

  useEffect(() => {
    if (suggestions.length > 0 && selectedIndex >= 0) {
      listRef.current?.scrollToIndex({ index: selectedIndex, animated: true, viewPosition: 0.5 });
    }
  }, [selectedIndex, suggestions.length]);

  if (suggestions.length === 0) return null;

  const renderItem = ({ item, index }: ListRenderItemInfo<HashtagSuggestion>) => {
    const selected = index === selectedIndex;
    return (
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel={`Use hashtag ${item.tag}, ${sourceLabel(item.source)}`}
        accessibilityState={{ selected }}
        activeOpacity={0.72}
        onPress={() => onSelect(item)}
        style={[
          styles.chip,
          {
            backgroundColor: selected ? c.primaryMuted : c.surfaceElevated,
            borderColor: selected ? c.primary : c.border,
          },
        ]}
      >
        <Text style={[styles.tag, { color: selected ? c.primary : c.textPrimary }]} numberOfLines={1}>
          #{item.tag}
        </Text>
        <Text style={[styles.source, { color: c.textMuted }]} numberOfLines={1}>
          {sourceLabel(item.source)}
        </Text>
      </TouchableOpacity>
    );
  };

  return (
    <View
      accessibilityRole="toolbar"
      accessibilityLabel="Hashtag suggestions"
      style={[styles.container, { backgroundColor: c.surface, borderColor: c.border }]}
    >
      <FlatList
        ref={listRef}
        horizontal
        data={suggestions}
        keyExtractor={(item) => item.tag}
        keyboardShouldPersistTaps="always"
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.content}
        renderItem={renderItem}
        onScrollToIndexFailed={() => undefined}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderTopWidth: StyleSheet.hairlineWidth,
    minHeight: 64,
  },
  content: {
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 8,
  },
  chip: {
    minHeight: 48,
    minWidth: 96,
    maxWidth: 180,
    justifyContent: 'center',
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 12,
    borderWidth: 1,
  },
  tag: {
    fontSize: 15,
    fontWeight: '700',
  },
  source: {
    fontSize: 10.5,
    fontWeight: '600',
    marginTop: 2,
    letterSpacing: 0.15,
  },
});
