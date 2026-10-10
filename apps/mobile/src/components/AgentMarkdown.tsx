/**
 * Renders an agent's message with the small Markdown subset in
 * utils/agentMarkdown.ts (OpenChat-eo3n.5). Used for bot senders only; people's
 * messages keep their exact characters.
 */
import { Fragment, useMemo, type ReactNode } from 'react';
import { Linking, Platform, StyleSheet, Text, View } from 'react-native';
import { parseAgentMarkdown, type Inline } from '../utils/agentMarkdown';
import { radius, space, type } from '../theme/tokens';

const mono = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'ui-monospace, SFMono-Regular, Menlo, monospace' });

export function AgentMarkdown({ content, color, linkColor, codeBackground, renderText, onLongPress }: {
  content: string; color: string; linkColor: string; codeBackground: string;
  /** Styles plain text runs, e.g. @mentions in a group. */
  renderText?: (text: string) => ReactNode;
  /** The bubble's long-press, so links still open the message menu. */
  onLongPress?: () => void;
}) {
  const blocks = useMemo(() => parseAgentMarkdown(content), [content]);

  const inline = (nodes: Inline[], key = 'i'): ReactNode => nodes.map((node, index) => {
    const k = `${key}.${index}`;
    switch (node.t) {
      case 'text': return <Fragment key={k}>{renderText ? renderText(node.v) : node.v}</Fragment>;
      case 'bold': return <Text key={k} style={styles.bold}>{inline(node.c, k)}</Text>;
      case 'italic': return <Text key={k} style={styles.italic}>{inline(node.c, k)}</Text>;
      case 'code': return <Text key={k} style={[styles.code, { backgroundColor: codeBackground }]}>{node.v}</Text>;
      case 'link': return (
        <Text key={k} accessibilityRole="link" style={[styles.link, { color: linkColor }]} onPress={() => { void Linking.openURL(node.href).catch(() => {}); }} onLongPress={onLongPress}>
          {inline(node.c, k)}
        </Text>
      );
    }
  });

  return (
    <View style={styles.root}>
      {blocks.map((block, index) => {
        const key = `b${index}`;
        switch (block.t) {
          case 'p': return <Text key={key} style={[styles.body, { color }]}>{inline(block.c, key)}</Text>;
          case 'heading': return <Text key={key} style={[styles.body, styles.bold, { color }]} accessibilityRole="header">{inline(block.c, key)}</Text>;
          case 'quote': return <Text key={key} style={[styles.body, styles.quote, { color, borderLeftColor: codeBackground }]}>{inline(block.c, key)}</Text>;
          case 'code': return (
            <View key={key} style={[styles.codeBlock, { backgroundColor: codeBackground }]}>
              <Text style={[styles.codeText, { color }]}>{block.v}</Text>
            </View>
          );
          case 'list': return (
            <View key={key} style={styles.list}>
              {block.items.map((item, i) => (
                <View key={`${key}.${i}`} style={styles.item}>
                  <Text style={[styles.body, styles.marker, { color }]}>{block.ordered ? `${block.start + i}.` : '•'}</Text>
                  <Text style={[styles.body, styles.itemText, { color }]}>{inline(item, `${key}.${i}`)}</Text>
                </View>
              ))}
            </View>
          );
        }
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: space[2] },
  body: { ...type.bubble },
  bold: { fontWeight: '700' },
  italic: { fontStyle: 'italic' },
  link: { textDecorationLine: 'underline' },
  code: { fontFamily: mono, fontSize: type.label.fontSize, borderRadius: radius.sm },
  codeBlock: { borderRadius: radius.sm, paddingHorizontal: space[2], paddingVertical: space[2] - 2 },
  codeText: { fontFamily: mono, ...type.label },
  quote: { borderLeftWidth: 3, paddingLeft: space[2] },
  list: { gap: space[1] },
  item: { flexDirection: 'row', gap: space[2] },
  marker: { minWidth: 16 },
  itemText: { flex: 1, minWidth: 0 },
});
