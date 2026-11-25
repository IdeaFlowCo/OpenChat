/**
 * Body text for Stream cards and Back channel posts, by the same link rules as
 * a chat bubble (utils/richLinks.ts): web addresses and [label](address) open;
 * a file location on someone's computer is a path to copy, never a link.
 */
import React, { useMemo } from 'react';
import { StyleSheet, Text, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import { linkParts } from '../utils/richLinks';
import { useLinksAsTyped } from '../services/linkDisplay';
import { InlineLink } from './MessageText';
import { PathChip } from './PathChip';
import { space, type } from '../theme/tokens';
import { paragraphs } from '../utils/streamScope';

export function StreamText({ content, color, linkColor, pathBackground, style, numberOfLines, selectable = true, onLongPress }: {
  content: string; color: string; linkColor: string; pathBackground: string;
  style?: StyleProp<TextStyle>; numberOfLines?: number; selectable?: boolean;
  /** The card's own long-press, so holding a link opens the card's actions instead of the link. */
  onLongPress: () => void;
}) {
  const [asTyped] = useLinksAsTyped();
  // Runs of blank lines become one small gap between paragraphs. A clamped card
  // (numberOfLines) stays a single text so the clamp counts real lines.
  const blocks = useMemo(() => {
    if (asTyped) return [[{ t: 'text' as const, source: content }]];
    const paras = paragraphs(content);
    return numberOfLines ? [linkParts(paras.join('\n'))] : paras.map(para => linkParts(para));
  }, [content, asTyped, numberOfLines]);
  const line = (parts: (typeof blocks)[number], key: number) => <Text key={key} selectable={selectable} numberOfLines={numberOfLines}
    style={[type.body, { color }, blocks.length > 1 ? (key ? styles.next : null) : style]}>
    {parts.map((part, index) => part.t === 'link'
      ? <InlineLink key={`link-${part.start}`} text={part.label} url={part.url} color={linkColor} onLongPress={onLongPress} />
      : part.t === 'path'
        ? <PathChip key={`path-${part.start}`} label={part.label} path={part.path} color={linkColor} background={pathBackground} onLongPress={onLongPress} />
        : <React.Fragment key={`text-${index}`}>{part.source}</React.Fragment>)}
  </Text>;
  return blocks.length > 1 ? <View style={style as StyleProp<ViewStyle>}>{blocks.map(line)}</View> : line(blocks[0]!, 0);
}

const styles = StyleSheet.create({ next: { marginTop: space[1] + 2 } });
