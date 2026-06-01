/**
 * KeyboardShortcutsScreen — small cheat-sheet listing all desktop keyboard
 * shortcuts. Presented as a modal route from MasterDetailLayout via Cmd-/
 * (web only). Mobile users never see this screen — the route is registered
 * in App.tsx unconditionally but only ever opened from web shortcut code.
 *
 * Layout mirrors the simple "list of rows" pattern in SettingsScreen.
 */

import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';
import type { NavProp } from '../navigation/types';

interface Shortcut {
  keys: string;
  label: string;
}

// `⌘` on macOS, `Ctrl` elsewhere — best-effort detect at module load.
function detectMetaLabel(): string {
  if (Platform.OS !== 'web') return '⌘';
  try {
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent || '' : '';
    return /Mac|iPod|iPhone|iPad/.test(ua) ? '⌘' : 'Ctrl';
  } catch {
    return '⌘';
  }
}

export function KeyboardShortcutsScreen() {
  const { scheme } = useTheme();
  const c = getColors(scheme);
  const navigation = useNavigation<NavProp<'KeyboardShortcuts'>>();
  const meta = detectMetaLabel();

  const shortcuts: Shortcut[] = [
    { keys: `${meta} K`, label: 'Search messages, chats, and people' },
    { keys: `${meta} N`, label: 'New conversation' },
    { keys: `${meta} ,`, label: 'Open settings' },
    { keys: `${meta} /`, label: 'Show this cheat sheet' },
    { keys: 'Esc', label: 'Close modal / deselect conversation' },
    { keys: 'Enter', label: 'Send message (in composer)' },
    { keys: 'Shift + Enter', label: 'New line (in composer)' },
  ];

  return (
    <View style={[styles.root, { backgroundColor: c.background }]}>
      <View style={styles.section}>
        <Text style={[styles.sectionLabel, { color: c.textSecondary }]}>KEYBOARD SHORTCUTS</Text>
        <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }]}>
          {shortcuts.map((s, i) => (
            <View
              key={s.keys}
              style={[
                styles.row,
                i < shortcuts.length - 1 && {
                  borderBottomColor: c.divider,
                  borderBottomWidth: StyleSheet.hairlineWidth,
                },
              ]}
            >
              <Text style={[styles.label, { color: c.textPrimary }]}>{s.label}</Text>
              <View style={[styles.kbd, { backgroundColor: c.surfaceElevated, borderColor: c.border }]}>
                <Text style={[styles.kbdText, { color: c.textPrimary }]}>{s.keys}</Text>
              </View>
            </View>
          ))}
        </View>
        <Pressable
          onPress={() => navigation.goBack()}
          style={[styles.closeBtn, { backgroundColor: c.primary }]}
          accessibilityLabel="Close"
        >
          <Text style={{ color: '#fff', fontWeight: '600' }}>Close</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, paddingHorizontal: 16, paddingTop: 16 },
  section: { marginBottom: 24, maxWidth: 520, width: '100%', alignSelf: 'center' },
  sectionLabel: { fontSize: 12, fontWeight: '600', letterSpacing: 0.5, marginBottom: 6 },
  card: {
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 12,
  },
  label: { fontSize: 14, flex: 1 },
  kbd: {
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    minWidth: 48,
    alignItems: 'center',
  },
  kbdText: { fontSize: 12, fontWeight: '600', fontFamily: Platform.OS === 'web' ? 'monospace' : undefined },
  closeBtn: {
    marginTop: 16,
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 10,
    alignItems: 'center',
    alignSelf: 'center',
    minWidth: 120,
  },
});
