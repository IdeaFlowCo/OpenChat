/**
 * SelectableTextSheet — shows one piece of authored text in full, selectable,
 * with "Copy all". It is the "Select text…" action on cards whose tap or
 * long-press already does something else (Stream entries, chat bubbles, search
 * hits): on iOS those press handlers swallow the long-press that would start
 * native selection, so selection happens here instead, like Messages' "Select".
 */
import { useEffect, useState } from 'react';
import { Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';
import { radius, sheetShadow, space, touchTarget, type } from '../theme/tokens';
import { copyText } from '../utils/copyText';

export function SelectableTextSheet({ visible, text, title, onClose }: {
  visible: boolean; text: string; title?: string; onClose: () => void;
}) {
  return <Modal transparent animationType="fade" visible={visible} onRequestClose={onClose}>
    {visible && <SelectableTextPanel text={text} title={title} onClose={onClose} />}
  </Modal>;
}

/**
 * The sheet's content without its own Modal, for menus that are already in a
 * Modal: on iOS, dismissing one Modal while presenting another can drop the
 * second, so those menus switch their content to this panel instead.
 */
export function SelectableTextPanel({ text, title = 'Select text', onClose }: { text: string; title?: string; onClose: () => void }) {
  const c = getColors(useTheme().scheme);
  const [status, setStatus] = useState('');
  useEffect(() => { setStatus(''); }, [text]);
  const copyAll = async () => setStatus(await copyText(text) ? 'Copied' : 'Could not copy');
  return <Pressable style={styles.overlay} onPress={onClose} accessibilityLabel="Close">
      <Pressable onPress={event => event.stopPropagation()} style={[styles.sheet, { backgroundColor: c.surface, borderColor: c.border }]}>
        <Text accessibilityRole="header" style={[type.title, { color: c.textPrimary }]}>{title}</Text>
        <Text style={[type.meta, { color: c.textMetadata, marginTop: space[1] }]}>
          {Platform.OS === 'web' ? 'Drag to select part of the text, or copy all of it.' : 'Press and hold to select part of the text, or copy all of it.'}
        </Text>
        <ScrollView style={[styles.textBox, { borderColor: c.border, backgroundColor: c.background }]} contentContainerStyle={{ padding: space[3] }}>
          <Text selectable testID="selectable-text-sheet-body" style={[type.body, { color: c.textPrimary }]}>{text}</Text>
        </ScrollView>
        <View style={styles.row}>
          <TouchableOpacity accessibilityRole="button" onPress={() => void copyAll()} style={styles.button}>
            <Text style={[type.label, { color: c.primary }]}>Copy all</Text>
          </TouchableOpacity>
          <TouchableOpacity accessibilityRole="button" onPress={onClose} style={styles.button}>
            <Text style={[type.label, { color: c.primary }]}>Done</Text>
          </TouchableOpacity>
          <Text accessibilityLiveRegion="polite" role="status" style={[type.meta, { color: status === 'Copied' ? c.textMetadata : c.danger }]}>{status}</Text>
        </View>
      </Pressable>
    </Pressable>;
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: space[4], backgroundColor: 'rgba(0,0,0,0.45)' },
  sheet: { width: '100%', maxWidth: 560, maxHeight: '85%', borderWidth: 1, borderRadius: radius.lg, padding: space[4], ...sheetShadow },
  textBox: { marginTop: space[3], borderWidth: 1, borderRadius: radius.md, flexGrow: 0 },
  row: { flexDirection: 'row', alignItems: 'center', gap: space[3], marginTop: space[3] },
  button: { minHeight: touchTarget, justifyContent: 'center', paddingHorizontal: space[2] },
});
