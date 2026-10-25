/**
 * QuickEmojiPicker (OpenChat-3aiu) — choose the chat's emoji send button.
 * A grid of suggestions plus a field for any other emoji; "Use default"
 * clears the choice. The pick is shared with everyone in the chat.
 */

import { useEffect, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';
import { radius, type } from '../theme/tokens';
import { DEFAULT_QUICK_EMOJI, QUICK_EMOJI_CHOICES, isSingleEmoji } from '../utils/emojiMessage';

interface Props {
  visible: boolean;
  current: string;
  onPick: (emoji: string | null) => void;
  onClose: () => void;
}

export function QuickEmojiPicker({ visible, current, onPick, onClose }: Props) {
  const { scheme } = useTheme();
  const c = getColors(scheme);
  const [custom, setCustom] = useState('');
  useEffect(() => { if (!visible) setCustom(''); }, [visible]);
  const customTrimmed = custom.trim();
  const customValid = isSingleEmoji(customTrimmed);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close chat emoji picker">
        <Pressable onPress={() => { /* keep taps inside the sheet */ }} style={[styles.sheet, { backgroundColor: c.surface, borderColor: c.border }]}>
          <Text style={[styles.title, { color: c.textPrimary }]}>Chat emoji</Text>
          <Text style={[styles.hint, { color: c.textMetadata }]}>
            Sits where Send is when you have nothing typed. Tap it to send; hold it to send it bigger. Everyone in this chat sees the same emoji.
          </Text>
          <View style={styles.grid} accessibilityRole="radiogroup">
            {QUICK_EMOJI_CHOICES.map(emoji => {
              const active = emoji === current;
              return (
                <TouchableOpacity
                  key={emoji}
                  onPress={() => onPick(emoji)}
                  style={[styles.cell, active && { backgroundColor: c.primaryMuted }]}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: active }}
                  accessibilityLabel={`Use ${emoji}`}
                >
                  <Text style={styles.cellEmoji}>{emoji}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
          <View style={styles.customRow}>
            <TextInput
              value={custom}
              onChangeText={setCustom}
              placeholder="Any other emoji"
              placeholderTextColor={c.textMuted}
              style={[styles.customInput, { color: c.textPrimary, borderColor: c.border }]}
              accessibilityLabel="Type another emoji"
              autoCorrect={false}
              maxLength={16}
            />
            <TouchableOpacity
              onPress={() => customValid && onPick(customTrimmed)}
              disabled={!customValid}
              style={[styles.useBtn, { backgroundColor: c.primary, opacity: customValid ? 1 : 0.4 }]}
              accessibilityRole="button"
              accessibilityLabel="Use typed emoji"
            >
              <Text style={{ color: c.onPrimary, fontWeight: '600' }}>Use</Text>
            </TouchableOpacity>
          </View>
          <View style={[styles.footer, { borderTopColor: c.border }]}>
            <TouchableOpacity onPress={() => onPick(null)} style={styles.footerBtn} accessibilityRole="button">
              <Text style={{ color: c.textSecondary }}>Use default {DEFAULT_QUICK_EMOJI}</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={onClose} style={styles.footerBtn} accessibilityRole="button">
              <Text style={{ color: c.textSecondary, fontWeight: '600' }}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'flex-end' },
  sheet: { margin: 12, padding: 16, borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, maxWidth: 520, alignSelf: 'center', width: '96%' },
  title: { ...type.title, marginBottom: 4 },
  hint: { ...type.label, fontWeight: '400', marginBottom: 12 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center' },
  cell: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center', borderRadius: radius.md },
  cellEmoji: { ...type.display, fontWeight: '400', letterSpacing: 0 },
  customRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12 },
  customInput: { flex: 1, minHeight: 44, borderWidth: 1, borderRadius: radius.md, paddingHorizontal: 12, ...type.title, fontWeight: '400' },
  useBtn: { minHeight: 44, paddingHorizontal: 16, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  footer: { flexDirection: 'row', justifyContent: 'space-between', borderTopWidth: StyleSheet.hairlineWidth, marginTop: 14, paddingTop: 6 },
  footerBtn: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 4 },
});
