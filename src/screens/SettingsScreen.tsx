/**
 * Settings screen — for now just the theme toggle (OpenChat-bji), expo-
 * secure-store status (OpenChat-ghr), and a sign-out button. Reached via
 * a gear icon in the Conversations header.
 *
 * Designed so the surface is easy to extend: add a new row, the screen
 * just grows downward.
 */

import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useTheme, ThemePref } from '../contexts/ThemeContext';
import { useChat } from '../contexts/ChatContext';
import { getColors } from '../theme/colors';

const OPTIONS: { value: ThemePref; label: string; hint: string }[] = [
  { value: 'system', label: 'System', hint: 'Follow your phone' },
  { value: 'light', label: 'Light', hint: '' },
  { value: 'dark', label: 'Dark', hint: '' },
];

export function SettingsScreen() {
  const { preference, setPreference, scheme } = useTheme();
  const { currentUser, signOut } = useChat();
  const c = getColors(scheme);

  return (
    <View style={[styles.root, { backgroundColor: c.background }]}>
      {currentUser && (
        <View style={styles.section}>
          <Text style={[styles.sectionLabel, { color: c.textSecondary }]}>SIGNED IN AS</Text>
          <View style={[styles.row, { backgroundColor: c.surface, borderColor: c.border }]}>
            <Text style={[styles.rowText, { color: c.textPrimary }]}>{currentUser.email}</Text>
          </View>
        </View>
      )}

      <View style={styles.section}>
        <Text style={[styles.sectionLabel, { color: c.textSecondary }]}>APPEARANCE</Text>
        <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }]}>
          {OPTIONS.map((opt, i) => {
            const selected = preference === opt.value;
            return (
              <TouchableOpacity
                key={opt.value}
                style={[
                  styles.optionRow,
                  i < OPTIONS.length - 1 && { borderBottomColor: c.divider, borderBottomWidth: StyleSheet.hairlineWidth },
                ]}
                onPress={() => setPreference(opt.value)}
                activeOpacity={0.7}
              >
                <View style={{ flex: 1 }}>
                  <Text style={[styles.optionLabel, { color: c.textPrimary }]}>{opt.label}</Text>
                  {opt.hint ? (
                    <Text style={[styles.optionHint, { color: c.textSecondary }]}>{opt.hint}</Text>
                  ) : null}
                </View>
                <View style={[styles.radio, { borderColor: selected ? c.primary : c.border }]}>
                  {selected && <View style={[styles.radioDot, { backgroundColor: c.primary }]} />}
                </View>
              </TouchableOpacity>
            );
          })}
        </View>
      </View>

      <View style={styles.section}>
        <TouchableOpacity
          style={[styles.dangerBtn, { borderColor: c.danger }]}
          onPress={signOut}
        >
          <Text style={{ color: c.danger, fontWeight: '600', fontSize: 16 }}>Sign out</Text>
        </TouchableOpacity>
      </View>

      <Text style={[styles.versionFooter, { color: c.textMuted }]}>OpenChat mobile · v0.1.0</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, paddingHorizontal: 16, paddingTop: 16 },
  section: { marginBottom: 24 },
  sectionLabel: { fontSize: 11, fontWeight: '700', letterSpacing: 1, marginBottom: 8 },
  row: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
  },
  rowText: { fontSize: 15 },
  card: {
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  optionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  optionLabel: { fontSize: 16, fontWeight: '500' },
  optionHint: { fontSize: 12, marginTop: 2 },
  radio: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioDot: { width: 10, height: 10, borderRadius: 5 },
  dangerBtn: {
    paddingVertical: 14,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: 'center',
  },
  versionFooter: { fontSize: 11, textAlign: 'center', marginTop: 8 },
});
