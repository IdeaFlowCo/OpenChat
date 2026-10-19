import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AppRegistry } from 'react-native-web';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

// The Expo app is client-rendered. Supply an SSR snapshot only in this
// static evidence harness, preserving the store's actual current state.
vi.mock('react', async (original) => {
  const react = await original<typeof import('react')>();
  return { ...react, useSyncExternalStore: (subscribe: any, snapshot: any) => react.useSyncExternalStore(subscribe, snapshot, snapshot) };
});
vi.mock('react-native', async () => await import('react-native-web'));
vi.mock('../../mobile/src/contexts/ThemeContext', () => ({ useTheme: () => ({ scheme: 'light' }) }));
vi.mock('../../mobile/src/contexts/ChatContext', () => ({ useChat: () => ({ currentUser: { userId: 'viewer' } }) }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: async () => null, setItem: async () => undefined } }));
vi.mock('../../mobile/src/api/client', () => ({ api: { setThoughtCollapsed: vi.fn() } }));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }));
// Native SVG requires Metro; the evidence retains the control's real label.
vi.mock('../../mobile/src/components/AppIcon', () => ({ AppIcon: () => null }));

import { ThoughtCard } from '../../mobile/src/components/ThoughtCard';
import { StreamCompactToggle } from '../../mobile/src/components/StreamCompactToggle';
import { isLongStreamText } from '../../mobile/src/services/streamDisplay';

it('renders actual Stream cards with default compact clamping and saved collapse', () => {
  const text = 'Review the event plan\nConfirm the venue\nInvite the speakers\nPublish the schedule\nCheck accessibility\nSend the follow up\nShare the recording';
  const item = { id: 'entry', text, tags: ['event'], kind: 'observation' as const, status: 'none' as const, createdAt: '2026-10-18T12:00:00Z', updatedAt: '2026-10-18T12:00:00Z' };
  expect(isLongStreamText('x'.repeat(399))).toBe(false);
  expect(isLongStreamText('x'.repeat(400))).toBe(true);
  expect(isLongStreamText('a\nb\nc\nd\ne')).toBe(false);
  expect(isLongStreamText('a\nb\nc\nd\ne\nf')).toBe(true);
  const Surface = () => React.createElement(React.Fragment, null, React.createElement(StreamCompactToggle), React.createElement(ThoughtCard, { item, onOpenContext: () => undefined }), React.createElement(ThoughtCard, { item: { ...item, id: 'collapsed', collapsed: true } }));
  AppRegistry.registerComponent('StreamEvidence', () => Surface);
  const { element, getStyleElement } = AppRegistry.getApplication('StreamEvidence', {});
  const markup = renderToStaticMarkup(element);
  expect(markup).toContain('Show more');
  expect(markup).toContain('Original message');
  expect(markup).toContain('aria-label="Expand entry"');
  expect(markup).toContain('-webkit-line-clamp:4');
  const dir = process.env.OPENCHAT_STREAM_EVIDENCE_DIR;
  if (dir) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'stream-cards.html'), `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${renderToStaticMarkup(getStyleElement())}<style>body{margin:0;background:#faf9f6}main{max-width:390px;padding:20px;margin:auto}h1{font:600 20px system-ui}</style></head><body><main><h1>Stream · Compact and collapsed</h1>${markup}</main></body></html>`);
  }
});
