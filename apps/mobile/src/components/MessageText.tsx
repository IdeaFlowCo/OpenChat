import React, { useRef } from 'react';
import { Alert, Linking, Platform, Text } from 'react-native';
import { messageLinks, safeMessageUrl } from '../utils/messageLinks';

export async function openMessageLink(url: string): Promise<void> {
  const safe = safeMessageUrl(url);
  if (!safe) return;
  try { await Linking.openURL(safe); }
  catch { Alert.alert('Could not open link', 'You can copy the link from the message actions.'); }
}

function InlineLink({ text, url, color, onLongPress }: {
  text: string; url: string; color: string; onLongPress: () => void;
}) {
  const held = useRef(false);
  const webProps = Platform.OS === 'web' ? {
    href: url,
    hrefAttrs: { target: '_blank', rel: 'noopener noreferrer' },
  } : {};
  return <Text {...webProps} accessibilityRole="link" style={{ color, textDecorationLine: 'underline' }}
    onPressIn={Platform.OS === 'web' ? undefined : () => { held.current = false; }}
    onLongPress={Platform.OS === 'web' ? undefined : () => { held.current = true; onLongPress(); }}
    onPress={event => {
      event.stopPropagation();
      if (Platform.OS === 'web') {
        if (globalThis.getSelection?.()?.toString()) event.preventDefault();
      } else if (!held.current) void openMessageLink(url);
    }}>
    {text}
  </Text>;
}

export function MessageText({ content, color, renderPlain, onLongPress }: {
  content: string; color: string; renderPlain?: (text: string) => React.ReactNode;
  onLongPress: () => void;
}) {
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  for (const link of messageLinks(content)) {
    if (link.start > cursor) parts.push(<React.Fragment key={`text-${cursor}`}>
      {renderPlain ? renderPlain(content.slice(cursor, link.start)) : content.slice(cursor, link.start)}
    </React.Fragment>);
    parts.push(<InlineLink key={`link-${link.start}`} {...link} color={color} onLongPress={onLongPress} />);
    cursor = link.end;
  }
  const rest = content.slice(cursor);
  parts.push(<React.Fragment key={`text-${cursor}`}>{renderPlain ? renderPlain(rest) : rest}</React.Fragment>);
  return <Text selectable style={{ color, fontSize: 16 }}>{parts}</Text>;
}
