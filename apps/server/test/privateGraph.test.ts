import { describe, expect, it } from 'vitest';
import {
  cleanRelation, cleanText, intervalAfterContact, LIMITS, nameKey, nextDue, parseCardPatch, parseLinkTarget, PrivateGraphError,
} from '../src/services/privateGraph.js';

const status = (run: () => unknown) => { try { run(); return 200; } catch (error) { return error instanceof PrivateGraphError ? error.status : 500; } };

describe('private graph input rules', () => {
  it('keeps notes and names as written, minus control characters, within their limits', () => {
    expect(cleanText('  Met at the\u0000 dinner\nfollow up  ', LIMITS.noteLength, 'Note')).toBe('Met at the dinner\nfollow up');
    expect(status(() => cleanText('   ', 10, 'Note'))).toBe(400);
    expect(status(() => cleanText(42, 10, 'Note'))).toBe(400);
    expect(status(() => cleanText('x'.repeat(LIMITS.noteLength + 1), LIMITS.noteLength, 'Note'))).toBe(400);
    expect(cleanRelation('  Works   AT ')).toBe('works at');
    expect(nameKey('  Ａcme   Robotics ')).toBe('acme robotics');
  });

  it('accepts only known card fields with valid values', () => {
    expect(parseCardPatch({ important: true, cadenceDays: 30, cadenceMode: 'expanding', contactedNow: true }))
      .toEqual({ important: true, cadenceDays: 30, cadenceMode: 'expanding', contactedNow: true });
    expect(parseCardPatch({ cadenceDays: null })).toEqual({ cadenceDays: null });
    for (const body of [null, [], {}, { ownerId: 'someone-else' }, { important: 'yes' }, { cadenceDays: 0 }, { cadenceDays: 1.5 }, { cadenceDays: LIMITS.cadenceDays + 1 }, { cadenceMode: 'weekly' }, { contactedNow: false }]) {
      expect(status(() => parseCardPatch(body))).toBe(400);
    }
  });

  it('links to a person by id, or to a company, idea, project or person by id or name', () => {
    expect(parseLinkTarget({ kind: 'user', id: 'u1', name: 'ignored' })).toEqual({ kind: 'user', id: 'u1' });
    expect(parseLinkTarget({ kind: 'idea', name: '  Open graph  ' })).toEqual({ kind: 'idea', name: 'Open graph' });
    expect(parseLinkTarget({ kind: 'company', id: 'thing-1' })).toEqual({ kind: 'company', id: 'thing-1' });
    for (const target of [null, 'idea', { kind: 'user' }, { kind: 'planet', name: 'Mars' }, { kind: 'idea' }, { kind: 'idea', name: 'x'.repeat(LIMITS.nameLength + 1) }]) {
      expect(status(() => parseLinkTarget(target))).toBe(400);
    }
  });
});

describe('catch-up cadence', () => {
  const anchor = '2026-01-01T00:00:00.000Z';
  it('counts from the last catch-up, or from when the cadence was set', () => {
    expect(nextDue({ cadenceDays: null, intervalDays: null, lastContactAt: null }, anchor)).toBeNull();
    expect(nextDue({ cadenceDays: 7, intervalDays: null, lastContactAt: null }, anchor)).toBe('2026-01-08T00:00:00.000Z');
    expect(nextDue({ cadenceDays: 7, intervalDays: 11, lastContactAt: '2026-02-01T00:00:00.000Z' }, anchor)).toBe('2026-02-12T00:00:00.000Z');
  });

  it('keeps a fixed gap, and stretches an expanding one after each catch-up up to a year', () => {
    expect(intervalAfterContact({ cadenceDays: 30, cadenceMode: 'fixed', intervalDays: 30 }, true)).toBe(30);
    expect(intervalAfterContact({ cadenceDays: null, cadenceMode: 'expanding', intervalDays: null }, true)).toBeNull();
    // The first catch-up starts the clock at the base gap; later ones stretch it.
    expect(intervalAfterContact({ cadenceDays: 30, cadenceMode: 'expanding', intervalDays: 30 }, false)).toBe(30);
    expect(intervalAfterContact({ cadenceDays: 30, cadenceMode: 'expanding', intervalDays: 30 }, true)).toBe(48);
    expect(intervalAfterContact({ cadenceDays: 30, cadenceMode: 'expanding', intervalDays: 300 }, true)).toBe(365);
  });
});
