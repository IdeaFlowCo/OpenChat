import React from 'react';
import { act, create, type ReactTestRendererJSON } from 'react-test-renderer';
import { renderToStaticMarkup } from 'react-dom/server';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  ownerId: 'owner-a', focus: 0, navigate: vi.fn(),
  api: { listPrivateThings: vi.fn(), listFriends: vi.fn() },
}));
vi.mock('../../mobile/src/api/client', () => ({ api: fixture.api }));
vi.mock('react-native', async () => await import('react-native-web'));
vi.mock('@react-navigation/native', async () => {
  const React = await import('react');
  return {
    useNavigation: () => ({ navigate: fixture.navigate }), useRoute: () => ({ params: {} }),
    useFocusEffect: (effect: () => void) => React.useEffect(effect, [effect, fixture.focus]),
  };
});
vi.mock('../../mobile/src/contexts/ChatContext', () => ({ useChat: () => ({ currentUser: { userId: fixture.ownerId } }) }));
vi.mock('../../mobile/src/contexts/ThemeContext', () => ({ useTheme: () => ({ scheme: 'light' }) }));
vi.mock('../../mobile/src/components/Avatar', () => ({ Avatar: () => null }));
vi.mock('../../mobile/src/components/AppIcon', () => ({ AppIcon: () => null }));
import { AppRegistry, FlatList } from 'react-native-web';
import { Button } from '../../mobile/src/components/ui/Button';
import { FriendsScreen } from '../../mobile/src/screens/FriendsScreen';

let root: ReturnType<typeof create> | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
  vi.resetAllMocks();
  fixture.ownerId = 'owner-a'; fixture.focus = 0;
});

it('shows complete and incomplete People, resumes through the visible Retry control, opens the last profile and isolates account changes', async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  fixture.api.listFriends.mockResolvedValue({ friends: [], incoming: [], outgoing: [] });
  const person = (id: number) => ({ id: String(id), kind: 'person', name: `Synthetic person ${id}` });
  const pages = (total: number) => async (_q: unknown, _kind: unknown, { after, limit }: { after?: string; limit: number }) => {
    const start = Number(after ?? 0), end = Math.min(start + limit, total);
    return { things: Array.from({ length: end - start }, (_, i) => person(start + i)), total, nextCursor: end < total ? String(end) : null };
  };
  const captures: string[] = [];
  function capture(title: string) {
    // Serialize the host elements produced by the real RNW renderer, rather
    // than mounting RNW contexts in two different React renderers at once.
    function host(node: ReactTestRendererJSON | string): React.ReactNode {
      if (typeof node === 'string') return node;
      return React.createElement(node.type, node.props, ...(node.children ?? []).map(host));
    }
    const tree = root!.toJSON()!;
    const markup = renderToStaticMarkup(React.createElement(React.Fragment, null, ...(Array.isArray(tree) ? tree : [tree]).map(host)));
    AppRegistry.registerComponent('PeopleEvidence', () => () => null);
    const application = AppRegistry.getApplication('PeopleEvidence', {});
    const css = renderToStaticMarkup(application.getStyleElement());
    captures.push(`<section><h2>${title}</h2>${css}<div class="screen">${markup}</div></section>`);
    return markup;
  }

  fixture.api.listPrivateThings.mockImplementation(pages(5007));
  await act(async () => { root = create(React.createElement(FriendsScreen)); });
  expect(root!.root.findByType(FlatList).props.data).toHaveLength(5007);
  expect(capture('Complete: 5,007 saved people')).toContain('5007 saved people');

  fixture.api.listPrivateThings.mockImplementation(pages(5008));
  fixture.api.listPrivateThings.mockImplementationOnce(pages(5008)).mockRejectedValueOnce(new Error('synthetic offline'));
  fixture.focus++;
  await act(async () => root!.update(React.createElement(FriendsScreen)));
  expect(root!.root.findByType(FlatList).props.data).toHaveLength(5007);
  const incomplete = capture('Interrupted refresh: prior rows retained and Retry visible');
  expect(incomplete).toContain('100 of 5008 loaded');
  expect(incomplete).toContain('Incomplete');
  expect(incomplete).toContain('Retry loading people');
  expect(incomplete).not.toContain('5007 saved people');

  fixture.api.listPrivateThings.mockClear();
  const retry = root!.root.findAllByType(Button).find(node => node.props.label === 'Retry loading people')!;
  await act(async () => retry.props.onPress());
  expect(fixture.api.listPrivateThings.mock.calls[0]).toEqual(['', 'person', { after: '100', limit: 100, summary: true }]);
  const list = root!.root.findByType(FlatList);
  expect(list.props.data).toHaveLength(5008);
  expect(capture('Retry finished: 5,008 saved people')).toContain('5008 saved people');
  const finalRow = list.props.renderItem({ item: list.props.data.at(-1), index: 5007, separators: {} });
  finalRow.props.onPress();
  expect(fixture.navigate).toHaveBeenCalledWith('PrivateThing', { thingId: '5007' });
  const mounted = root!.root.findAll(node => node.props.accessibilityLabel?.startsWith('Saved profile for'));
  expect(mounted.length).toBeGreaterThan(0);
  expect(mounted.length).toBeLessThan(100);

  fixture.ownerId = 'signed-out';
  await act(async () => root!.update(React.createElement(FriendsScreen)));
  expect(root!.root.findByType(FlatList).props.data).toEqual([]);
  const signedOut = capture('Account isolation: previous owner rows hidden on sign-out');
  expect(signedOut).not.toContain('Synthetic person');

  fixture.ownerId = 'owner-b';
  fixture.api.listPrivateThings.mockResolvedValue({ things: [{ id: 'owner-b-only', kind: 'person', name: 'Synthetic owner B contact' }], total: 1, nextCursor: null });
  await act(async () => root!.update(React.createElement(FriendsScreen)));
  expect(root!.root.findByType(FlatList).props.data.map((row: { id: string }) => row.id)).toEqual(['owner-b-only']);
  expect(capture('Other account: only its own contact')).toContain('Synthetic owner B contact');

  if (process.env.CONTACTS_UI_EVIDENCE) {
    mkdirSync(dirname(process.env.CONTACTS_UI_EVIDENCE), { recursive: true });
    writeFileSync(process.env.CONTACTS_UI_EVIDENCE,
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Saved people · Contact loading evidence — OpenChat</title><style>body{font-family:system-ui,sans-serif;margin:24px;color:#202124;background:#f4f5f7}h1{font-size:24px}h2{font-size:18px}.screen{height:820px;max-width:960px;display:flex;flex-direction:column;border:1px solid #bbb;background:white}section{margin:32px 0}</style></head><body><h1>OpenChat People: rendered product evidence</h1><p>Actual FriendsScreen output with its real pagination hook, FlatList, RN-web primitives and project theme. Synthetic API responses; navigation and app contexts are fixtures. These are static screen captures, not an authenticated browser or database run. Avatar and unused icon renderers are stubbed.</p>${captures.join('')}</body></html>`);
  }
});
