// Rider memory and the Nigeria geofence — the pure parts, no database.
//
//   npm -w @wheleers/api-gateway run build && node --test test/rider-memory.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const memory = require('../apps/api-gateway/dist/LLM/rider-memory.js');
const geo = require('../apps/api-gateway/dist/LLM/geocoding.js');

const DAY = 86_400_000;

function sample() {
  return {
    facts: [
      { predicate: 'home', object: '12 Adebayo Street, Surulere, Lagos', weight: 3, lastSeenAt: new Date() },
      { predicate: 'prefers_payment', object: 'WALLET', weight: 2, lastSeenAt: new Date() },
      { predicate: 'language', object: 'pidgin', weight: 1, lastSeenAt: new Date() },
      { predicate: 'frequent_place', object: 'Shoprite, Ikeja', weight: 1, lastSeenAt: new Date() },
    ],
    rides: [
      { status: 'COMPLETED', pickupAddress: 'Ikeja City Mall, Lagos', destAddress: '12 Adebayo Street, Surulere, Lagos', fareNgn: 2600, paymentMethod: 'WALLET', createdAt: new Date(Date.now() - DAY) },
      { status: 'CANCELLED', pickupAddress: 'Yaba, Lagos', destAddress: 'Lekki Phase 1, Lagos', fareNgn: null, paymentMethod: 'WALLET', createdAt: new Date(Date.now() - 3 * DAY) },
    ],
    transcript: [],
    frequentPlaces: [{ address: '12 Adebayo Street, Surulere, Lagos', count: 4 }],
  };
}

test('the chat bot sees home, payment, language and recent rides', () => {
  const text = memory.renderRiderMemory(sample());
  assert.match(text, /home: 12 Adebayo Street, Surulere, Lagos/);
  assert.match(text, /prefers to pay with: WALLET/);
  assert.match(text, /usually writes in: pidgin/);
  assert.match(text, /often goes to: Shoprite, Ikeja/);
  assert.match(text, /yesterday: Ikeja City Mall, Lagos → 12 Adebayo Street, Surulere, Lagos \(completed, ₦2,600, wallet\)/);
  assert.match(text, /3 days ago: Yaba, Lagos → Lekki Phase 1, Lagos \(cancelled, wallet\)/);
  assert.match(text, /\(4×\)/);
});

test('the intent extractor gets places only, and nothing for a stranger', () => {
  const text = memory.renderRiderMemoryForIntent(sample());
  assert.match(text, /home = 12 Adebayo Street/);
  assert.match(text, /ride yesterday: Ikeja City Mall/);
  assert.doesNotMatch(text, /pidgin/);
  assert.equal(memory.renderRiderMemoryForIntent({ facts: [], rides: [], transcript: [], frequentPlaces: [] }), '');
  assert.match(memory.renderRiderMemory({ facts: [], rides: [], transcript: [], frequentPlaces: [] }), /new rider/);
});

test('Nigeria bounding box', () => {
  assert.equal(geo.isWithinServiceBounds(6.5244, 3.3792), true);   // Lagos
  assert.equal(geo.isWithinServiceBounds(9.0765, 7.3986), true);   // Abuja
  assert.equal(geo.isWithinServiceBounds(48.8566, 2.3522), false); // Paris
  assert.equal(geo.isWithinServiceBounds(5.6037, -0.1870), false); // Accra
  assert.equal(geo.isPinInsideServiceArea(6.5244, 3.3792, null), true);
  assert.equal(geo.isPinInsideServiceArea(6.5244, 3.3792, { lat: 6.5, lng: 3.3, formattedAddress: 'x', countryCode: 'BJ' }), false);
  assert.equal(geo.isPinInsideServiceArea(48.85, 2.35, { lat: 48.85, lng: 2.35, formattedAddress: 'Paris', countryCode: 'FR' }), false);
});

test('a miss reads as "could not find" unless the place was abroad', () => {
  assert.equal(geo.geocodeMissLine('Eiffel Tower'), 'Could not find "Eiffel Tower" on the map.');
  assert.equal(geo.outsideServiceAreaMatch('Eiffel Tower'), null);
});
