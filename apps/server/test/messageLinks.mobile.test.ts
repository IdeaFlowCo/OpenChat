import React from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { messageLinks, preserveBrowserMenu, safeMessageUrl } from '../../mobile/src/utils/messageLinks.js';

const os = vi.hoisted(() => ({ platform: 'ios', open: vi.fn(), alert: vi.fn(), copy: vi.fn() }));
vi.mock('react-native', () => ({
  Platform: { get OS() { return os.platform; } }, Alert: { alert: os.alert }, Linking: { openURL: os.open },
  StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1 }, Image: 'Image',
  Text: 'Text', View: 'View', ScrollView: 'ScrollView', TouchableOpacity: 'TouchableOpacity',
}));
vi.mock('expo-clipboard', () => ({ setStringAsync: os.copy }));
import { MessageText, openMessageLink } from '../../mobile/src/components/MessageText.js';
import { LinkPreviewCard } from '../../mobile/src/components/LinkPreviewCard.js';
import { MessageLinkActions } from '../../mobile/src/components/MessageLinkActions.js';
let screen: ReturnType<typeof create>;
beforeEach(() => { vi.clearAllMocks(); os.platform = 'ios'; os.open.mockResolvedValue(undefined); os.copy.mockResolvedValue(true); });
afterEach(async () => { if (screen) await act(async () => screen.unmount()); vi.unstubAllGlobals(); });

describe('message URL detection', () => {
  it.each([
    ['Visit (https://example.com/a(b)). Next www.example.org/path!,', ['https://example.com/a(b)', 'https://www.example.org/path']],
    ['https://example.com?q=one&x=two#part\nHTTP://EXAMPLE.COM/test', ['https://example.com?q=one&x=two#part', 'HTTP://EXAMPLE.COM/test']],
    ['[https://example.com/a] “https://example.org/b”', ['https://example.com/a', 'https://example.org/b']],
    ['javascript:https://example.com data:https://example.com file:///tmp/test foo@www.example.com ftp://www.example.com', []],
    ['https://user:password@example.com https:// https://bad:port https://example.com\\evil', []],
  ])('detects usable destinations and preserves text: %s', (content, expected) => {
    const links = messageLinks(content);
    expect(links.map(x => x.url)).toEqual(expected);
    for (const link of links) expect(content.slice(link.start, link.end)).toBe(link.text);
  });
  it.each(['javascript:alert(1)', 'data:text/html,hi', 'file:///etc/passwd', 'intent://example', '//example.com', 'https://evil\n.com', 'https://user@example.com'])('does not open %s', async url => {
    expect(safeMessageUrl(url)).toBeNull(); await openMessageLink(url); expect(os.open).not.toHaveBeenCalled();
  });
});

it.each(['ios', 'android'])('opens a native link on tap, suppresses activation after long press on %s', async platform => {
  os.platform = platform; const hold = vi.fn();
  await act(async () => { screen = create(React.createElement(MessageText, { content: 'Hi https://example.com.', color: '#000', onLongPress: hold })); });
  expect(screen.root.findAllByType('Text')[0].props.selectable).toBe(true);
  const link = screen.root.findByProps({ accessibilityRole: 'link' });
  const event = { stopPropagation: vi.fn() };
  await act(async () => { link.props.onPressIn(); link.props.onPress(event); });
  expect(os.open).toHaveBeenCalledWith('https://example.com'); os.open.mockClear();
  await act(async () => { link.props.onPressIn(); link.props.onLongPress(); link.props.onPress(event); });
  expect(hold).toHaveBeenCalledOnce(); expect(os.open).not.toHaveBeenCalled();
  await act(async () => { link.props.onPressIn(); link.props.onPress(event); });
  expect(os.open).toHaveBeenCalledOnce();
});

it('keeps browser links, selection and native context menus', async () => {
  os.platform = 'web';
  await act(async () => { screen = create(React.createElement(MessageText, { content: 'https://example.com', color: '#000', onLongPress: vi.fn() })); });
  const link = screen.root.findByProps({ accessibilityRole: 'link' });
  expect(link.props.href).toBe('https://example.com'); expect(link.props.hrefAttrs.rel).toBe('noopener noreferrer');
  const event = { stopPropagation: vi.fn(), preventDefault: vi.fn() };
  vi.stubGlobal('getSelection', () => ({ toString: () => 'selected words' }));
  link.props.onPress(event); expect(event.preventDefault).toHaveBeenCalledOnce(); expect(os.open).not.toHaveBeenCalled();
  expect(preserveBrowserMenu(null, 'selection')).toBe(true);
  expect(preserveBrowserMenu({ closest: () => ({}) } as any, '')).toBe(true);
  expect(preserveBrowserMenu(null, '')).toBe(false);
});

it('offers distinct accessible open/copy actions, deduplicates destinations and reports copy failures', async () => {
  await act(async () => { screen = create(React.createElement(MessageLinkActions, { content: 'www.example.com www.example.com https://example.org', color: '#000', borderColor: '#ddd' })); });
  const buttons = screen.root.findAllByType('TouchableOpacity'); expect(buttons).toHaveLength(4);
  expect(buttons[0].props.accessibilityLabel).toBe('Open link: www.example.com');
  await act(async () => buttons[0].props.onPress()); expect(os.open).toHaveBeenCalledWith('https://www.example.com');
  await act(async () => buttons[1].props.onPress()); expect(os.copy).toHaveBeenCalledWith('https://www.example.com');
  expect(screen.root.findByProps({ role: 'status' }).props.children).toBe('Link copied');
  os.copy.mockResolvedValueOnce(false); await act(async () => buttons[1].props.onPress());
  expect(screen.root.findByProps({ role: 'status' }).props.children).toBe('Could not copy link');
  os.copy.mockRejectedValueOnce(new Error('denied')); await act(async () => buttons[1].props.onPress());
  expect(screen.root.findByProps({ role: 'status' }).props.children).toBe('Could not copy link');
});
it('reports open failures without an unhandled rejection', async () => {
  os.open.mockRejectedValueOnce(new Error('no handler')); await openMessageLink('https://example.com'); expect(os.alert).toHaveBeenCalledOnce();
});

it('does not expose unsafe preview destinations as an alternate link action', async () => {
  await act(async () => { screen = create(React.createElement(LinkPreviewCard, { preview: { url: 'javascript:alert(1)', title: 'Unsafe' }, isOwn: false, scheme: 'light' })); });
  expect(screen.toJSON()).toBeNull(); expect(os.open).not.toHaveBeenCalled();
});
