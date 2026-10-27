// What a driver hears, and the rider's lists when a driver goes: every event a
// driver must know is a socket message, plus a push when their app is not
// connected; the end of a search says why (timed out, rider cancelled, another
// driver booked); a withdrawn or offline driver's offer leaves the WhatsApp
// list, the ride page and the app, its bid row WITHDRAWN, with nothing said in
// the chat while the rider is on the page. Against the local Postgres.
//
//   node scripts/run-with-env.cjs node --test --test-force-exit test/driver-events.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const { driverBidClient } = require('../packages/db/dist/index.js');
const { handleRideEvent, dropBidFromWhatsappRide } = require('../apps/api-gateway/dist/kafka/consumer.js');
const { withdrawDriverFromMarket } = require('../apps/api-gateway/dist/websocket/driver-offline-grace.js');
const bidState = require('../apps/api-gateway/dist/whatsapp-flows/bid-state.js');

const prisma = new PrismaClient();
const made = { users: [], rides: [], drivers: [] };
const realConsole = { ...console };
const realFetch = global.fetch;
test.beforeEach(() => { console.log = console.info = console.warn = console.error = () => {}; });
test.afterEach(() => { Object.assign(console, realConsole); global.fetch = realFetch; });
test.after(async () => {
  await prisma.tripCode?.deleteMany({ where: { rideId: { in: made.rides } } }).catch(() => {});
  await prisma.rideHold.deleteMany({ where: { rideId: { in: made.rides } } });
  await prisma.driverBid.deleteMany({ where: { rideId: { in: made.rides } } });
  await prisma.ride.deleteMany({ where: { id: { in: made.rides } } });
  await prisma.driver.deleteMany({ where: { id: { in: made.drivers } } });
  await prisma.wallet.deleteMany({ where: { userId: { in: made.users } } });
  await prisma.user.deleteMany({ where: { id: { in: made.users } } });
  await prisma.$disconnect();
});

function memoryRedis() {
  const store = new Map();
  return {
    store,
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async set(k, v) { store.set(k, v); },
    async del(k) { store.delete(k); },
    async setIfNotExists(k, v) { if (store.has(k)) return false; store.set(k, v); return true; },
    async send() { return null; },
  };
}
async function user(role, phone) {
  const id = randomUUID();
  await prisma.user.create({ data: { id, privyDid: `test:driver-events:${id}`, role, name: `Ada ${role}`, ...(phone ? { phone } : {}) } });
  made.users.push(id);
  return id;
}
async function driver() {
  const userId = await user('DRIVER');
  const d = await prisma.driver.create({ data: { userId, kycStatus: 'APPROVED', status: 'ONLINE', lastSeenAt: new Date(), vehicleModel: 'Corolla', vehiclePlate: 'KJA1' } });
  made.drivers.push(d.id);
  return { id: d.id, userId };
}
async function ride(riderId, extra = {}) {
  const r = await prisma.ride.create({ data: { riderId, status: 'MATCHING', pickupLat: 6.5244, pickupLng: 3.387, pickupAddress: 'Akoka', destLat: 6.5095, destLng: 3.3711, destAddress: 'Yaba', riderOfferNgn: 3000, fareEstimateNgn: 3000, ...extra } });
  made.rides.push(r.id);
  return r;
}
const bid = (r, d, amountNgn = 3000) => driverBidClient.record({ rideId: r.id, driverId: d.id, driverUserId: d.userId, riderId: r.riderId, amountNgn, etaSeconds: 300 });

/** Drivers in `away` are not connected; everyone else is. */
function world(away = new Set()) {
  const toApp = [];
  const pushes = [];
  const redis = memoryRedis();
  return {
    toApp, pushes, redis,
    deps: {
      registry: {
        sendToUser: async (userId, type, payload) => { toApp.push({ userId, type, payload }); },
        isUserConnected: async (userId) => !away.has(userId),
        hasUser: (userId) => !away.has(userId),
      },
      redisClient: redis,
      publisher: {
        publishRideEvent: async () => {}, publishDriverEvent: async () => {}, publishWalletEvent: async () => {},
        publishNotificationEvent: async (e) => { if (e.eventType === 'PUSH_SEND') pushes.push(e); },
      },
    },
  };
}
const now = () => new Date().toISOString();

test('search ended: bidders hear why on the socket, and a driver away from the app gets "Search ended"', async () => {
  const riderId = await user('RIDER');
  const r = await ride(riderId);
  const here = await driver();
  const gone = await driver();
  await bid(r, here);
  await bid(r, gone);
  const w = world(new Set([gone.userId]));
  await handleRideEvent({ eventType: 'RIDE_BID_TIMEOUT', rideId: r.id, riderId, timestamp: now() }, w.deps, new Map());
  const ended = w.toApp.filter((m) => m.type === 'ride:bid_timeout' && m.userId !== riderId);
  assert.deepEqual(ended.map((m) => m.payload.reason).sort(), ['timed_out', 'timed_out']);
  assert.deepEqual(w.pushes.map((p) => [p.userId, p.title]), [[gone.userId, 'Search ended']], 'only the driver who is not connected');
});

test('rider cancelled: bidders hear "rider_cancelled"; the booked driver away from the app gets "Rider cancelled"', async () => {
  const riderId = await user('RIDER');
  const r = await ride(riderId);
  const bidder = await driver();
  await bid(r, bidder);
  const w = world(new Set([bidder.userId]));
  await handleRideEvent({ eventType: 'RIDE_CANCELLED', rideId: r.id, riderId, cancelledBy: 'rider', reason: 'My plans changed', timestamp: now() }, w.deps, new Map());
  assert.deepEqual(w.toApp.filter((m) => m.type === 'ride:bid_timeout').map((m) => m.payload), [{ rideId: r.id, reason: 'rider_cancelled' }]);
  assert.deepEqual(w.pushes.map((p) => p.title), ['Rider cancelled']);

  const booked = await driver();
  const r2 = await ride(riderId, { status: 'DRIVER_ASSIGNED', driverId: booked.id });
  const w2 = world(new Set([booked.userId]));
  await handleRideEvent({ eventType: 'RIDE_CANCELLED', rideId: r2.id, riderId, driverId: booked.id, cancelledBy: 'rider', timestamp: now() }, w2.deps, new Map());
  assert.ok(w2.toApp.some((m) => m.userId === booked.userId && m.type === 'ride:cancelled'));
  assert.deepEqual(w2.pushes.map((p) => [p.userId, p.title]), [[booked.userId, 'Rider cancelled']]);
});

test('booked: the winner away from the app gets "You\'re booked"; the losing bidders hear "booked_other", and "Not chosen" when away', async () => {
  const riderId = await user('RIDER');
  const r = await ride(riderId, { status: 'DRIVER_ASSIGNED' });
  const winner = await driver();
  const loser = await driver();
  const watching = await driver();
  await bid(r, winner);
  await bid(r, loser, 2800);
  await bid(r, watching, 2900);
  const w = world(new Set([winner.userId, loser.userId]));
  await handleRideEvent({
    eventType: 'RIDE_DRIVER_ASSIGNED', rideId: r.id, riderId, driverId: winner.id, driverUserId: winner.userId, driverName: 'Ada', driverRating: 5,
    vehiclePlate: 'KJA1', vehicleModel: 'Corolla', etaSeconds: 300, agreedFareNgn: 3000, lockedFareNgn: 3000, paymentMethod: 'WALLET', offeredDriverUserIds: [], timestamp: now(),
  }, w.deps, new Map());
  const lost = w.toApp.filter((m) => m.type === 'ride:bid_lost');
  assert.deepEqual(lost.map((m) => m.payload.reason), ['booked_other', 'booked_other']);
  const titles = w.pushes.filter((p) => p.userId !== riderId).map((p) => [p.userId, p.title]).sort();
  assert.deepEqual(titles, [[loser.userId, 'Not chosen'], [winner.userId, "You're booked"]].sort());
});

test('a new price reaches a driver away from the app by push ("New price ₦X"); a connected one has the card', async () => {
  const riderId = await user('RIDER');
  const r = await ride(riderId);
  const away = await driver();
  const here = await driver();
  const w = world(new Set([away.userId]));
  const offer = (d) => ({
    eventType: 'RIDE_OFFER_SENT', rideId: r.id, riderId, driverId: d.id, driverUserId: d.userId, pickup: { address: 'Akoka' }, destination: { address: 'Yaba' },
    stops: [], riderOfferNgn: 3500, expiresAt: new Date(Date.now() + 60_000).toISOString(), repriced: true, timestamp: now(),
  });
  await handleRideEvent(offer(away), w.deps, new Map());
  await handleRideEvent(offer(here), w.deps, new Map());
  assert.deepEqual(w.pushes.map((p) => [p.userId, p.title, p.data.type]), [[away.userId, 'New price ₦3,500', 'ride:offer_updated']]);
  // A first offer (not a re-price) is pushed by the ride service, not here.
  await handleRideEvent({ ...offer(away), repriced: undefined }, w.deps, new Map());
  assert.equal(w.pushes.length, 1);
});

test('a driver withdraws: the bid row is WITHDRAWN, the offer leaves the WhatsApp list, and the app is told which driver', async () => {
  const riderId = await user('RIDER');
  const r = await ride(riderId);
  const d = await driver();
  const row = await bid(r, d);
  const w = world();
  await bidState.addBid(w.redis, r.id, { bidId: row.id, driverId: d.id, driverUserId: d.userId, counterOfferNgn: 3000, driverName: 'Ada', driverRating: 5, vehiclePlate: 'KJA1', vehicleModel: 'Corolla', etaSeconds: 300, receivedAt: now() });
  await handleRideEvent({ eventType: 'RIDE_DRIVER_REJECTED', rideId: r.id, riderId, driverId: d.id, reason: 'manual_reject', timestamp: now() }, w.deps, new Map());
  assert.equal((await prisma.driverBid.findUnique({ where: { id: row.id } })).status, 'WITHDRAWN');
  assert.deepEqual(await bidState.getBids(w.redis, r.id), []);
  assert.deepEqual(w.toApp.find((m) => m.type === 'ride:driver_rejected').payload, { rideId: r.id, driverId: d.id, reason: 'manual_reject' });
});

test('a driver goes offline: every open bid is WITHDRAWN and leaves the WhatsApp list and the page; the chat says nothing while the rider is on the page', async () => {
  const riderId = await user('RIDER', '+2348030000077');
  const r = await ride(riderId);
  const d = await driver();
  const row = await bid(r, d);
  const w = world();
  const chat = [];
  global.fetch = async (url, init) => { if (String(url).includes('graph.facebook.com')) { chat.push(init.body); return new Response('{"messages":[{"id":"x"}]}', { status: 200 }); } return realFetch(url, init); };
  await bidState.setActiveRide(w.redis, riderId, r.id);
  await bidState.setPhoneLookup(w.redis, riderId, '+2348030000077');
  await bidState.addBid(w.redis, r.id, { bidId: row.id, driverId: d.id, driverUserId: d.userId, counterOfferNgn: 3000, driverName: 'Ada', driverRating: 5, vehiclePlate: 'KJA1', vehicleModel: 'Corolla', etaSeconds: 300, receivedAt: now() });
  await bidState.markRidePageSeen(w.redis, riderId);
  const notifier = { metaAccessToken: 't', metaPhoneNumberId: '1' };
  await withdrawDriverFromMarket(w.deps.registry, d.userId, (rideId, rId, driverId) => dropBidFromWhatsappRide({ redisClient: w.redis, whatsappNotifier: notifier }, rideId, rId, driverId));
  assert.equal((await prisma.driverBid.findUnique({ where: { id: row.id } })).status, 'WITHDRAWN');
  assert.deepEqual(await bidState.getBids(w.redis, r.id), [], 'the ride page reads this list');
  assert.ok(w.toApp.some((m) => m.userId === riderId && m.type === 'ride:driver_rejected' && m.payload.driverId === d.id));
  assert.ok(w.toApp.some((m) => m.userId === d.userId && m.type === 'ride:bid_withdrawn'));
  assert.equal(chat.length, 0, 'nothing in the chat while the rider is on the page');
});
