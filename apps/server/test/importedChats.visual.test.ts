import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AppRegistry } from 'react-native-web';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

vi.mock('react', async (original) => {
  const react = await original<typeof import('react')>();
  return { ...react, useSyncExternalStore: (subscribe: any, snapshot: any) => react.useSyncExternalStore(subscribe, snapshot, snapshot) };
});
vi.mock('react-native', async () => await import('react-native-web'));
vi.mock('../../mobile/src/contexts/ThemeContext', () => ({ useTheme: () => ({ scheme: 'light' }) }));
vi.mock('@react-navigation/native', () => ({ useNavigation: () => ({}), useRoute: () => ({ params: {} }) }));
vi.mock('../../mobile/src/api/client', () => ({ api: {} }));
vi.mock('../../mobile/src/components/AppIcon', () => ({ AppIcon: () => null }));

import { AskCard, ProvenanceStrip } from '../../mobile/src/components/ImportedChatParts';
import { MessageRow } from '../../mobile/src/screens/ImportedChatScreen';

const ada = { participantId: 'pa-ada1', label: 'Ada Example', displayName: 'Ada Example', isOwner: false };
const bo = { participantId: 'pa-bo01', label: 'Bo Example', displayName: 'Bo Example', isOwner: false };
const unknown = { participantId: 'pa-ab12', label: 'Unknown participant · ab12', displayName: null, isOwner: false };
const coverage = { asOf: '2026-10-20T12:00:00.000Z', method: 'synthetic', earliestMessageAt: '2026-10-01T09:00:00.000Z', latestMessageAt: '2026-10-04T08:00:00.000Z', complete: false, note: 'Media not imported.', lastImportAt: null, importCount: 1 };
const message = (id: string, extra: Record<string, unknown>) => ({ id, sourceMessageId: id, sentAt: '2026-10-01T09:05:00.000Z', kind: 'text' as const, text: null, mediaType: null, edited: false, editedAt: null, originalText: null, deletedAtSource: null, replyToSourceMessageId: null, sender: ada, ...extra });
const source = (sender: typeof ada, text: string) => ({ sourceMessageId: `s-${sender.participantId}`, sentAt: '2026-10-01T09:05:00.000Z', sender, text, available: true });

it('renders the read-only transcript, provenance and evidenced asks', () => {
  const noop = () => undefined;
  const Surface = () => React.createElement(React.Fragment, null,
    React.createElement(ProvenanceStrip, { network: 'whatsapp', coverage }),
    React.createElement(MessageRow, { message: message('m-1', { kind: 'system', text: 'Owner Example created this group', sender: null }) as any, network: 'whatsapp', onOpenPerson: noop }),
    React.createElement(MessageRow, { message: message('m-2', { text: 'Hi all, I run a soil-health lab. Looking for a co-founder with field experience.', edited: true, editedAt: '2026-10-01T10:00:00.000Z', originalText: 'Hi all' }) as any, network: 'whatsapp', onOpenPerson: noop }),
    React.createElement(MessageRow, { message: message('m-4', { kind: 'media', mediaType: 'image', sender: unknown }) as any, network: 'whatsapp', onOpenPerson: noop }),
    React.createElement(MessageRow, { message: message('m-5', { kind: 'deleted', sender: bo }) as any, network: 'whatsapp', onOpenPerson: noop }),
    React.createElement(AskCard, { ask: { id: 'a1', text: 'Looking for a co-founder with field experience', subject: ada, subjectLabel: null, reporter: ada, sourceStatus: 'open', ownerStatus: null, status: 'open', stale: false, updatedAt: '', statusSources: [], sources: [source(ada, 'Hi all, I run a soil-health lab. Looking for a co-founder with field experience.')] } as any, onOpenPerson: noop, onSetStatus: noop }),
    React.createElement(AskCard, { ask: { id: 'a2', text: 'Looking for compost suppliers in Oakland', subject: null, subjectLabel: 'Cy', reporter: bo, sourceStatus: 'needs_review', ownerStatus: 'resolved', status: 'resolved', stale: true, updatedAt: '', statusSources: [], sources: [source(bo, 'Welcome! My friend Cy is hunting for compost suppliers in Oakland.')] } as any, onOpenPerson: noop, onSetStatus: noop }),
  );
  AppRegistry.registerComponent('ImportedEvidence', () => Surface);
  const { element, getStyleElement } = AppRegistry.getApplication('ImportedEvidence', {});
  const markup = renderToStaticMarkup(element);
  for (const text of ['Private to you · WhatsApp mirror · read-only', 'Partial history', 'Deleted by the sender on WhatsApp', 'Image · not imported', 'Show original', 'Cy · not in this chat', 'Not in latest import', 'You set this. The source shows needs review.']) expect(markup).toContain(text);
  const dir = process.env.OPENCHAT_IMPORTED_EVIDENCE_DIR;
  if (dir) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'imported-chat.html'), `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${renderToStaticMarkup(getStyleElement())}<style>body{margin:0;background:#faf9f6}main{max-width:390px;margin:auto;display:flex;flex-direction:column;gap:12px;padding-bottom:20px}</style></head><body><main>${markup}</main></body></html>`);
  }
});
