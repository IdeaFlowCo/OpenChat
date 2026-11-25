/**
 * Body text for Stream cards and Back channel posts. Web addresses open the
 * same way they do in a chat bubble (one link implementation, MessageText's);
 * a file location on someone's computer is shown as a path, never as a link.
 */
import React, { useMemo } from 'react';
import { Platform, Text, type StyleProp, type TextStyle } from 'react-native';
import { streamTextParts } from '../utils/streamText';
import { InlineLink } from './MessageText';
import { radius, type } from '../theme/tokens';

const mono = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'ui-monospace, SFMono-Regular, Menlo, monospace' });

export function StreamText({ content, color, linkColor, pathBackground, style, numberOfLines, selectable = true, onLongPress }: {
  content: string; color: string; linkColor: string; pathBackground: string;
  style?: StyleProp<TextStyle>; numberOfLines?: number; selectable?: boolean;
  /** The card's own long-press, so holding a link opens the card's actions instead of the link. */
  onLongPress: () => void;
}) {
  const parts = useMemo(() => streamTextParts(content), [content]);
  return <Text selectable={selectable} numberOfLines={numberOfLines} style={[type.body, { color }, style]}>
    {parts.map((part, index) => part.t === 'link'
      ? <InlineLink key={`link-${part.start}`} text={part.text} url={part.url} color={linkColor} onLongPress={onLongPress} />
      : part.t === 'path'
        ? <Text key={`path-${index}`} accessibilityLabel={`File path, not a link: ${part.text}`}
            style={{ fontFamily: mono, fontSize: type.label.fontSize, backgroundColor: pathBackground, borderRadius: radius.sm }}>{part.text}</Text>
        : <React.Fragment key={`text-${index}`}>{part.text}</React.Fragment>)}
  </Text>;
}
