/**
 * McpSetupCard — copy-paste config snippets so an agent (Claude Desktop,
 * Cursor, Codex CLI, Claude Code, raw curl) can talk to OpenChat using
 * an agent API key (OpenChat-7c9).
 *
 * Used by both AddAgentKeyScreen (right after creation) and
 * AgentKeyDetailScreen (after "View full key"). When `apiKey` is null
 * we render placeholders (`oc_your_key_here`); when present we
 * inline the real key so it's truly copy-and-paste.
 *
 * Each tab has its own "Copy" button. Tab state is local — the user
 * can flip between Claude / Cursor / Codex / Code / curl freely.
 */
import { useState } from 'react';
import {
  Alert,
  Clipboard,
  Linking,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';
import { OPENCHAT_URL } from '../api/client';

type Target = 'claude' | 'cursor' | 'codex' | 'code' | 'curl';

const TABS: { id: Target; label: string }[] = [
  { id: 'claude', label: 'Claude Desktop' },
  { id: 'cursor', label: 'Cursor' },
  { id: 'codex',  label: 'Codex CLI' },
  { id: 'code',   label: 'Claude Code' },
  { id: 'curl',   label: 'curl' },
];

function snippetFor(target: Target, key: string): string {
  const k = key;
  switch (target) {
    case 'claude':
      return JSON.stringify({
        mcpServers: {
          openchat: {
            command: 'npx',
            args: ['-y', 'github:tmad4000/openchat-mcp-server'],
            env: { OPENCHAT_API_KEY: k },
          },
        },
      }, null, 2);
    case 'cursor':
      return JSON.stringify({
        mcpServers: {
          openchat: {
            command: 'npx',
            args: ['-y', 'github:tmad4000/openchat-mcp-server'],
            env: { OPENCHAT_API_KEY: k },
          },
        },
      }, null, 2);
    case 'codex':
      return `[mcp_servers.openchat]
command = "npx"
args = ["-y", "github:tmad4000/openchat-mcp-server"]
env = { OPENCHAT_API_KEY = "${k}" }`;
    case 'code':
      return `claude mcp add openchat \\
  --env OPENCHAT_API_KEY=${k} \\
  -- npx -y github:tmad4000/openchat-mcp-server`;
    case 'curl':
      return `curl -H "Authorization: Bearer ${k}" \\
  ${OPENCHAT_URL}/api/chat/conversations`;
  }
}

function hintFor(target: Target): string {
  switch (target) {
    case 'claude': return 'Paste into ~/Library/Application Support/Claude/claude_desktop_config.json, then restart Claude Desktop.';
    case 'cursor': return 'Paste into ~/.cursor/mcp.json (global) or .cursor/mcp.json (project), then reload.';
    case 'codex':  return 'Append to ~/.codex/config.toml.';
    case 'code':   return 'Run in your terminal — it registers the MCP server with Claude Code.';
    case 'curl':   return 'A quick smoke test from any shell. Returns your conversations as JSON.';
  }
}

interface Props {
  /** The plaintext API key. If null we render `oc_your_key_here` placeholders. */
  apiKey: string | null;
}

export function McpSetupCard({ apiKey }: Props) {
  const { scheme } = useTheme();
  const c = getColors(scheme);
  const [active, setActive] = useState<Target>('claude');

  const displayedKey = apiKey ?? 'oc_your_key_here';
  const snippet = snippetFor(active, displayedKey);

  return (
    <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }]}>
      <Text style={[styles.title, { color: c.textPrimary }]}>Connect an agent</Text>
      <Text style={[styles.subtitle, { color: c.textSecondary }]}>
        Bi-directional read + write to your conversations.
        {apiKey ? '' : ' Reveal the key above to inline it into these snippets.'}
      </Text>

      {/* Tab strip */}
      <View style={styles.tabRow}>
        {TABS.map((t) => {
          const isActive = t.id === active;
          return (
            <TouchableOpacity
              key={t.id}
              onPress={() => setActive(t.id)}
              style={[
                styles.tab,
                {
                  backgroundColor: isActive ? c.primaryMuted : 'transparent',
                  borderColor: isActive ? c.primary : c.border,
                },
              ]}
              activeOpacity={0.7}
            >
              <Text style={{
                color: isActive ? c.primary : c.textSecondary,
                fontWeight: '600',
                fontSize: 12,
              }}>{t.label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {/* Hint */}
      <Text style={[styles.hint, { color: c.textMuted }]}>{hintFor(active)}</Text>

      {/* Snippet */}
      <View style={[styles.codeBox, { backgroundColor: c.surfaceElevated, borderColor: c.border }]}>
        <Text style={[styles.codeText, { color: c.textPrimary }]} selectable>
          {snippet}
        </Text>
      </View>

      {/* Actions */}
      <View style={styles.actions}>
        <TouchableOpacity
          style={[styles.btn, { backgroundColor: c.primary }]}
          onPress={() => {
            Clipboard.setString(snippet);
            Alert.alert('Copied', `${TABS.find((t) => t.id === active)!.label} snippet copied.`);
          }}
          activeOpacity={0.8}
        >
          <Text style={styles.btnText}>Copy</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.btn, { backgroundColor: 'transparent', borderWidth: 1, borderColor: c.border }]}
          onPress={() => void Linking.openURL(`${OPENCHAT_URL}/about/connect-your-bot`)}
          activeOpacity={0.7}
        >
          <Text style={[styles.btnText, { color: c.textPrimary }]}>Full guide</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 16,
    marginTop: 12,
  },
  title: { fontSize: 16, fontWeight: '700', marginBottom: 4 },
  subtitle: { fontSize: 13, marginBottom: 14, lineHeight: 18 },
  tabRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginBottom: 10,
  },
  tab: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 14,
    borderWidth: 1,
  },
  hint: { fontSize: 12, marginBottom: 10, lineHeight: 17 },
  codeBox: {
    padding: 12,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: 10,
  },
  codeText: { fontSize: 12, fontFamily: 'Courier', lineHeight: 17 },
  actions: { flexDirection: 'row', gap: 10 },
  btn: {
    flex: 1,
    paddingVertical: 11,
    borderRadius: 8,
    alignItems: 'center',
  },
  btnText: { color: '#fff', fontSize: 14, fontWeight: '600' },
});
