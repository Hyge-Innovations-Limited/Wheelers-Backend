// Riders never see a trip ID (WH-…) in WhatsApp: not on the ride card, not when
// the trip starts, not on the receipt. Admin and the Excel keep it.
//
//   node --test test/no-trip-id-in-chat.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { rideDetailsText } = require('../apps/api-gateway/dist/whatsapp/ride-card.js');
const { sendRideStartedNotification, sendRideCompletedNotification } = require('../apps/api-gateway/dist/whatsapp-flows/whatsapp-notifier.js');

async function captured(fn) {
  const sent = [];
  const realFetch = global.fetch;
  global.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const text = body.text?.body ?? body.interactive?.body?.text;
    if (text) sent.push(text);
    return { ok: true, json: async () => ({}), text: async () => '' };
  };
  try { await fn(); } finally { global.fetch = realFetch; }
  return sent.join('\n');
}
const meta = { metaAccessToken: 't', metaPhoneNumberId: '1' };

test('no trip ID on the ride card, the trip-started message or the receipt', async () => {
  const card = rideDetailsText({ driverName: 'Oke A', driverPhone: '', driverRating: 5, totalRides: 3, vehicleModel: 'Camry', vehiclePlate: 'KJA1', etaSeconds: 120, fareNgn: 3000, tripId: 'WH-01234' });
  assert.match(card, /\*YOUR TRIP\*/);
  assert.doesNotMatch(card, /WH-/);
  assert.doesNotMatch(await captured(() => sendRideStartedNotification(meta, '+2348000000000', 'WH-01234')), /WH-/);
  assert.doesNotMatch(await captured(() => sendRideCompletedNotification(meta, '+2348000000000', 3000, 4.2, 1000, undefined, 'WH-01234')), /WH-|Trip ID/);
});
