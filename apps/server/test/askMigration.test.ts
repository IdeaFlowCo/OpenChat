import { describe, expect, it } from 'vitest';
import { parseFriendAskNote } from '../src/services/askMigration.js';

// Synthetic notes in the two shapes the friends'-asks monitor wrote (2026-10-29 .. 11-03).
describe('friend-ask note parsing', () => {
  it('reads the multi-line key: value shape', () => {
    const note = [
      '[friend-ask v1]',
      'ask: Recommendations for a physio in Oakland for a sore shoulder.',
      'category: health / recommendation',
      'source: Facebook post (friends audience), seen 2026-10-29, posted ~2026-10-28',
      'staleness: semi-evergreen (chronic) — recheck after 2026-12-29',
      'status: open',
      'replies so far (2): swimming; yoga.',
    ].join('\n');
    expect(parseFriendAskNote(note)).toEqual({
      text: 'Recommendations for a physio in Oakland for a sore shoulder.', horizon: 'medium', recheckAfter: '2026-12-29', status: 'open',
      label: 'Facebook post (friends audience), seen 2026-10-29, posted ~2026-10-28', seenAt: '2026-10-29', url: null,
    });
  });

  it('reads the one-line staleness=… · text shape, keeping the first link as evidence', () => {
    const note = '[friend-ask v1] staleness=evergreen · Wants resources for a long-term condition; keep private. Details: https://example.test/tracker/x (unlisted).';
    expect(parseFriendAskNote(note)).toEqual({
      text: 'Wants resources for a long-term condition; keep private. Details: https://example.test/tracker/x (unlisted).', horizon: 'evergreen', recheckAfter: null,
      status: 'open', label: 'Friend ask note', seenAt: null, url: 'https://example.test/tracker/x',
    });
  });

  it('ignores other notes and empty asks, and caps long text', () => {
    expect(parseFriendAskNote('[source-registry v1] sources')).toBeNull();
    expect(parseFriendAskNote('[friend-ask v1]')).toBeNull();
    expect(parseFriendAskNote(`[friend-ask v1] staleness=short · ${'x'.repeat(1500)}`)!.text).toHaveLength(1000);
    expect(parseFriendAskNote('[friend-ask v1]\nask: Tickets for Friday\nstaleness: event\nstatus: fulfilled')).toMatchObject({ horizon: 'event', status: 'fulfilled' });
  });
});
