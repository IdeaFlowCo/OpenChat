import { describe, expect, it } from 'vitest';
import { classifyContactDiscoveryQuery } from '../src/privacy/contactDiscovery.js';

describe('classifyContactDiscoveryQuery', () => {
  it.each([undefined, '', '  ', 'me', 'SELF', ' Myself '])('classifies %s as self', raw => {
    expect(classifyContactDiscoveryQuery(raw).kind).toBe('self');
  });

  it.each(['a', 'alice@', '@example.test', 'alice@example', 'alice example@test.com'])('rejects too-short or malformed input %s', raw => {
    expect(classifyContactDiscoveryQuery(raw).kind).toBe('invalid');
  });

  it('normalizes an ordinary display-name query', () => {
    expect(classifyContactDiscoveryQuery('  Alice Other  ')).toEqual({
      kind: 'name',
      normalized: 'alice other',
    });
  });

  it('normalizes a complete email address', () => {
    expect(classifyContactDiscoveryQuery('  Alice.Other@Example.TEST  ')).toEqual({
      kind: 'email',
      normalized: 'alice.other@example.test',
    });
  });
});
