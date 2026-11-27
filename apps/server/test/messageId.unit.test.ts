import { expect, it } from 'vitest';
import { parseClientMessageId } from '../src/services/messageId.js';

it('lets the server assign an id when none is offered', () => {
  for (const value of [undefined, null, '']) expect(parseClientMessageId(value)).toEqual({ ok: true, id: null });
});

it('accepts the ids clients generate (UUID, nanoid) and nothing that could address another namespace', () => {
  expect(parseClientMessageId('3f2b6c1e-8a4d-4f0e-9b7a-2c5d1e6f7a8b')).toEqual({ ok: true, id: '3f2b6c1e-8a4d-4f0e-9b7a-2c5d1e6f7a8b' });
  expect(parseClientMessageId('V1StGXR8_Z5jdHi6B-myT')).toEqual({ ok: true, id: 'V1StGXR8_Z5jdHi6B-myT' });
  expect(parseClientMessageId('m1')).toEqual({ ok: true, id: 'm1' });
  for (const value of [
    'x'.repeat(65), 'has space in it', 'semi;colon-id', 'ünïcödé-id-value', "quote'-id-value", 12345678, { id: 'object-id' }, ['array-id-value'],
    `ocd_${'a'.repeat(40)}`, `ocu_${'a'.repeat(40)}`, 'local-12345678',
  ]) {
    expect(parseClientMessageId(value), String(value)).toMatchObject({ ok: false });
  }
});
