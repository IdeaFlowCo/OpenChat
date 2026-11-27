import React, { useState } from 'react';
import { Linking, Platform, Text, TouchableOpacity, View } from 'react-native';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';
import { space, type } from '../theme/tokens';
import { claudeConnectorUrl, IDEAFLOW_MCP_URL, openInSystemBrowser } from '../utils/claudeConnector';

export const AGENT_HUB_URL = 'https://id.ideaflow.app/agents';
/** One shared door; a key on this device is not evidence of an OAuth connection. */
export function ConnectAgentLink({ detail = false }: { detail?: boolean }) {
  const { scheme } = useTheme();
  const c = getColors(scheme);
  const [error, setError] = useState(false);
  const [claudeError, setClaudeError] = useState(false);
  const connectClaude = () => {
    setClaudeError(false);
    void openInSystemBrowser(claudeConnectorUrl(), Platform.OS).then(opened => { if (!opened) setClaudeError(true); });
  };
  return <View>
    <TouchableOpacity accessibilityRole="link" accessibilityLabel="Connect an agent" onPress={() => { setError(false); void Linking.openURL(AGENT_HUB_URL).catch(() => setError(true)); }} style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: 16, paddingVertical: 10 }}>
      <Text style={{ color: c.primary, fontSize: 14, fontWeight: '600' }}>Connect an agent ↗</Text>
      {detail && <Text style={{ color: c.textMetadata, fontSize: 13, marginTop: 4 }}>One connection for OpenChat, Unlinked, and Notestream Vision</Text>}
    </TouchableOpacity>
    {error && <Text accessibilityRole="alert" style={{ color: c.danger, paddingHorizontal: 16 }}>Could not open agent setup. Try again.</Text>}
    {detail && <>
      {/* One tap to Claude's Add custom connector dialog, prefilled; the person still clicks Add and approves on Ideaflow ID. */}
      <TouchableOpacity accessibilityRole="link" accessibilityLabel="Connect Claude" accessibilityHint="Opens Claude in your browser with the Ideaflow connector filled in" onPress={connectClaude} style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: space[4], paddingVertical: space[2] }}>
        <Text style={{ color: c.primary, ...type.label, fontWeight: '600' }}>Connect Claude ↗</Text>
        <Text style={{ color: c.textMetadata, ...type.label, marginTop: space[1] }}>Opens Claude with the Ideaflow connector filled in. Click Add, then approve.</Text>
      </TouchableOpacity>
      {claudeError && <Text selectable accessibilityRole="alert" style={{ color: c.danger, ...type.label, paddingHorizontal: space[4] }}>Could not open Claude. In Claude, go to Settings, Connectors, Add custom connector, and paste {IDEAFLOW_MCP_URL}</Text>}
      <Text selectable style={{ color: c.textMetadata, ...type.meta, paddingHorizontal: space[4], paddingBottom: space[2] }}>ChatGPT: where your plan allows custom connectors, add {IDEAFLOW_MCP_URL}.</Text>
    </>}
  </View>;
}
