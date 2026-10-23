import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ImportedChatError, IMPORT_LIMITS, parseImportPayload, participantLabel } from '../src/services/importedChats.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/importedChat.synthetic.json', import.meta.url), 'utf8'));
const clone = () => JSON.parse(JSON.stringify(fixture));
function errorsOf(body: unknown): Array<{ path: string; message: string }> {
  try { parseImportPayload(body); } catch (error) {
    expect(error).toBeInstanceOf(ImportedChatError);
    expect((error as ImportedChatError).status).toBe(400);
    return (error as ImportedChatError).details!.errors as Array<{ path: string; message: string }>;
  }
  throw new Error('expected the payload to be rejected');
}

describe('imported chat payload validation', () => {
  it('accepts the synthetic fixture and normalises times', () => {
    const parsed = parseImportPayload(clone());
    expect(parsed.source).toEqual({ network: 'whatsapp', accountKey: 'synthetic-owner-account', chatKey: 'synthetic-group-garden-club', chatType: 'group', title: 'Synthetic Garden Club' });
    expect(parsed.messages[0]).toMatchObject({ senderKey: null, kind: 'system' });
    expect(parsed.participants.find(p => p.sourceKey === 'p-unknown')).toMatchObject({ displayName: null, nameSource: 'unknown', profileFacts: [] });
    expect(parsed.asks[1]).toMatchObject({ subjectKey: null, subjectLabel: 'Cy', reporterKey: 'p-bo' });
    const offset = clone();
    offset.messages[1].sentAt = '2026-10-01T11:05:00+02:00';
    expect(parseImportPayload(offset).messages[1]!.sentAt).toBe('2026-10-01T09:05:00.000Z');
  });

  it('rejects messages without a source id, a time or a sender', () => {
    const body = clone();
    delete body.messages[1].sourceMessageId;
    body.messages[2].sentAt = 'last Tuesday';
    body.messages[3].senderKey = null;
    expect(errorsOf(body)).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'messages[1].sourceMessageId' }),
      expect.objectContaining({ path: 'messages[2].sentAt' }),
      { path: 'messages[3].senderKey', message: 'is required except for system messages' },
    ]));
  });

  it('rejects asks and facts without evidence and ambiguous ask subjects', () => {
    const body = clone();
    body.asks[0].sourceMessageIds = [];
    body.asks[1].subjectLabel = null;
    body.participants[1].profileFacts[0].sourceMessageIds = undefined;
    body.asks.push({ ...body.asks[0], askKey: 'both', subjectKey: 'p-ada', subjectLabel: 'Ada', sourceMessageIds: ['m-2'] });
    expect(errorsOf(body)).toEqual(expect.arrayContaining([
      { path: 'asks[0].sourceMessageIds', message: 'needs at least one source message' },
      expect.objectContaining({ path: 'asks[1].subjectKey' }),
      { path: 'participants[1].profileFacts[0].sourceMessageIds', message: 'needs at least one source message' },
      { path: 'asks[2].subjectLabel', message: 'is only for subjects who are not participants' },
    ]));
  });

  it('rejects duplicates, two owners, deleted text, bad statuses and oversized batches', () => {
    const body = clone();
    body.messages.push({ ...body.messages[1] });
    body.participants[1].isOwner = true;
    body.messages[4] = { sourceMessageId: 'm-5', senderKey: 'p-twin', sentAt: '2026-10-03T11:00:00Z', kind: 'deleted', text: 'still here' };
    body.asks[0].sourceStatus = 'done';
    body.schemaVersion = 2;
    expect(errorsOf(body).map(issue => issue.path)).toEqual(expect.arrayContaining(['schemaVersion', 'messages[6].sourceMessageId', 'participants', 'messages[4].text', 'asks[0].sourceStatus']));
    const big = clone();
    big.messages = Array.from({ length: IMPORT_LIMITS.messages + 1 }, (_, i) => ({ sourceMessageId: `m${i}`, senderKey: 'p-ada', sentAt: '2026-10-01T09:00:00Z', kind: 'text', text: 'x' }));
    expect(errorsOf(big)).toContainEqual({ path: 'messages', message: `has more than ${IMPORT_LIMITS.messages} items; send several requests` });
    expect(errorsOf(null)).toEqual([{ path: '', message: 'must be an object' }]);
  });

  it('labels unnamed participants honestly without exposing their source key', () => {
    expect(participantLabel({ id: 'abcdefgh1234', displayName: null })).toBe('Unknown participant · 1234');
    expect(participantLabel({ id: 'abcdefgh1234', displayName: 'Ada Example' })).toBe('Ada Example');
  });
});

describe('imported chats stay out of live delivery', () => {
  // Structural guard: imported data never touches the live graph, sockets, push, the agent or matching.
  const sources = ['../src/services/importedChats.ts', '../src/routes/importedChats.ts'].map(path => readFileSync(new URL(path, import.meta.url), 'utf8'));
  it('imports no delivery, agent or matching module', () => {
    for (const source of sources) {
      const imports = [...source.matchAll(/from '([^']+)'/g)].map(match => match[1]);
      expect(imports.filter(path => /websocket|socket|push|assistant|agentNetwork|agentSocial|secretary|groupbrain|webhook|context|embeddings|streamSearch|chat\.js/i.test(path!))).toEqual([]);
    }
  });
  it('never reads or writes live conversations or messages, and never creates users', () => {
    const service = sources[0]!;
    expect(service).not.toMatch(/:(Conversation|Message|Thought)\b/);
    expect(service).not.toMatch(/(CREATE|MERGE)\s*\([a-z]*:User\b/);
    expect(service).not.toMatch(/PARTICIPATES_IN/);
  });
});
