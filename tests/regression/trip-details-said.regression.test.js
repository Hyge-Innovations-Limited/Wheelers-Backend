// Regression (trip details, ed94fe6): words read from a typed chat message must never be taken out of a place
// name or another sentence. The last three failed on the code as pushed (ed94fe6, 2026-11-07); fixed since by
// tightening the "pet" / "luggage" and "we are N" rules.
//
//   node --test tests/regression/trip-details-said.regression.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { readSaidTripDetails } = require(path.join(process.env.REGRESSION_ROOT || path.join(__dirname, '..', '..'), 'apps/api-gateway/dist/whatsapp/trip-details-said.js'));

const untouched = (m) => readSaidTripDetails(m) === null;

test('prices, menu numbers and plain trips are never read as details', () => {
  for (const m of ['3000', '2', '1', '2,000', 'yes', 'From Yaba to Ikeja City Mall', 'Box Office Yaba', 'Sunshine Bags Ikeja', 'Dog Park Lekki', 'Ikeja City Mall and two', 'the cat', 'cancel', 'withdraw 2000']) {
    assert.ok(untouched(m), m);
  }
});

test('the documented phrases are read', () => {
  assert.deepEqual(readSaidTripDetails('we are 3 with my dog').said, { passengers: 3, pet: true });
  assert.equal(readSaidTripDetails('From Yaba to Ikeja City Mall with my dog').rest, 'From Yaba to Ikeja City Mall');
});

test('a place whose name has "Pet" or "Luggage" in it keeps its name', () => {
  for (const m of ['Pet Shop, Lekki', 'Take me to Pets Corner Yaba', 'Luggage Road Ikeja', 'Pet clinic']) {
    assert.ok(untouched(m), `"${m}" was read as ${JSON.stringify(readSaidTripDetails(m))}`);
  }
});

test('"we are two minutes from Yaba" / "we are one family" is not a head count', () => {
  for (const m of ['we are two minutes from Yaba', 'we are one family going to Yaba']) {
    assert.ok(untouched(m), `"${m}" was read as ${JSON.stringify(readSaidTripDetails(m))}`);
  }
});

test('"and loads/cat" inside an address is not luggage or a pet', () => {
  for (const m of ['from yaba and loads street', 'Lekki and cat street']) {
    assert.ok(untouched(m), `"${m}" was read as ${JSON.stringify(readSaidTripDetails(m))}`);
  }
});

test('"with my dog close to the gate" is a pet; a place word after the noun is not', () => {
  assert.deepEqual(readSaidTripDetails('with my dog close to the gate').said, { pet: true });
  for (const m of ['I have a pet shop in Lekki', 'with the cat food', 'Pick me at With Bags Plaza', 'we are 2.5km away']) assert.ok(untouched(m), m);
});
