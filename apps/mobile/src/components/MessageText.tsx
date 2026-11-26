import React, { useMemo, useRef } from 'react';
import { Alert, Linking, Platform, Text } from 'react-native';
import { safeLinkUrl } from '../utils/messageLinks';
import { linkParts } from '../utils/richLinks';
import { useLinksAsTyped } from '../services/linkDisplay';
import { PathChip } from './PathChip';
import { type } from '../theme/tokens';

export async function openMessageLink(url: string): Promise<void> {
  const safe = safeLinkUrl(url);
  if (!safe) return;
  try { await Linking.openURL(safe); }
  catch { Alert.alert('Could not open link', 'You can copy the link from the message actions.'); }
}

export function InlineLink({ text, url, color, onLongPress }: {
  text: string; url: string; color: string; onLongPress: () => void;
}) {
  const held = useRef(false);
  const webProps = Platform.OS === 'web' ? {
    href: url,
    // A mail address opens the mail app; it needs no new tab.
    hrefAttrs: /^mailto:/i.test(url) ? { rel: 'noopener noreferrer' } : { target: '_blank', rel: 'noopener noreferrer' },
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
  const [asTyped] = useLinksAsTyped();
  const parts = useMemo(() => asTyped ? [{ t: 'text' as const, source: content }] : linkParts(content), [content, asTyped]);
  const plain = (text: string) => renderPlain ? renderPlain(text) : text;
  return <Text selectable style={{ ...type.bubble, color }}>
    {parts.map((part, index) => part.t === 'link'
      ? <InlineLink key={`link-${part.start}`} text={part.label} url={part.url} color={color} onLongPress={onLongPress} />
      : part.t === 'path'
        ? <PathChip key={`path-${part.start}`} label={part.label} path={part.path} color={color} background="transparent" onLongPress={onLongPress} />
        : <React.Fragment key={`text-${index}`}>{plain(part.source)}</React.Fragment>)}
    {parts.length ? null : plain('')}
  </Text>;
}
