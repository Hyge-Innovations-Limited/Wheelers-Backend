// While the rider is on the ride page the chat stays quiet; when they leave it,
// the chat gets what it missed — once, and only what is still true. Against
// the local Postgres.
//
//   node scripts/run-with-env.cjs node --test --test-force-exit test/page-catchup.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const { handleRideEvent, deliverPageCatchup } = require('../apps/api-gateway/dist/kafka/consumer.js');
const { createRidePageChatNotifier } = require('../apps/api-gateway/dist/whatsapp/ride-card.js');
const { createPageCatchup, pendingCatchup } = require('../apps/api-gateway/dist/whatsapp-flows/page-catchup.js');
const { markRidePageSeen, setActiveRide, setRideState } = require('../apps/api-gateway/dist/whatsapp-flows/bid-state.js');

const prisma = new PrismaClient();
const made = { users: [], rides: [], drivers: [] };
test.beforeEach(() => { console.log = console.info = console.warn = console.error = () => {}; });

/** Redis in memory, with the sorted set the catch-up keeps its riders in. */
function memoryRedis() {
  const store = new Map();
  const zset = new Map();
  return {
    store,
    zset,
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async set(k, v) { store.set(k, v); },
    async del(k) { store.delete(k); },
    async setIfNotExists(k, v) { if (store.has(k)) return false; store.set(k, v); return true; },
    async send(cmd, key, ...args) {
      if (cmd === 'ZADD') { zset.set(args[1], Number(args[0])); return 1; }
      if (cmd === 'ZREM') return zset.delete(args[0]) ? 1 : 0;
      if (cmd === 'ZRANGEBYSCORE') { const max = Number(args[1]); return [...zset].filter(([, score]) => score <= max).map(([member]) => member); }
      return null;
    },
  };
}
function metaCapture() {
  const sent = [];
  const realFetch = global.fetch;
  global.fetch = async (_url, init) => { sent.push(JSON.parse(init.body)); return { ok: true, status: 200, text: async () => '', json: async () => ({ messages: [{ id: 'wamid.X' }] }) }; };
  return { sent, restore: () => { global.fetch = realFetch; } };
}
async function rider() {
  const id = randomUUID();
  const phone = `+234802${Math.floor(1000000 + Math.random() * 8999999)}`;
  await prisma.user.create({ data: { id, privyDid: `test:catchup:${id}`, role: 'RIDER', name: 'Catchup Rider', phone } });
  made.users.push(id);
  return { id, phone };
}
async function rideFor(riderId, extra = {}) {
  const r = await prisma.ride.create({ data: { riderId, channel: 'WHATSAPP', status: 'MATCHING', pickupLat: 6.52, pickupLng: 3.38, pickupAddress: 'Yaba', destLat: 6.6, destLng: 3.35, destAddress: 'Ikeja', riderOfferNgn: 4500, fareEstimateNgn: 4500, ...extra } });
  made.rides.push(r.id);
  return r;
}
const notifierDeps = (redis) => ({ redisClient: redis, metaAccessToken: 't', metaPhoneNumberId: '1', jwtSecret: 'x'.repeat(40) });

test.after(async () => {
  await prisma.ride.deleteMany({ where: { id: { in: made.rides } } }).catch(() => {});
  await prisma.driver.deleteMany({ where: { id: { in: made.drivers } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: made.users } } }).catch(() => {});
  await prisma.$disconnect();
});

test('on the page: Find and Accept send nothing to the chat; Cancel sends nothing at all', async () => {
  const r = await rider();
  const ride = await rideFor(r.id);
  const redis = memoryRedis();
  const notify = createRidePageChatNotifier(notifierDeps(redis));
  const meta = metaCapture();
  try {
    await notify({ kind: 'search_started', userId: r.id, phone: r.phone, rideId: ride.id, offerNgn: 4500, pickupAddress: 'Yaba', destAddress: 'Ikeja' });
    await notify({ kind: 'ride_confirmed', userId: r.id, phone: r.phone, ride: { rideId: ride.id, fareNgn: 4500, driverId: randomUUID(), driverName: 'Tunde' } });
    await notify({ kind: 'search_cancelled', userId: r.id, phone: r.phone });
  } finally { meta.restore(); }
  assert.equal(meta.sent.length, 0, 'nothing in the chat while they are on the page');
  assert.deepEqual((await pendingCatchup(redis, r.id)).map((item) => item.kind), ['search_started', 'ride_confirmed']);
});

test('the catch-up waits while the page is open, then says it once when they leave', async () => {
  const redis = memoryRedis();
  const userId = randomUUID();
  const delivered = [];
  const catchup = createPageCatchup({ redis, deliver: async (id, item) => { delivered.push([id, item.kind]); } });
  const notify = createRidePageChatNotifier(notifierDeps(redis));
  await notify({ kind: 'search_started', userId, phone: '+2348020000000', rideId: 'r1', offerNgn: 4500, pickupAddress: 'Yaba', destAddress: 'Ikeja' });

  await markRidePageSeen(redis, userId);
  await catchup.sweep(Date.now() + 60_000);
  assert.equal(delivered.length, 0, 'still on the page: nothing yet');

  redis.store.delete(`whatsapp:user:${userId}:ride_page_seen`);   // the page stopped asking
  await catchup.sweep(Date.now() + 120_000);
  assert.deepEqual(delivered, [[userId, 'search_started']]);
  await catchup.sweep(Date.now() + 240_000);
  assert.equal(delivered.length, 1, 'said once');
});

test('only what is still true is said: no "bid is in" once booked, no "booked" once cancelled, no "outside" once the trip started', async () => {
  const r = await rider();
  const redis = memoryRedis();
  const said = [];
  const deps = { registry: { sendToUser: async () => {} }, redisClient: redis, publisher: {}, ridePageChat: async (event) => { said.push(event.kind); } };

  const booked = await rideFor(r.id, { status: 'DRIVER_ASSIGNED' });
  await setActiveRide(redis, r.id, booked.id);
  await setRideState(redis, booked.id, 'confirmed');
  await deliverPageCatchup(deps, r.id, { kind: 'search_started', rideId: booked.id, event: { kind: 'search_started' } });
  assert.deepEqual(said, [], 'booked meanwhile: the search is not announced');
  await deliverPageCatchup(deps, r.id, { kind: 'ride_confirmed', rideId: booked.id, event: { kind: 'ride_confirmed' } });
  assert.deepEqual(said, ['ride_confirmed'], 'the booking still stands: its card goes out');

  const cancelled = await rideFor(r.id, { status: 'CANCELLED' });
  await setActiveRide(redis, r.id, cancelled.id);
  await setRideState(redis, cancelled.id, 'confirmed');
  await deliverPageCatchup(deps, r.id, { kind: 'ride_confirmed', rideId: cancelled.id, event: { kind: 'ride_confirmed' } });
  assert.deepEqual(said, ['ride_confirmed'], 'a cancelled booking is not announced');

  const started = await rideFor(r.id, { status: 'IN_PROGRESS' });
  const meta = metaCapture();
  try {
    await deliverPageCatchup({ ...deps, whatsappNotifier: { metaAccessToken: 't', metaPhoneNumberId: '1' } }, r.id, { kind: 'arrived', rideId: started.id });
  } finally { meta.restore(); }
  assert.equal(meta.sent.length, 0, 'the trip already started: no "your driver is outside"');
});

test('driver arrived while the rider is on the page: kept for later; trip started: never a message', async () => {
  const r = await rider();
  const driverUserId = randomUUID();
  await prisma.user.create({ data: { id: driverUserId, privyDid: `test:catchup:${driverUserId}`, role: 'DRIVER', name: 'Tunde Bakare' } });
  made.users.push(driverUserId);
  const driver = await prisma.driver.create({ data: { userId: driverUserId, kycStatus: 'APPROVED', status: 'ON_RIDE', vehicleModel: 'Camry', vehiclePlate: 'LAG23469' } });
  made.drivers.push(driver.id);
  const ride = await rideFor(r.id, { status: 'ARRIVED', driverId: driver.id });
  const redis = memoryRedis();
  await redis.set(`whatsapp:user:${r.id}:phone`, r.phone);
  const deps = { registry: { sendToUser: async () => {} }, redisClient: redis, publisher: {}, whatsappNotifier: { metaAccessToken: 't', metaPhoneNumberId: '1' } };
  await markRidePageSeen(redis, r.id);

  const meta = metaCapture();
  try {
    await handleRideEvent({ eventType: 'RIDE_ARRIVED', rideId: ride.id, riderId: r.id, driverId: driver.id, timestamp: new Date().toISOString() }, deps, new Map());
    assert.equal(meta.sent.length, 0, 'on the page: the page shows the car and the code');
    assert.deepEqual((await pendingCatchup(redis, r.id)).map((item) => item.kind), ['arrived']);

    await handleRideEvent({ eventType: 'RIDE_STARTED', rideId: ride.id, riderId: r.id, driverId: driver.id, startedAt: new Date().toISOString(), timestamp: new Date().toISOString() }, deps, new Map());
    assert.equal(meta.sent.length, 0, 'no "trip started" message');
  } finally { meta.restore(); }

  // Off the page, "your driver is outside" is said at once, as before (another trip: each arrival is said once).
  redis.store.delete(`whatsapp:user:${r.id}:ride_page_seen`);
  const ride2 = await rideFor(r.id, { status: 'ARRIVED', driverId: driver.id });
  const meta2 = metaCapture();
  try {
    await handleRideEvent({ eventType: 'RIDE_ARRIVED', rideId: ride2.id, riderId: r.id, driverId: driver.id, timestamp: new Date().toISOString() }, deps, new Map());
    await handleRideEvent({ eventType: 'RIDE_ARRIVED', rideId: ride2.id, riderId: r.id, driverId: driver.id, timestamp: new Date().toISOString() }, deps, new Map());
  } finally { meta2.restore(); }
  assert.match(JSON.stringify(meta2.sent), /LAG23469/);
  assert.equal(meta2.sent.filter((m) => /LAG23469/.test(JSON.stringify(m))).length, 1, 'delivered again: said once');
});
