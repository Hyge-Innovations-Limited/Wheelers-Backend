// Search messages (Timi, 21 Nov 2026): what is happening with a search, said as it is. "No drivers near you right
// now" when the request reached nobody (never "raise your price" then), "4 drivers have your request" while they
// decide, "3 drivers passed at ₦2,800" only when most said no and the price is under the usual one, "2 drivers asked
// ₦3,900 – ₦4,300" when every offer is above it. The end of the search says how it ended, on the app, the ride page and
// WhatsApp alike. And a search that reached nobody looks again every 30 s for drivers who drove into range.
// Through the real handlers, on the real local Redis (db 15) and Postgres; WhatsApp is captured, never sent.
//
//   node scripts/run-with-env.cjs node --test --test-force-exit --test-concurrency=1 test/search-situation.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const { RIDE } = require('@wheleers/config');
const { searchSituationFor, loadSearchSituation, noteDeclined, noteFinishingSent, situationForRide, LOOKING_MS } = require('../apps/api-gateway/dist/rides/search-situation.js');
const { noteOfferSent, startSearchClock } = require('../apps/api-gateway/dist/rides/search-status.js');
const { handleRideEvent } = require('../apps/api-gateway/dist/kafka/consumer.js');
const { bidTimeoutText } = require('../apps/api-gateway/dist/whatsapp-flows/whatsapp-notifier.js');
const { RedisClient } = require('../apps/api-gateway/dist/redis/client.js');
const bidState = require('../apps/api-gateway/dist/whatsapp-flows/bid-state.js');
const { createRideRequestedConsumer } = require('../apps/ride-service/dist/consumers/ride-requested.consumer.js');

const prisma = new PrismaClient();
const REDIS_URL = process.env.TEST_REDIS_URL || 'redis://127.0.0.1:6379/15';
const made = { users: [], rides: [], drivers: [] };
const clients = [];
const realConsole = { ...console };
const realFetch = global.fetch;
let sentToMeta = [];
test.beforeEach(() => {
  console.log = console.info = console.warn = console.error = () => {};
  sentToMeta = [];
  global.fetch = async (_url, init) => { sentToMeta.push(JSON.parse(init?.body ?? '{}')); return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.t' }] }), text: async () => '' }; };
});
test.afterEach(() => { Object.assign(console, realConsole); global.fetch = realFetch; });
test.after(async () => {
  for (const c of clients) await c.disconnect().catch(() => {});
  await prisma.rideHold.deleteMany({ where: { rideId: { in: made.rides } } }).catch(() => {});
  await prisma.driverBid.deleteMany({ where: { rideId: { in: made.rides } } }).catch(() => {});
  await prisma.ride.deleteMany({ where: { id: { in: made.rides } } }).catch(() => {});
  await prisma.driver.deleteMany({ where: { id: { in: made.drivers } } }).catch(() => {});
  await prisma.wallet.deleteMany({ where: { userId: { in: made.users } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: made.users } } }).catch(() => {});
  await prisma.$disconnect();
});

async function redis() {
  const client = new RedisClient(REDIS_URL);
  await client.connect();
  clients.push(client);
  return client;
}
async function user(role) {
  const id = randomUUID();
  await prisma.user.create({ data: { id, privyDid: `test:situation:${id}`, role, name: `Sit ${role}`, phone: `+23481${Math.floor(1e8 + Math.random() * 9e8)}` } });
  made.users.push(id);
  return id;
}
async function ride(riderId, data = {}) {
  const row = await prisma.ride.create({ data: { riderId, channel: 'APP', status: 'MATCHING', pickupLat: 6.5244, pickupLng: 3.387, pickupAddress: 'Akoka', destLat: 6.5095, destLng: 3.3711, destAddress: 'Yaba', riderOfferNgn: 2800, fareEstimateNgn: 4200, bookingSuggestedFareNgn: 4200, distanceKm: 6, ...data } });
  made.rides.push(row.id);
  return row;
}
const facts = (over = {}) => ({ driversNotified: 0, finishing: 0, declined: 0, offerNgn: 2800, usualNgn: 4200, asks: [], runningMs: 60_000, ...over });

/* ── the rules ── */

test('nobody reached: "No drivers near you right now", never a price; the first seconds say nothing yet', () => {
  const none = searchSituationFor(facts());
  assert.equal(none.kind, 'none_near');
  assert.equal(none.title, 'No drivers near you right now');
  assert.match(none.line, /keep looking/);
  assert.equal(none.suggestNgn, null);
  assert.deepEqual(none.retryNgn, []);
  assert.equal(none.endTitle, 'No drivers came online near you.');
  const early = searchSituationFor(facts({ runningMs: LOOKING_MS - 1 }));
  assert.equal(early.kind, 'looking');
  assert.equal(early.title, '');
});

test('drivers have it: a count; the usual price named only when the offer is under it', () => {
  const fair = searchSituationFor(facts({ driversNotified: 4, offerNgn: 4200 }));
  assert.equal(fair.kind, 'waiting');
  assert.equal(fair.title, '4 drivers have your request');
  assert.equal(fair.line, 'Offers usually come in the first minute or two.');
  assert.equal(fair.endTitle, '4 drivers saw it, none answered.');
  const low = searchSituationFor(facts({ driversNotified: 1 }));
  assert.equal(low.title, '1 driver has your request');
  assert.equal(low.line, 'Trips like this usually go for ₦4,200.');
  assert.equal(low.suggestNgn, null, 'a fact, not a push');
  assert.equal(low.endTitle, '1 driver saw it, no answer.');
});

test('passed on the price: only when most said no and the price is under the usual one; the price offered never above it', () => {
  const passed = searchSituationFor(facts({ driversNotified: 4, declined: 3 }));
  assert.equal(passed.kind, 'passed');
  assert.equal(passed.title, '3 drivers passed at ₦2,800');
  assert.equal(passed.line, 'Trips like this usually go for ₦4,200.');
  assert.equal(passed.suggestNgn, 3500);
  assert.deepEqual(passed.retryNgn, [3500, 4200]);
  // At the usual price already: drivers saying no is not a price problem.
  assert.equal(searchSituationFor(facts({ driversNotified: 4, declined: 3, offerNgn: 4200 })).kind, 'waiting');
  // One no out of six: still waiting.
  assert.equal(searchSituationFor(facts({ driversNotified: 6, declined: 1 })).kind, 'waiting');
  // Just under the usual: the suggestion is the usual price, never more.
  assert.equal(searchSituationFor(facts({ driversNotified: 2, declined: 2, offerNgn: 4100 })).suggestNgn, 4200);
});

test('only drivers finishing a trip close by: "Drivers near you are on trips"', () => {
  const s = searchSituationFor(facts({ driversNotified: 2, finishing: 2 }));
  assert.equal(s.kind, 'on_trips');
  assert.equal(s.title, 'Drivers near you are on trips');
  assert.equal(searchSituationFor(facts({ driversNotified: 3, finishing: 2 })).kind, 'waiting', 'a free driver has it too');
});

test('offers above the price: the range and the lowest to match; one at the price: the offers say it all', () => {
  const c = searchSituationFor(facts({ driversNotified: 5, asks: [4300, 3900] }));
  assert.equal(c.kind, 'countered');
  assert.equal(c.title, '2 drivers asked ₦3,900 – ₦4,300');
  assert.equal(c.suggestNgn, 3900);
  assert.equal(searchSituationFor(facts({ asks: [3900] })).title, '1 driver asked ₦3,900');
  const o = searchSituationFor(facts({ asks: [2800, 3900] }));
  assert.equal(o.kind, 'offers');
  assert.equal(o.title, '');
});

/* ── from Redis, as the screens read it ── */

test('the counts come from the search\'s own keys: sent, finishing, declined', async () => {
  const r = await redis();
  const riderId = await user('RIDER');
  const row = await ride(riderId);
  await startSearchClock(r, row.id, Date.now() - 60_000);
  for (const d of ['d1', 'd2', 'd3', 'd4']) await noteOfferSent(r, row.id, d, null);
  assert.equal((await loadSearchSituation(r, row.id, { offerNgn: 2800, usualNgn: 4200, asks: [] })).kind, 'waiting');
  // A decline sent twice by Kafka counts once.
  await noteDeclined(r, row.id, 'd1');
  await noteDeclined(r, row.id, 'd1');
  await noteDeclined(r, row.id, 'd2');
  const passed = await situationForRide(r, row.id);
  assert.equal(passed.kind, 'passed');
  assert.equal(passed.title, '2 drivers passed at ₦2,800');

  const other = await ride(riderId, { riderOfferNgn: 4200 });
  await startSearchClock(r, other.id, Date.now() - 60_000);
  await noteOfferSent(r, other.id, 'f1', null);
  await noteFinishingSent(r, other.id, 'f1');
  assert.equal((await situationForRide(r, other.id)).kind, 'on_trips');
  // Just published, nothing sent yet: "looking" (no line), not "No drivers near you".
  const fresh = await ride(riderId);
  await startSearchClock(r, fresh.id);
  assert.equal((await situationForRide(r, fresh.id)).kind, 'looking');
});

/* ── the end of the search, everywhere ── */

function gatewayDeps(redisClient) {
  const toApp = [];
  return {
    toApp,
    deps: {
      registry: { sendToUser: async (userId, type, payload) => { toApp.push({ userId, type, payload }); }, hasUser: () => true, isUserConnected: async () => true },
      redisClient,
      publisher: { publishRideEvent: async () => {}, publishNotificationEvent: async () => {}, publishWalletEvent: async () => {}, publishDriverEvent: async () => {} },
      whatsappNotifier: { metaAccessToken: 't', metaPhoneNumberId: '1' },
    },
  };
}

test('an app search that reached nobody ends with "No drivers came online near you." and no higher price', async () => {
  const r = await redis();
  const riderId = await user('RIDER');
  const row = await ride(riderId);
  await startSearchClock(r, row.id, Date.now() - RIDE.BID_TIMEOUT_SECONDS * 1000);
  const { deps, toApp } = gatewayDeps(r);
  await handleRideEvent({ eventType: 'RIDE_BID_TIMEOUT', rideId: row.id, riderId, timestamp: new Date().toISOString() }, deps, new Map());
  const ended = toApp.find((m) => m.type === 'ride:bid_timeout' && m.userId === riderId);
  assert.ok(ended, 'the app is told');
  assert.equal(ended.payload.ended.kind, 'none_near');
  assert.equal(ended.payload.ended.title, 'No drivers came online near you.');
  assert.deepEqual(ended.payload.ended.retryNgn, []);
});

test('a WhatsApp search drivers saw and left: the chat says so, the offers form keeps it, no "send a higher price"', async () => {
  const r = await redis();
  const riderId = await user('RIDER');
  const phone = '+2348030000777';
  const row = await ride(riderId, { channel: 'WHATSAPP', riderOfferNgn: 4200 });
  await bidState.storeWhatsappRide(r, row.id, { riderId, phone, pickupAddress: 'Akoka', destinationAddress: 'Yaba', offerNgn: 4200, suggestedFareNgn: 4200, paymentMethod: 'WALLET', createdAt: new Date().toISOString() });
  await bidState.setActiveRide(r, riderId, row.id);
  await bidState.setPhoneLookup(r, riderId, phone);
  await r.del(`whatsapp:user:${riderId}:search_timed_out`);
  for (const d of ['a', 'b', 'c']) await noteOfferSent(r, row.id, d, null);
  const { deps } = gatewayDeps(r);
  await handleRideEvent({ eventType: 'RIDE_BID_TIMEOUT', rideId: row.id, riderId, timestamp: new Date().toISOString() }, deps, new Map());
  const timedOut = await bidState.getSearchTimedOut(r, riderId);
  assert.equal(timedOut.ended.kind, 'waiting');
  assert.equal(timedOut.ended.title, '3 drivers saw it, none answered.');
  const text = sentToMeta.map((m) => m.text?.body ?? m.interactive?.body?.text ?? '').find((b) => b.includes('Nothing was charged'));
  assert.ok(text, 'one message in the chat');
  assert.match(text, /^3 drivers saw ₦4,200, none answered\. Nothing was charged\./);
  assert.match(text, /Reply \*search again\* to try ₦4,200 again\./);
  assert.doesNotMatch(text, /higher price/);
});

test('the chat\'s end message names a price only when the server found one worth trying', () => {
  assert.deepEqual(bidTimeoutText(2800, { kind: 'passed', title: '3 drivers passed at ₦2,800.', retryNgn: [3500, 4200] }), [
    '3 drivers passed at ₦2,800. Nothing was charged.', '', 'Send *3500* to search at that price, or reply *search again*.',
  ]);
  assert.equal(bidTimeoutText(3000, { kind: 'none_near', title: 'No drivers came online near you.', retryNgn: [] })[0], 'No drivers came online near you. Nothing was charged.');
  // From before (no ended): as it was.
  assert.match(bidTimeoutText(3000, null)[2], /send a higher price, e\.g\. \*3300\*/, '10% more, not 3,400 by a rounding slip');
});

/* ── the ride service keeps looking ── */

test('a search that reached nobody is sent to a driver who drives into range, once', async () => {
  const PICK = { lat: 9.0731, lng: 7.3986, address: 'Test pickup far from Lagos' };
  const DROP = { lat: 9.0579, lng: 7.4951, address: 'Test drop' };
  const riderId = await user('RIDER');
  const rideRow = await prisma.ride.create({ data: { riderId, status: 'MATCHING', pickupLat: PICK.lat, pickupLng: PICK.lng, pickupAddress: PICK.address, destLat: DROP.lat, destLng: DROP.lng, destAddress: DROP.address, riderOfferNgn: 3000, fareEstimateNgn: 3000, distanceKm: 8, paymentMethod: 'WALLET' } });
  made.rides.push(rideRow.id);
  const driverUserId = await user('DRIVER');
  const far = { lat: PICK.lat + 0.5, lng: PICK.lng };
  const d = await prisma.driver.create({ data: { userId: driverUserId, kycStatus: 'APPROVED', status: 'ONLINE', lat: far.lat, lng: far.lng, lastSeenAt: new Date(), vehicleModel: 'Corolla', vehiclePlate: 'ABJ1' } });
  made.drivers.push(d.id);

  const state = { onlineDrivers: new Map(), assignedDriversByRideId: new Map(), rideParticipantsByRideId: new Map(), gpsByRideId: new Map(), routeByRideId: new Map(), pendingMatchesByRideId: new Map() };
  state.onlineDrivers.set(d.id, { driverId: d.id, userId: driverUserId, lat: far.lat, lng: far.lng, vehiclePlate: 'ABJ1', vehicleModel: 'Corolla' });
  const produced = [];
  const producer = new Proxy({}, { get: (_t, name) => async (payload) => { produced.push({ name: String(name), payload }); } });
  const consumer = createRideRequestedConsumer({ state, rideEnv: { MATCH_RADIUS_KM: '5', MAX_MATCH_ATTEMPTS: '5' }, rideEventsProducer: producer });
  await consumer.handle(JSON.stringify({ eventType: 'RIDE_REQUESTED', rideId: rideRow.id, riderId, pickup: PICK, destination: DROP, stops: [], fareEstimateNgn: 3000, paymentMethod: 'WALLET', riderOfferNgn: 3000, suggestedFareNgn: 3000, minOfferNgn: 2500, ratePerKmNgn: 375, timestamp: new Date().toISOString() }), { topic: 'ride.events' });
  try {
    const sentTo = () => produced.filter((p) => p.name === 'broadcastRideOffer').flatMap((p) => p.payload.drivers.map((x) => x.driverId));
    assert.deepEqual(sentTo(), [], 'nobody in range at the start');
    assert.equal(await consumer.rescanEmptySearches(), 0, 'still nobody');

    // The driver drives in.
    await prisma.driver.update({ where: { id: d.id }, data: { lat: PICK.lat + 0.01, lng: PICK.lng, lastSeenAt: new Date() } });
    state.onlineDrivers.set(d.id, { ...state.onlineDrivers.get(d.id), lat: PICK.lat + 0.01, lng: PICK.lng });
    assert.equal(await consumer.rescanEmptySearches(), 1);
    assert.deepEqual(sentTo(), [d.id]);
    assert.equal(await consumer.rescanEmptySearches(), 0, 'reached someone: not sent again by the rescan');
    assert.deepEqual(sentTo(), [d.id]);
  } finally {
    for (const p of state.pendingMatchesByRideId.values()) if (p.timeout) clearTimeout(p.timeout);
  }
});
