import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isLocalOnlyCapture } from '../src/utils/captureConfidentiality.ts';

test('explicit confidential labels and normalized tags remain local', () => {
  for (const label of ['SSN', 'Social security number', 'Passport number', "Driver’s license", 'Tax ID', 'Bank account', 'Routing number', 'Card number', 'Confidential']) {
    assert.equal(isLocalOnlyCapture('dummy-value', label), true);
  }
  for (const tag of ['confidential', 'CONFIDENTIAL', 'ＣＯＮＦＩＤＥＮＴＩＡＬ']) {
    assert.equal(isLocalOnlyCapture('ordinary words', '', [tag]), true);
    assert.equal(isLocalOnlyCapture(`ordinary words #${tag}`), true);
  }
});

test('identifier-like content is blocked before sending', () => {
  for (const text of ['123-45-6789', 'passport:dummy-id', 'SSN dummy-id', 'tax-id:dummy-id', 'account number:dummy-id', '4111 1111 1111 1111']) {
    assert.equal(isLocalOnlyCapture(text), true);
  }
});

test('ordinary contact details, links, notes and tags remain writable', () => {
  for (const [text, label] of [['42 Example Lane', 'Mailing address'], ['Apartment 3', 'Address'], ['555-0100', 'Phone'], ['October 9', 'Birthday'], ['https://example.test/article #reading', ''], ['A new idea #longevity', '']]) {
    assert.equal(isLocalOnlyCapture(text, label), false);
  }
});
