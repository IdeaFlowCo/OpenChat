import React from 'react';
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
const openURL = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('react-native', async () => {
  const React = await import('react');
  const host = (name: string) => ({ children, ...props }: any) => React.createElement(name, props, children);
  return { Platform: { OS: 'ios', select: (v: any) => v.ios ?? v.default }, StyleSheet: { create: (s: unknown) => s }, Linking: { openURL }, Text: host('Text'), View: host('View') };
});
import { AgentMarkdown } from '../../mobile/src/components/AgentMarkdown.js';
const textOf = (node: any): string => node.children.map((c: any) => (typeof c === 'string' ? c : textOf(c))).join('');

describe('agent message Markdown (OpenChat-eo3n.5)', () => {
  it('renders bold, a list and a tappable link without literal Markdown', async () => {
    let root!: ReturnType<typeof create>;
    await act(async () => { root = create(React.createElement(AgentMarkdown, { content: '**Board created.**\n\n1. Open https://worldissuetracker.com/b/42.\n2. Share it', color: '#111111', linkColor: '#b3541e', codeBackground: '#eeeeee' })); });
    const json = JSON.stringify(root.toJSON());
    expect(json).not.toContain('**');
    const bold = root.root.findAll(n => n.type === 'Text' && n.props.style?.fontWeight === '700');
    expect(bold.some(n => textOf(n) === 'Board created.')).toBe(true);
    expect(json).toContain('"1."');
    const link = root.root.find(n => n.type === 'Text' && n.props.accessibilityRole === 'link');
    await act(async () => link.props.onPress());
    expect(openURL).toHaveBeenCalledWith('https://worldissuetracker.com/b/42');
  });
});
