// Banks only accept letters in account names; WhatsApp profile names carry
// emoji and decorative fonts. The display name is never touched — only what we
// send to the payment provider is cleaned.
//
//   npm -w @wheleers/payments run build && node --test test/bank-names.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { bankNameParts, sanitizeBankName } = require('../packages/payments/dist/index.js');

test('plain names split into first/last unchanged', () => {
  assert.deepEqual(bankNameParts('Timilehin Olowu'), { firstName: 'Timilehin', lastName: 'Olowu' });
  assert.deepEqual(bankNameParts('Ada Obi Nwosu'), { firstName: 'Ada', lastName: 'Obi Nwosu' });
});

test('emoji are stripped, the letters survive', () => {
  assert.deepEqual(bankNameParts('Timi 🔥'), { firstName: 'Timi', lastName: 'User' });
  assert.deepEqual(bankNameParts('✨Blessing✨ Okafor💃🏾'), { firstName: 'Blessing', lastName: 'Okafor' });
  assert.deepEqual(bankNameParts('Timi🔥Olowu'), { firstName: 'Timi', lastName: 'Olowu' });
});

test('decorative unicode fonts and accents fold to ASCII', () => {
  assert.equal(sanitizeBankName('𝓣𝓲𝓶𝓲 𝓞𝓵𝓸𝔀𝓾'), 'Timi Olowu');
  assert.equal(sanitizeBankName('Adéọlá Ọ̀ṣun'), 'Adeola Osun');
  assert.equal(sanitizeBankName('Ｔｉｍｉ'), 'Timi');
});

test('nothing usable falls back to the default', () => {
  assert.deepEqual(bankNameParts('🔥🔥🔥'), { firstName: 'Wheelers', lastName: 'User' });
  assert.deepEqual(bankNameParts(''), { firstName: 'Wheelers', lastName: 'User' });
  assert.deepEqual(bankNameParts(null), { firstName: 'Wheelers', lastName: 'User' });
  assert.deepEqual(bankNameParts(undefined, { firstName: 'Wheelers', lastName: 'Driver' }), {
    firstName: 'Wheelers',
    lastName: 'Driver',
  });
  assert.deepEqual(bankNameParts('123 456'), { firstName: 'Wheelers', lastName: 'User' });
});

test('apostrophes and hyphens inside a name stay, stray punctuation goes', () => {
  assert.deepEqual(bankNameParts("O'Neil Smith-Jones"), { firstName: "O'Neil", lastName: 'Smith-Jones' });
  assert.deepEqual(bankNameParts('-- Timi --'), { firstName: 'Timi', lastName: 'User' });
  assert.deepEqual(bankNameParts('Timi. Olowu, Jr!'), { firstName: 'Timi', lastName: 'Olowu Jr' });
});

test('overlong parts are capped', () => {
  const long = 'A'.repeat(120);
  const parts = bankNameParts(`${long} ${long}`);
  assert.equal(parts.firstName.length, 50);
  assert.equal(parts.lastName.length, 50);
});
