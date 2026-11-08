// A 5-minute search that ran out while the rider was paying for a chosen
// driver (a bank top-up) is held, so the deposit landing still books that
// driver. If the rider never pays, the search must still end: the other
// drivers are told, and the offers form says nobody took it. Through the
// gateway's real handlers (handleRideEvent, the held-timeout sweep), on the
// real local Redis (db 15) and Postgres.
//
//   node scripts/run-with-env.cjs node --test --test-force-exit --test-concurrency=1 test/held-bid-timeout.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const { driverBidClient } = require('../packages/db/dist/index.js');
const { handleRideEvent, sweepHeldTimeouts } = require('../apps/api-gateway/dist/kafka/consumer.js');
const { RedisClient } = require('../apps/api-gateway/dist/redis/client.js');
const bidState = require('../apps/api-gateway/dist/whatsapp-flows/bid-state.js');

const prisma = new PrismaClient();
const REDIS_URL = process.env.TEST_REDIS_URL || 'redis://127.0.0.1:6379/15';
const made = { users: [], rides: [], drivers: [] };
const clients = [];
const realConsole = { ...console };
const realFetch = global.fetch;
// Meta is recorded, never called.
test.beforeEach(() => { console.log = console.info = console.warn = console.error = () => {}; global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.t' }] }), text: async () => '' }); });
test.afterEach(() => { Object.assign(console, realConsole); global.fetch = realFetch; });
test.after(async () => {
  for (const c of clients) await c.send('DEL', 'wheelers:held-bid-timeouts').catch(() => {});
  for (const c of clients) await c.disconnect().catch(() => {});
  await prisma.driverBid.deleteMany({ where: { rideId: { in: made.rides } } });
  await prisma.rideStop.deleteMany({ where: { rideId: { in: made.rides } } });
  await prisma.ride.deleteMany({ where: { id: { in: made.rides } } });
  await prisma.driver.deleteMany({ where: { id: { in: made.drivers } } });
  await prisma.user.deleteMany({ where: { id: { in: made.users } } });
  await prisma.$disconnect();
});

async function redis() {
  const client = new RedisClient(REDIS_URL);
  await client.connect();
  clients.push(client);
  await client.send('DEL', 'wheelers:held-bid-timeouts');
  return client;
}
async function user(role) {
  const id = randomUUID();
  await prisma.user.create({ data: { id, privyDid: `test:held:${id}`, role, name: `Held ${role}`, phone: `+23480${Math.floor(1e8 + Math.random() * 9e8)}` } });
  made.users.push(id);
  return id;
}
async function driver() {
  const userId = await user('DRIVER');
  const d = await prisma.driver.create({ data: { userId, kycStatus: 'APPROVED', status: 'ONLINE', lastSeenAt: new Date(), vehicleModel: 'Corolla', vehiclePlate: 'KJA3' } });
  made.drivers.push(d.id);
  return { id: d.id, userId };
}
function deps(redisClient) {
  const toApp = [];
  return {
    toApp,
    deps: {
      registry: { sendToUser: async (userId, type, payload) => { toApp.push({ userId, type, payload }); }, hasUser: () => false, isUserConnected: async () => false },
      redisClient,
      publisher: { publishRideEvent: async () => {}, publishNotificationEvent: async () => {}, publishWalletEvent: async () => {}, publishDriverEvent: async () => {} },
      whatsappNotifier: { metaAccessToken: 't', metaPhoneNumberId: '1' },
    },
  };
}
async function searchWithTwoBids(r, riderId) {
  const ride = await prisma.ride.create({ data: { riderId, channel: 'WHATSAPP', status: 'MATCHING', pickupLat: 6.5244, pickupLng: 3.387, pickupAddress: 'Akoka', destLat: 6.5095, destLng: 3.3711, destAddress: 'Yaba', riderOfferNgn: 3000, fareEstimateNgn: 3000, distanceKm: 3 } });
  made.rides.push(ride.id);
  const chosen = await driver();
  const other = await driver();
  for (const d of [chosen, other]) await driverBidClient.record({ rideId: ride.id, driverId: d.id, driverUserId: d.userId, riderId, amountNgn: 3200, etaSeconds: 300, distanceKm: 2 });
  await bidState.storeWhatsappRide(r, ride.id, { riderId, phone: '+2348030000001', pickupAddress: 'Akoka', destinationAddress: 'Yaba', offerNgn: 3000, suggestedFareNgn: 3000, paymentMethod: 'WALLET', createdAt: new Date().toISOString() });
  await bidState.setActiveRide(r, riderId, ride.id);
  await bidState.setPhoneLookup(r, riderId, '+2348030000001');
  // The rider chose `chosen` and went to top up.
  await bidState.storePendingAccept(r, riderId, { rideId: ride.id, driverId: chosen.id, driverUserId: chosen.userId, driverName: 'Ada', driverPhone: '', driverRating: 5, totalRides: 0, vehicleModel: 'Corolla', vehiclePlate: 'KJA3', etaSeconds: 300, fareNgn: 3200 });
  return { ride, chosen, other };
}
const timeoutOf = (ride, riderId) => ({ eventType: 'RIDE_BID_TIMEOUT', rideId: ride.id, riderId, timestamp: new Date().toISOString() });

test('the clock runs out while the rider pays: held; they never pay: the search ends then (the other driver is told, the form says nobody took it)', async () => {
  const r = await redis();
  const riderId = await user('RIDER');
  const { ride, other } = await searchWithTwoBids(r, riderId);
  const w = deps(r);

  await handleRideEvent(timeoutOf(ride, riderId), w.deps, new Map());
  assert.equal(w.toApp.filter((m) => m.type === 'ride:bid_timeout').length, 0, 'held: nobody is told the search ended');
  assert.equal(await r.send('ZCARD', 'wheelers:held-bid-timeouts'), 1, 'noted for a second look');

  // Too early: still held, nothing happens.
  await sweepHeldTimeouts(w.deps, new Map(), Date.now());
  assert.equal(w.toApp.filter((m) => m.type === 'ride:bid_timeout').length, 0);

  // The rider's choice lapses unpaid (its 15 minutes pass), then the sweep looks again.
  await bidState.clearPendingAccept(r, riderId);
  await sweepHeldTimeouts(w.deps, new Map(), Date.now() + 16 * 60_000);
  assert.ok(w.toApp.some((m) => m.type === 'ride:bid_timeout' && m.userId === other.userId), 'the other driver is told');
  assert.ok(await bidState.getSearchTimedOut(r, riderId), 'the offers form says no driver took it');
  assert.equal(await r.send('ZCARD', 'wheelers:held-bid-timeouts'), 0, 'taken once');

  // Swept again (another gateway, a later tick): nothing more.
  const before = w.toApp.length;
  await sweepHeldTimeouts(w.deps, new Map(), Date.now() + 17 * 60_000);
  assert.equal(w.toApp.length, before);
});

test('the rider paid meanwhile and the driver is booked: the second look ends nothing', async () => {
  const r = await redis();
  const riderId = await user('RIDER');
  const { ride, chosen } = await searchWithTwoBids(r, riderId);
  const w = deps(r);

  await handleRideEvent(timeoutOf(ride, riderId), w.deps, new Map());
  // The deposit landed and booked the chosen driver: the ride is theirs, the other bid lost.
  await prisma.ride.update({ where: { id: ride.id }, data: { status: 'DRIVER_ASSIGNED', driverId: chosen.id } });
  await prisma.driverBid.updateMany({ where: { rideId: ride.id, driverId: { not: chosen.id } }, data: { status: 'LOST' } });
  await prisma.driverBid.updateMany({ where: { rideId: ride.id, driverId: chosen.id }, data: { status: 'ACCEPTED' } });
  await bidState.setRideState(r, ride.id, 'confirmed');
  await bidState.clearPendingAccept(r, riderId);
  await sweepHeldTimeouts(w.deps, new Map(), Date.now() + 16 * 60_000);
  assert.equal(w.toApp.filter((m) => m.type === 'ride:bid_timeout').length, 0, 'no "search ended" over a booked ride');
  assert.equal(await bidState.getSearchTimedOut(r, riderId), null);
});

const lockLib = require('../apps/api-gateway/dist/rides/booking-lock.js');

test('still paying at the second look: held again, nothing said', async () => {
  const r = await redis();
  const riderId = await user('RIDER');
  const { ride } = await searchWithTwoBids(r, riderId);
  const w = deps(r);
  await handleRideEvent(timeoutOf(ride, riderId), w.deps, new Map());
  // The choice is still live (chosen again just now): the sweep holds it once more.
  await sweepHeldTimeouts(w.deps, new Map(), Date.now() + 16 * 60_000);
  assert.equal(w.toApp.filter((m) => m.type === 'ride:bid_timeout').length, 0);
  assert.equal(await r.send('ZCARD', 'wheelers:held-bid-timeouts'), 1, 'noted again for later');
});

test('cancelled during the hold, or moved on to a new search: nothing is said about the old one, and the new choice is kept', async () => {
  // Cancelled.
  {
    const r = await redis();
    const riderId = await user('RIDER');
    const { ride } = await searchWithTwoBids(r, riderId);
    const w = deps(r);
    await handleRideEvent(timeoutOf(ride, riderId), w.deps, new Map());
    await lockLib.markSearchEnded(r, ride.id);
    await bidState.clearPendingAccept(r, riderId);
    await sweepHeldTimeouts(w.deps, new Map(), Date.now() + 16 * 60_000);
    assert.equal(w.toApp.filter((m) => m.type === 'ride:bid_timeout').length, 0, 'no late "search ended"');
    assert.equal(await bidState.getSearchTimedOut(r, riderId), null, 'no late "no driver took it"');
  }
  // A new search, a driver chosen on it and being paid for.
  {
    const r = await redis();
    const riderId = await user('RIDER');
    const { ride } = await searchWithTwoBids(r, riderId);
    const w = deps(r);
    await handleRideEvent(timeoutOf(ride, riderId), w.deps, new Map());
    const newRide = randomUUID();
    await bidState.setActiveRide(r, riderId, newRide);
    await bidState.storePendingAccept(r, riderId, { rideId: newRide, driverId: randomUUID(), driverUserId: randomUUID(), driverName: 'Bayo', driverPhone: '', driverRating: 5, totalRides: 0, vehicleModel: 'Camry', vehiclePlate: 'KJA4', etaSeconds: 200, fareNgn: 3500 });
    await sweepHeldTimeouts(w.deps, new Map(), Date.now() + 16 * 60_000);
    assert.equal(w.toApp.filter((m) => m.type === 'ride:bid_timeout').length, 0, 'the old search says nothing');
    assert.equal((await bidState.getPendingAccept(r, riderId))?.rideId, newRide, 'the new search\'s choice is kept');
    assert.equal(await bidState.getActiveRide(r, riderId), newRide);
  }
});
