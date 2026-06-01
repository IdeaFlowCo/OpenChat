/**
 * NVCComposerModal (OpenChat-3kr.2).
 *
 * Optional composer mode that scaffolds a message in Marshall Rosenberg's
 * Non-Violent Communication form. The user fills four labeled fields:
 *
 *   - Observation — "When I see/hear..."
 *   - Feeling     — "I feel..."
 *   - Need        — "Because I need..."
 *   - Request     — "Would you be willing to..."
 *
 * The four fields are concatenated into a single chat message with prefixes
 * so the receiver sees the NVC structure. Useful for difficult conversations
 * and partner/team chats where intentional language matters.
 *
 * UX:
 *   - Modal slides in from below
 *   - Each field is multi-line, auto-grows
 *   - The Send button is disabled until at least Observation + Feeling are
 *     populated (the bare minimum for an NVC-coded message)
 *   - A tiny info-pill at top reminds the user of the NVC frame
 *   - On Send, the modal returns the assembled text via onSubmit; the parent
 *     decides whether to dispatch through normal sendMessage or pre-route
 *     through a transform.
 *
 * Stretch (NOT in this version):
 *   - @nvc agent coaching pass before send
 *   - Self-empathy reflection screen (sender sees their own NVC draft
 *     reflected back before it leaves the device)
 *
 * Both stretch items are tracked under OpenChat-3kr.3 (agentic features).
 */

import { useState } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';

interface Props {
  visible: boolean;
  /** Called with the assembled message text. Parent fires send/transform. */
  onSubmit: (assembled: string) => void;
  onCancel: () => void;
}

const FIELDS: { key: 'observation' | 'feeling' | 'need' | 'request'; label: string; hint: string; placeholder: string }[] = [
  {
    key: 'observation',
    label: 'Observation',
    hint: 'What did you see or hear?',
    placeholder: 'When I notice / see / hear …',
  },
  {
    key: 'feeling',
    label: 'Feeling',
    hint: 'How do you feel about it?',
    placeholder: 'I feel …',
  },
  {
    key: 'need',
    label: 'Need',
    hint: "What's the underlying need?",
    placeholder: 'Because I need / value …',
  },
  {
    key: 'request',
    label: 'Request',
    hint: 'What concrete action would help?',
    placeholder: 'Would you be willing to …',
  },
];

export function NVCComposerModal({ visible, onSubmit, onCancel }: Props) {
  const { scheme } = useTheme();
  const c = getColors(scheme);

  const [observation, setObservation] = useState('');
  const [feeling, setFeeling] = useState('');
  const [need, setNeed] = useState('');
  const [request, setRequest] = useState('');

  // Bare minimum for an NVC-coded message: an observation + a feeling.
  // Need + Request are encouraged but not strictly required.
  const canSubmit = observation.trim().length > 0 && feeling.trim().length > 0;

  const values: Record<string, string> = { observation, feeling, need, request };
  const setters: Record<string, (s: string) => void> = {
    observation: setObservation,
    feeling: setFeeling,
    need: setNeed,
    request: setRequest,
  };

  const handleSend = () => {
    if (!canSubmit) return;
    const parts: string[] = [];
    // Use unicode middle-dot bullets so receivers see the NVC structure
    // without needing to parse markdown.
    if (observation.trim()) parts.push(`Observation · ${observation.trim()}`);
    if (feeling.trim())     parts.push(`Feeling · ${feeling.trim()}`);
    if (need.trim())        parts.push(`Need · ${need.trim()}`);
    if (request.trim())     parts.push(`Request · ${request.trim()}`);
    const assembled = parts.join('\n');
    onSubmit(assembled);
    // Clear fields so the next NVC compose starts fresh.
    setObservation('');
    setFeeling('');
    setNeed('');
    setRequest('');
  };

  const handleCancel = () => {
    // Keep fields populated on cancel so the user can re-open without losing
    // work; they can clear manually if they want a fresh draft.
    onCancel();
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={handleCancel}
    >
      <KeyboardAvoidingView
        style={styles.backdrop}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <Pressable style={styles.dim} onPress={handleCancel} />
        <View style={[styles.sheet, { backgroundColor: c.background, borderColor: c.border }]}>
          <View style={[styles.header, { borderBottomColor: c.border }]}>
            <Pressable onPress={handleCancel} hitSlop={8}>
              <Text style={[styles.headerCancel, { color: c.textSecondary }]}>Cancel</Text>
            </Pressable>
            <Text style={[styles.headerTitle, { color: c.textPrimary }]}>NVC compose</Text>
            <Pressable
              onPress={handleSend}
              hitSlop={8}
              disabled={!canSubmit}
              style={{ opacity: canSubmit ? 1 : 0.4 }}
            >
              <Text style={[styles.headerSend, { color: c.primary }]}>Send</Text>
            </Pressable>
          </View>

          <View style={[styles.helperPill, { backgroundColor: c.surface, borderColor: c.border }]}>
            <Text style={[styles.helperText, { color: c.textSecondary }]} numberOfLines={2}>
              Frame: <Text style={{ color: c.textPrimary }}>Observation → Feeling → Need → Request</Text>. Observation + Feeling required.
            </Text>
          </View>

          <ScrollView
            style={styles.fields}
            contentContainerStyle={{ paddingBottom: 32 }}
            keyboardShouldPersistTaps="handled"
          >
            {FIELDS.map((f) => (
              <View key={f.key} style={{ marginBottom: 18 }}>
                <Text style={[styles.label, { color: c.textSecondary }]}>{f.label.toUpperCase()}</Text>
                <Text style={[styles.fieldHint, { color: c.textMuted }]}>{f.hint}</Text>
                <TextInput
                  style={[
                    styles.input,
                    {
                      backgroundColor: c.surface,
                      borderColor: c.border,
                      color: c.textPrimary,
                    },
                  ]}
                  value={values[f.key]}
                  onChangeText={setters[f.key]}
                  placeholder={f.placeholder}
                  placeholderTextColor={c.textMuted}
                  multiline
                />
              </View>
            ))}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  dim: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  sheet: {
    maxHeight: '88%',
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerCancel: { fontSize: 15 },
  headerTitle: { fontSize: 16, fontWeight: '700' },
  headerSend: { fontSize: 15, fontWeight: '700' },
  helperPill: {
    marginHorizontal: 16,
    marginTop: 12,
    paddingVertical: 9,
    paddingHorizontal: 14,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
  },
  helperText: { fontSize: 12, lineHeight: 17 },
  fields: { paddingHorizontal: 16, paddingTop: 14 },
  label: { fontSize: 11, fontWeight: '700', letterSpacing: 1, marginBottom: 2 },
  fieldHint: { fontSize: 12, marginBottom: 7 },
  input: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 9,
    borderWidth: StyleSheet.hairlineWidth,
    fontSize: 15,
    minHeight: 60,
    textAlignVertical: 'top',
  },
});
