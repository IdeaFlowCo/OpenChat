/**
 * McpSetupCard — connect an AI agent to OpenChat using an agent API key
 * (OpenChat-7c9).
 *
 * Layout (openchat-oc8.1): lead with ONE primary action — a big blue
 * button that copies the tool-less "ChatGPT / Any LLM" REST onboarding
 * blob, which can be pasted into any chatbot. The MCP/CLI config snippets
 * (Claude Desktop, Cursor, Codex CLI, Claude Code, curl) are collapsed
 * behind an "Advanced setup" disclosure (default collapsed).
 *
 * Used by both AddAgentKeyScreen (right after creation) and
 * AgentKeyDetailScreen (after "View full key"). When `apiKey` is null
 * we render placeholders (`oc_your_key_here`); when present we
 * inline the real key so it's truly copy-and-paste.
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
import { buildAgentSetupBlob } from '../utils/agentSetupBlob';

type Target = 'chatgpt' | 'claude' | 'cursor' | 'codex' | 'code' | 'curl';

// Advanced (collapsed) clients. The default/primary "ChatGPT / Any LLM"
// onboarding blob is surfaced as the hero CTA, not as a tab here.
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
    case 'chatgpt':
      // Tool-less prose blob: paste into a plain chat box (ChatGPT, Gemini,
      // Claude.ai — anything that can make HTTP requests or relay curl). No
      // MCP server, no shell, no file writes required. Self-contained.
      // Shared with the one-click "Copy agent setup" action in Settings.
      return buildAgentSetupBlob(k, OPENCHAT_URL);
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
    case 'chatgpt': return 'Paste into any chat box — ChatGPT, Gemini, Claude.ai. No install needed; the model talks to OpenChat over plain HTTPS. Works with any LLM that can make web requests.';
    case 'claude': return 'Paste into ~/Library/Application Support/Claude/claude_desktop_config.json, then restart Claude Desktop.';
    case 'cursor': return 'Paste into ~/.cursor/mcp.json (global) or .cursor/mcp.json (project), then reload.';
    case 'codex':  return 'Append to ~/.codex/config.toml.';
    case 'code':   return 'Run in your terminal — it registers the MCP server with Claude Code.';
    case 'curl':   return 'A quick smoke test from any shell. Returns your conversations as JSON.';
  }
}

/**
 * One-shot prompt for CODING agents (Claude Code, Cursor, Codex CLI): paste it
 * and the agent installs + registers the OpenChat MCP server itself, then
 * verifies. Lives in Advanced (the hero CTA is the tool-less REST blob for
 * any LLM). Restored per Jacob 2026-06-04 (openchat-oc8.1).
 */
function agentSetupPrompt(key: string, guideUrl: string): string {
  return `Please set up the OpenChat MCP server in this environment so you can read and send messages from my OpenChat account on my behalf.

Setup guide: ${guideUrl}

My OpenChat API key:
${key}

Steps:
1. Read the guide above to understand the available tools and how this MCP server works.
2. Install + register the MCP server using the install form appropriate for this client (e.g. \`claude mcp add openchat --env OPENCHAT_API_KEY=<key> -- npx -y github:tmad4000/openchat-mcp-server\` for Claude Code).
3. If the MCP server is registered correctly, call \`oc_list_conversations\` to verify it works and print the list of conversations.
4. Tell me what you'd like me to do next — or wait for instructions.

Treat the API key as a credential: write it to \`~/.openchat/credentials.json\` (mode 600) or pass via env var. Do not commit it to any repo.`;
}

interface Props {
  /** The plaintext API key. If null we render `oc_your_key_here` placeholders. */
  apiKey: string | null;
}

export function McpSetupCard({ apiKey }: Props) {
  const { scheme } = useTheme();
  const c = getColors(scheme);
  const [active, setActive] = useState<Target>('claude');
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const displayedKey = apiKey ?? 'oc_your_key_here';
  const snippet = snippetFor(active, displayedKey);
  const guideUrl = `${OPENCHAT_URL}/about/connect-your-bot`;

  // Primary CTA payload: the tool-less "ChatGPT / Any LLM" REST blob. Paste
  // it into any chatbot and the model talks to OpenChat over plain HTTPS —
  // no MCP server, no shell, no installs. Disabled (visually) until the
  // plaintext key is revealed, otherwise the blob would carry a placeholder.
  const primaryBlob = snippetFor('chatgpt', displayedKey);

  return (
    <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }]}>
      <Text style={[styles.title, { color: c.textPrimary }]}>Connect an agent</Text>
      <Text style={[styles.subtitle, { color: c.textSecondary }]}>
        Let an AI read and send messages on your behalf — bi-directional access to your conversations.
        {apiKey ? '' : ' Reveal the key above first so it can be inlined.'}
      </Text>

      {/* PRIMARY CTA: copy the tool-less onboarding blob for any LLM. */}
      <TouchableOpacity
        style={[styles.heroBtn, { backgroundColor: c.primary, opacity: apiKey ? 1 : 0.55 }]}
        onPress={() => {
          if (!apiKey) {
            Alert.alert('Reveal your key first', 'Tap "View full key" above so the setup text can include the real key.');
            return;
          }
          Clipboard.setString(primaryBlob);
          Alert.alert(
            'Setup copied',
            'Paste it into ChatGPT, Claude, Gemini, or any chatbot. The model will connect to OpenChat over plain HTTPS — no install needed.'
          );
        }}
        activeOpacity={0.85}
      >
        <Text style={styles.heroBtnText}>📋  Copy agent setup</Text>
        <Text style={styles.heroBtnSub}>Works in ChatGPT, Claude, Gemini — any LLM</Text>
      </TouchableOpacity>

      {/* Always-visible link to the full guide. */}
      <TouchableOpacity
        onPress={() => void Linking.openURL(guideUrl)}
        activeOpacity={0.6}
        style={styles.guideLinkRow}
      >
        <Text style={[styles.guideLinkText, { color: c.primary }]}>📖  Read the setup guide</Text>
        <Text style={[styles.guideLinkUrl, { color: c.textMuted }]} numberOfLines={1}>
          {guideUrl.replace(/^https?:\/\//, '')}
        </Text>
      </TouchableOpacity>

      {/* ADVANCED: collapsed disclosure holding the MCP/CLI config snippets. */}
      <View style={[styles.divider, { backgroundColor: c.border }]} />

      <TouchableOpacity
        onPress={() => setAdvancedOpen((v) => !v)}
        activeOpacity={0.6}
        style={styles.advancedToggle}
      >
        <Text style={[styles.advancedToggleText, { color: c.textSecondary }]}>
          {advancedOpen ? '▾' : '▸'}  Advanced setup (MCP &amp; CLI clients)
        </Text>
      </TouchableOpacity>

      {advancedOpen && (
        <View style={styles.advancedBody}>
          {/* One-shot prompt for coding agents (Claude Code / Cursor / Codex):
              the agent installs the MCP server itself. */}
          <TouchableOpacity
            style={[styles.oneShotBtn, { borderColor: c.primary, opacity: apiKey ? 1 : 0.55 }]}
            onPress={() => {
              if (!apiKey) {
                Alert.alert('Reveal your key first', 'Tap "View full key" above so the prompt can include the real key.');
                return;
              }
              Clipboard.setString(agentSetupPrompt(displayedKey, guideUrl));
              Alert.alert(
                'One-shot prompt copied',
                'Paste into Claude Code, Cursor, or any agent CLI — it installs the OpenChat MCP server and verifies the connection.'
              );
            }}
            activeOpacity={0.8}
          >
            <Text style={[styles.oneShotText, { color: c.primary }]}>📋  Copy one-shot setup prompt (coding agents)</Text>
            <Text style={[styles.oneShotSub, { color: c.textMuted }]}>Paste into Claude Code / Cursor / Codex — it installs the MCP server itself</Text>
          </TouchableOpacity>

          <Text style={[styles.snippetsHeader, { color: c.textSecondary }]}>Or paste a config snippet manually</Text>

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
              onPress={() => void Linking.openURL(guideUrl)}
              activeOpacity={0.7}
            >
              <Text style={[styles.btnText, { color: c.textPrimary }]}>Full guide</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}
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

  // Hero CTA — "Copy setup prompt for AI agent"
  heroBtn: {
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: 10,
    alignItems: 'center',
    marginBottom: 10,
  },
  heroBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  heroBtnSub: { color: 'rgba(255,255,255,0.85)', fontSize: 12, marginTop: 2 },

  // Always-visible guide link
  guideLinkRow: {
    paddingVertical: 8,
    paddingHorizontal: 4,
    marginBottom: 6,
  },
  guideLinkText: { fontSize: 14, fontWeight: '600' },
  guideLinkUrl: { fontSize: 11, marginTop: 2 },

  divider: { height: StyleSheet.hairlineWidth, marginVertical: 12 },

  // Advanced disclosure
  advancedToggle: {
    paddingVertical: 6,
    paddingHorizontal: 2,
  },
  advancedToggleText: {
    fontSize: 13,
    fontWeight: '600',
  },
  advancedBody: {
    marginTop: 10,
  },
  oneShotBtn: {
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 11,
    paddingHorizontal: 12,
    alignItems: 'center',
    marginBottom: 12,
  },
  oneShotText: { fontSize: 13, fontWeight: '700' },
  oneShotSub: { fontSize: 11, marginTop: 2, textAlign: 'center' },
  snippetsHeader: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginBottom: 10,
  },

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
