import React, { useState } from 'react';
import { Linking, Text, TouchableOpacity, View } from 'react-native';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';

export const AGENT_HUB_URL = 'https://id.ideaflow.app/agents';
/** One shared door; a key on this device is not evidence of an OAuth connection. */
export function ConnectAgentLink({ detail = false }: { detail?: boolean }) {
  const { scheme } = useTheme();
  const c = getColors(scheme);
  const [error, setError] = useState(false);
  return <View>
    <TouchableOpacity accessibilityRole="link" accessibilityLabel="Connect an agent" onPress={() => { setError(false); void Linking.openURL(AGENT_HUB_URL).catch(() => setError(true)); }} style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: 16, paddingVertical: 10 }}>
      <Text style={{ color: c.primary, fontSize: 14, fontWeight: '600' }}>Connect an agent ↗</Text>
      {detail && <Text style={{ color: c.textMetadata, fontSize: 13, marginTop: 4 }}>One connection for OpenChat, Unlinked, and Notestream Vision</Text>}
    </TouchableOpacity>
    {error && <Text accessibilityRole="alert" style={{ color: c.danger, paddingHorizontal: 16 }}>Could not open agent setup. Try again.</Text>}
  </View>;
}
