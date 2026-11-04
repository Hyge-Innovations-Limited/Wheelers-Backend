// "Your driver is here" with Live call on (4 Nov 2026): no phone number; the card's one button is Chat or call,
// opening the trip page. If WhatsApp refuses that card, the card with the number goes, so the driver is always reachable.
//
//   node --test test/arrived-card-live-call.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { sendDriverArrivedNotification } = require('../apps/api-gateway/dist/whatsapp-flows/whatsapp-notifier.js');

const realFetch = global.fetch;
test.afterEach(() => { global.fetch = realFetch; });
const details = { driverName: 'Ade', vehicleModel: 'Camry', vehiclePlate: 'LAG123', driverPhone: '+2349015208515', carPhotoUrl: 'https://img/car.jpg', tripCode: '0228', riderId: 'rider-1', rideId: 'ride-1' };

test('Live call on: Chat or call, the trip page, no number', async () => {
  const sent = [];
  global.fetch = async (_url, init) => { sent.push(JSON.parse(init.body)); return { ok: true, text: async () => '' }; };
  await sendDriverArrivedNotification({ metaAccessToken: 't', metaPhoneNumberId: '1', liveCallPageUrl: (r, ride) => `https://app/trip#${r}:${ride}` }, '+2348000000000', details);
  assert.equal(sent.length, 1, 'one message');
  const card = sent[0].interactive;
  assert.equal(card.type, 'cta_url');
  assert.equal(card.action.parameters.display_text, 'Chat or call');
  assert.equal(card.action.parameters.url, 'https://app/trip#rider-1:ride-1');
  assert.equal(card.header.image.link, 'https://img/car.jpg');
  assert.match(card.body.text, /Ade is here[\s\S]*TRIP CODE: 0228[\s\S]*Can't find them\? Tap \*Chat or call\*\./);
  assert.ok(!JSON.stringify(sent).includes('9015208515'), 'no phone number anywhere');
});

test('Live call on but WhatsApp refuses the card: the card with the number goes instead', async () => {
  const sent = [];
  global.fetch = async (_url, init) => { const b = JSON.parse(init.body); sent.push(b); return b.interactive?.type === 'cta_url' ? { ok: false, status: 400, text: async () => 'no' } : { ok: true, text: async () => '' }; };
  await sendDriverArrivedNotification({ metaAccessToken: 't', metaPhoneNumberId: '1', liveCallPageUrl: () => 'https://app/trip' }, '+2348000000000', details);
  assert.equal(sent.length, 2);
  assert.ok(JSON.stringify(sent[1]).includes('Call'), 'the fallback says Call');
  assert.ok(JSON.stringify(sent[1]).includes('9015208515'));
});

test('Live call off: as before, with the number', async () => {
  const sent = [];
  global.fetch = async (_url, init) => { sent.push(JSON.parse(init.body)); return { ok: true, text: async () => '' }; };
  await sendDriverArrivedNotification({ metaAccessToken: 't', metaPhoneNumberId: '1' }, '+2348000000000', details);
  assert.ok(!sent.some((m) => m.interactive?.type === 'cta_url'));
  assert.ok(JSON.stringify(sent).includes('9015208515'));
});
