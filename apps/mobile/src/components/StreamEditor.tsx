import React, { useEffect, useRef, useState } from 'react';
import { Platform, StyleSheet, TextInput, TouchableOpacity, Text, View } from 'react-native';
import { api, HashtagSuggestion } from '../api/client';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';
import { findActiveHashtag, applyHashtagSuggestion } from '../utils/hashtagAutocomplete';

/** Shared advisory suggestions; every request uses the viewer's current access. */
export function StreamTextInput({ value, onChangeText, conversationId, ...props }: React.ComponentProps<typeof TextInput> & { conversationId?: string }) {
  const { scheme } = useTheme();
  const c = getColors(scheme);
  const [cursor, setCursor] = useState(String(value ?? '').length);
  const [suggestions, setSuggestions] = useState<HashtagSuggestion[]>([]);
  const active = findActiveHashtag(String(value ?? ''), cursor);
  const input = useRef<TextInput>(null);
  const [selection, setSelection] = useState<{ start: number; end: number } | undefined>();
  useEffect(() => {
    let current = true;
    setSuggestions([]);
    if (!active) return;
    const timer = setTimeout(() => {
      api.getHashtagSuggestions(conversationId ?? '', active.query).then(items => {
        if (current) setSuggestions(items);
      }).catch(() => { if (current) setSuggestions([]); });
    }, 180);
    return () => { current = false; clearTimeout(timer); };
  }, [conversationId, active?.query, active?.start]);
  return <View>
    <TextInput {...props} ref={input} value={value} onChangeText={text => { setSelection(undefined); setCursor(text.length); onChangeText?.(text); }}
      selection={selection} onSelectionChange={event => { setCursor(event.nativeEvent.selection.start); props.onSelectionChange?.(event); }} />
    {!!active && suggestions.length > 0 && <View style={styles.tags}>
      {suggestions.map(s => <TouchableOpacity key={s.tag} accessibilityRole="button" accessibilityLabel={`Use hashtag ${s.tag}`}
        {...(Platform.OS === 'web' ? { onMouseDown: (event: { preventDefault: () => void }) => event.preventDefault() } : {})}
        onPress={() => {
          const next = applyHashtagSuggestion(String(value ?? ''), active, s.tag);
          onChangeText?.(next.text); setCursor(next.cursor); setSelection({ start: next.cursor, end: next.cursor }); setSuggestions([]); input.current?.focus();
        }} style={[styles.tag, { backgroundColor: c.primaryMuted }]}>
        <Text style={{ color: c.primary }}>#{s.tag}</Text>
      </TouchableOpacity>)}
    </View>}
  </View>;
}

export function StreamEditor({ value, onChangeText, onSave, conversationId, placeholder = 'Write a Stream entry…' }: {
  value: string; onChangeText: (text: string) => void; onSave: () => void; conversationId?: string; placeholder?: string;
}) {
  const { scheme } = useTheme(); const c = getColors(scheme);
  return <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.border, borderLeftColor: c.primary }]}>
    <StreamTextInput value={value} onChangeText={onChangeText} onBlur={onSave} conversationId={conversationId}
      placeholder={placeholder} placeholderTextColor={c.textMuted} multiline autoFocus style={{ color: c.textPrimary, fontSize: 15, minHeight: 44 }} />
    <TouchableOpacity onPress={onSave} accessibilityRole="button" style={{ paddingTop: 10 }}><Text style={{ color: c.primary }}>Save entry</Text></TouchableOpacity>
  </View>;
}
const styles = StyleSheet.create({ card: { borderWidth: 1, borderLeftWidth: 3, borderRadius: 10, padding: 14, marginBottom: 10 }, tags: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingVertical: 8 }, tag: { padding: 10, borderRadius: 12 } });
