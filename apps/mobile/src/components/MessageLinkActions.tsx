import { useState } from 'react';
import { ScrollView, Text, TouchableOpacity, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { messageLinks } from '../utils/messageLinks';
import { openMessageLink } from './MessageText';

export function MessageLinkActions({ content, color, borderColor }: {
  content: string; color: string; borderColor: string;
}) {
  const [status, setStatus] = useState('');
  const links = [...new Map(messageLinks(content).map(link => [link.url, link])).values()];
  return <ScrollView style={{ maxHeight: 360 }} contentContainerStyle={{ paddingHorizontal: 20 }}>
    {links.map(link => <View key={link.url} style={{ paddingVertical: 12, borderBottomWidth: 1, borderColor }}>
      <Text selectable style={{ color }}>{link.text}</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel={`Open link: ${link.text}`}
          style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: 8 }}
          onPress={() => void openMessageLink(link.url)}>
          <Text style={{ color, fontWeight: '600' }}>Open link</Text>
        </TouchableOpacity>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel={`Copy link: ${link.text}`}
          style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: 8 }}
          onPress={async () => {
            try { setStatus(await Clipboard.setStringAsync(link.url) ? 'Link copied' : 'Could not copy link'); }
            catch { setStatus('Could not copy link'); }
          }}>
          <Text style={{ color, fontWeight: '600' }}>Copy link</Text>
        </TouchableOpacity>
      </View>
    </View>)}
    <Text accessibilityLiveRegion="polite" role="status" style={{ color }}>{status}</Text>
  </ScrollView>;
}
