// A rider who types "2,600" means two thousand six hundred. The bot used to
// answer "please send a price" because the comma broke the number pattern.
//
//   npm -w @wheleers/api-gateway run build && node --test test/whatsapp-amounts.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCounterOffer, normalizeAmountText } = require('../apps/api-gateway/dist/http/whatsapp.route.js');

test('thousands separators and currency marks are folded away', () => {
  assert.equal(normalizeAmountText('2,600'), '2600');
  assert.equal(normalizeAmountText('₦2,600'), 'n2600');
  assert.equal(normalizeAmountText('N 2,600'), 'n2600');
  assert.equal(normalizeAmountText('2 600'), '2600');
  assert.equal(normalizeAmountText('2600.00'), '2600');
  assert.equal(normalizeAmountText('1,250,000'), '1250000');
  assert.equal(normalizeAmountText('2600 naira'), '2600');
});

test('the amount the rider typed is the amount we use', () => {
  assert.equal(parseCounterOffer('2,600'), 2600);
  assert.equal(parseCounterOffer('₦2,600'), 2600);
  assert.equal(parseCounterOffer('N2,600'), 2600);
  assert.equal(parseCounterOffer('2 600'), 2600);
  assert.equal(parseCounterOffer('2600.00'), 2600);
  assert.equal(parseCounterOffer('2600'), 2600);
  assert.equal(parseCounterOffer('2.6k'), 2600);
  assert.equal(parseCounterOffer('my offer is ₦2,600'), 2600);
  assert.equal(parseCounterOffer("I'll pay 3,500"), 3500);
  assert.equal(parseCounterOffer('how about 1,800'), 1800);
});

test('things that are not offers are still not offers', () => {
  assert.equal(parseCounterOffer('hello'), null);
  assert.equal(parseCounterOffer('12'), null);
  assert.equal(parseCounterOffer('take me to Lekki'), null);
});
