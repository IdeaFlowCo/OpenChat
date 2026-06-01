/**
 * Create a new agent API key (OpenChat-7c9).
 *
 * Form: name (required), scopes (read / write toggles), agentName (optional),
 * expiresAt (optional).  On submit → shows the key on a confirmation screen.
 */

import { useState } from 'react';
import {
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  Clipboard,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useTheme } from '../contexts/ThemeContext';
import { api, AgentKeyCreateResult, OPENCHAT_URL } from '../api/client';
import { getColors } from '../theme/colors';
import { McpSetupCard } from '../components/McpSetupCard';
import type { NavProp } from '../navigation/types';

const ALL_SCOPES = ['read', 'write'] as const;

export function AddAgentKeyScreen() {
  const navigation = useNavigation<NavProp<'AddAgentKey'>>();
  const { scheme } = useTheme();
  const c = getColors(scheme);

  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<Set<string>>(new Set(['read', 'write']));
  const [agentName, setAgentName] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // After creation, we show the confirmation inline.
  const [created, setCreated] = useState<AgentKeyCreateResult | null>(null);

  const toggleScope = (scope: string) => {
    setScopes((prev) => {
      const next = new Set(prev);
      if (next.has(scope)) {
        // Don't allow removing the last scope
        if (next.size === 1) return prev;
        next.delete(scope);
      } else {
        next.add(scope);
      }
      return next;
    });
  };

  const handleSubmit = async () => {
    if (!name.trim()) {
      Alert.alert('Name required', 'Please enter a name for this key.');
      return;
    }
    setSubmitting(true);
    try {
      const result = await api.createAgentKey({
        name: name.trim(),
        scopes: Array.from(scopes),
        agentName: agentName.trim() || undefined,
      });
      setCreated(result);
    } catch (err) {
      Alert.alert('Error', err instanceof Error ? err.message : 'Failed to create key');
    } finally {
      setSubmitting(false);
    }
  };

  if (created) {
    const curlSnippet = `curl -H "Authorization: Bearer ${created.key}" \\\n  ${OPENCHAT_URL}/api/chat/conversations`;

    return (
      <ScrollView
        style={{ flex: 1, backgroundColor: c.background }}
        contentContainerStyle={styles.confirmContainer}
      >
        <Text style={[styles.confirmTitle, { color: c.textPrimary }]}>Key created!</Text>
        <Text style={[styles.confirmHint, { color: c.textSecondary }]}>
          Copy your key now. You can view it again from Agent Keys in Settings.
        </Text>

        <View style={[styles.codeBox, { backgroundColor: c.surfaceElevated, borderColor: c.border }]}>
          <Text style={[styles.codeText, { color: c.textPrimary }]} selectable>
            {created.key}
          </Text>
        </View>

        <TouchableOpacity
          style={[styles.btn, { backgroundColor: c.primary }]}
          onPress={() => {
            Clipboard.setString(created.key);
            Alert.alert('Copied', 'Key copied to clipboard.');
          }}
        >
          <Text style={styles.btnText}>Copy key</Text>
        </TouchableOpacity>

        <Text style={[styles.curlLabel, { color: c.textSecondary }]}>Quick-start curl:</Text>
        <View style={[styles.codeBox, { backgroundColor: c.surfaceElevated, borderColor: c.border }]}>
          <Text style={[styles.codeText, { color: c.textPrimary }]} selectable>
            {curlSnippet}
          </Text>
        </View>

        <TouchableOpacity
          style={[styles.btn, { backgroundColor: c.surfaceElevated, borderColor: c.border, borderWidth: 1 }]}
          onPress={() => {
            Clipboard.setString(curlSnippet);
            Alert.alert('Copied', 'curl snippet copied to clipboard.');
          }}
        >
          <Text style={[styles.btnText, { color: c.textPrimary }]}>Copy curl snippet</Text>
        </TouchableOpacity>

        {/* Bi-directional MCP setup snippets — Claude Desktop, Cursor, Codex, … */}
        <McpSetupCard apiKey={created.key} />

        <TouchableOpacity
          style={[styles.btn, { marginTop: 12 }]}
          onPress={() => navigation.goBack()}
        >
          <Text style={[styles.btnText, { color: c.primary }]}>Done</Text>
        </TouchableOpacity>
      </ScrollView>
    );
  }

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: c.background }}
      contentContainerStyle={styles.container}
      keyboardShouldPersistTaps="handled"
    >
      {/* Name */}
      <Text style={[styles.label, { color: c.textSecondary }]}>KEY NAME *</Text>
      <TextInput
        style={[styles.input, { backgroundColor: c.surface, borderColor: c.border, color: c.textPrimary }]}
        placeholder="e.g. My summary bot"
        placeholderTextColor={c.textMuted}
        value={name}
        onChangeText={setName}
        autoFocus
        returnKeyType="next"
      />

      {/* Scopes */}
      <Text style={[styles.label, { color: c.textSecondary, marginTop: 20 }]}>SCOPES</Text>
      <View style={styles.scopeRow}>
        {ALL_SCOPES.map((s) => {
          const active = scopes.has(s);
          return (
            <TouchableOpacity
              key={s}
              style={[
                styles.scopeChip,
                {
                  backgroundColor: active ? c.primaryMuted : c.surface,
                  borderColor: active ? c.primary : c.border,
                },
              ]}
              onPress={() => toggleScope(s)}
              activeOpacity={0.7}
            >
              <Text style={{ color: active ? c.primary : c.textSecondary, fontWeight: '600' }}>{s}</Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {/* Agent name (optional) */}
      <Text style={[styles.label, { color: c.textSecondary, marginTop: 20 }]}>AGENT NAME (optional)</Text>
      <TextInput
        style={[styles.input, { backgroundColor: c.surface, borderColor: c.border, color: c.textPrimary }]}
        placeholder="e.g. my-summary-bot"
        placeholderTextColor={c.textMuted}
        value={agentName}
        onChangeText={setAgentName}
        autoCapitalize="none"
        returnKeyType="done"
      />

      <TouchableOpacity
        style={[styles.submitBtn, { backgroundColor: c.primary, opacity: submitting ? 0.6 : 1 }]}
        onPress={handleSubmit}
        disabled={submitting}
        activeOpacity={0.8}
      >
        <Text style={styles.submitText}>{submitting ? 'Creating…' : 'Create key'}</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 20 },
  label: { fontSize: 11, fontWeight: '700', letterSpacing: 1, marginBottom: 8 },
  input: {
    paddingHorizontal: 12,
    paddingVertical: 11,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    fontSize: 16,
  },
  scopeRow: { flexDirection: 'row', gap: 10 },
  scopeChip: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1,
  },
  submitBtn: {
    marginTop: 32,
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
  },
  submitText: { color: '#fff', fontSize: 16, fontWeight: '700' },

  // Confirmation screen
  confirmContainer: { padding: 24, alignItems: 'stretch' },
  confirmTitle: { fontSize: 22, fontWeight: '700', marginBottom: 8 },
  confirmHint: { fontSize: 14, marginBottom: 20, lineHeight: 20 },
  codeBox: {
    padding: 14,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: 12,
  },
  codeText: { fontSize: 13, fontFamily: 'Courier' },
  curlLabel: { fontSize: 12, marginBottom: 6 },
  btn: {
    paddingVertical: 13,
    borderRadius: 8,
    alignItems: 'center',
    marginBottom: 8,
  },
  btnText: { color: '#fff', fontSize: 15, fontWeight: '600' },
});
