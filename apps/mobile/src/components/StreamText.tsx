/**
 * Body text for Stream cards and Back channel posts, by the same link rules as
 * a chat bubble (utils/richLinks.ts): web addresses and [label](address) open;
 * a file location on someone's computer is a path to copy, never a link.
 */
import React, { useMemo } from 'react';
import { Text, type StyleProp, type TextStyle } from 'react-native';
import { linkParts } from '../utils/richLinks';
import { useLinksAsTyped } from '../services/linkDisplay';
import { InlineLink } from './MessageText';
import { PathChip } from './PathChip';
import { type } from '../theme/tokens';

export function StreamText({ content, color, linkColor, pathBackground, style, numberOfLines, selectable = true, onLongPress }: {
  content: string; color: string; linkColor: string; pathBackground: string;
  style?: StyleProp<TextStyle>; numberOfLines?: number; selectable?: boolean;
  /** The card's own long-press, so holding a link opens the card's actions instead of the link. */
  onLongPress: () => void;
}) {
  const [asTyped] = useLinksAsTyped();
  const parts = useMemo(() => asTyped ? [{ t: 'text' as const, source: content }] : linkParts(content), [content, asTyped]);
  return <Text selectable={selectable} numberOfLines={numberOfLines} style={[type.body, { color }, style]}>
    {parts.map((part, index) => part.t === 'link'
      ? <InlineLink key={`link-${part.start}`} text={part.label} url={part.url} color={linkColor} onLongPress={onLongPress} />
      : part.t === 'path'
        ? <PathChip key={`path-${part.start}`} label={part.label} path={part.path} color={linkColor} background={pathBackground} onLongPress={onLongPress} />
        : <React.Fragment key={`text-${index}`}>{part.source}</React.Fragment>)}
  </Text>;
}
