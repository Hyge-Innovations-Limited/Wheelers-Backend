// Hotfix: a live trip's route (ride:route:update) and stop confirmation (ride:stop:confirm)
// belong to the ride's rider and the driver assigned to it, and an unpriced change never
// lowers the money held below the agreed fare. Through the real entry points: handleRideMessage,
// ride-service's trip-lifecycle handler, wallet-service's ride-events consumer, real Postgres.
//
//   node scripts/run-with-env.cjs node --test --test-force-exit --test-concurrency=1 test/route-update-ownership.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');

const { TOPICS } = require('../packages/kafka-schemas/dist/index.js');
const { calculateRideFees } = require('../packages/config/dist/index.js');
const { walletClient } = require('../packages/db/dist/index.js');
const { handleRideMessage } = require('../apps/api-gateway/dist/websocket/handlers/ride.handler.js');
const { createTripLifecycleHandler } = require('../apps/ride-service/dist/handlers/trip-lifecycle.handler.js');
const { createRideEventsConsumer } = require('../apps/wallet-service/dist/consumers/ride-events.consumer.js');

const prisma = new PrismaClient();
const made = { users: [], rides: [], drivers: [] };
const realConsole = { log: console.log, info: console.info, warn: console.warn, error: console.error };
console.info = () => {}; console.log = () => {}; console.warn = () => {};

const YABA = { lat: 6.5095, lng: 3.3711, address: '12 Herbert Macaulay Way, Yaba, Lagos' };
const VI = { lat: 6.4281, lng: 3.4219, address: 'Adeola Odeku Street, Victoria Island, Lagos' };
const SURULERE = { lat: 6.4995, lng: 3.3540, address: 'Adeniran Ogunsanya Street, Surulere, Lagos' };
const IKEJA = { lat: 6.6018, lng: 3.3515, address: 'Ikeja City Mall, Obafemi Awolowo Way, Ikeja' };
const LINE = [{ lat: YABA.lat, lng: YABA.lng }, { lat: VI.lat, lng: VI.lng }];
const AGREED = 5200;
const HOLD = calculateRideFees(AGREED).totalNgn;
const CTX = { topic: TOPICS.RIDE_EVENTS, partition: 0, offset: '0', timestamp: new Date().toISOString(), headers: {} };

function memoryRedis() {
  const store = new Map();
  return {
    store,
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async set(k, v) { store.set(k, v); },
    async del(k) { store.delete(k); },
    async setIfNotExists(k, v) { if (store.has(k)) return false; store.set(k, v); return true; },
    async send(cmd, key) {
      if (cmd === 'INCR') { const n = Number(store.get(`n:${key}`) ?? 0) + 1; store.set(`n:${key}`, String(n)); return n; }
      if (cmd === 'TTL') return -1;
      if (cmd === 'GETDEL') { const v = store.has(key) ? store.get(key) : null; store.delete(key); return v; }
      return null;
    },
  };
}

function planner(fareNgn) {
  return { planRoute: async () => ({ distanceKm: 2, durationSeconds: 300, suggestedFareNgn: fareNgn, minOfferNgn: 1000, ratePerKmNgn: 420, priceReason: null, geometry: { coordinates: LINE, bounds: { northEast: VI, southWest: YABA } } }) };
}

async function makeUser(role, balanceNgn = 0) {
  const id = randomUUID();
  await prisma.user.create({ data: { id, privyDid: `local:${id}`, role, name: 'Route Test', phone: `+23480${Math.floor(1e8 + Math.random() * 9e8)}` } });
  await prisma.wallet.create({ data: { userId: id, balanceNgn } });
  made.users.push(id);
  return id;
}

async function makeDriver() {
  const userId = await makeUser('DRIVER');
  const driver = await prisma.driver.create({ data: { userId, status: 'ON_RIDE', kycStatus: 'APPROVED', lat: 6.5, lng: 3.37, lastSeenAt: new Date(), vehicleModel: 'Toyota Corolla', vehiclePlate: `LND-${Math.floor(100 + Math.random() * 900)}XA` } });
  made.drivers.push(driver.id);
  return { userId, driverId: driver.id };
}

/** A running wallet ride with its hold made, the rider holding only what is held (+ spare). */
async function trip(status = 'IN_PROGRESS', spareNgn = 0) {
  const rider = await makeUser('RIDER', HOLD + spareNgn);
  const driver = await makeDriver();
  const ride = await prisma.ride.create({
    data: {
      riderId: rider, driverId: driver.driverId, status, paymentMethod: 'WALLET',
      pickupLat: YABA.lat, pickupLng: YABA.lng, pickupAddress: YABA.address,
      destLat: VI.lat, destLng: VI.lng, destAddress: VI.address,
      agreedFareNgn: AGREED, fareEstimateNgn: AGREED, distanceKm: 11.4, durationSeconds: 1680,
    },
  });
  made.rides.push(ride.id);
  await prisma.rideStop.createMany({ data: [
    { rideId: ride.id, stopOrder: 0, type: 'FINAL', status: 'PENDING', lat: VI.lat, lng: VI.lng, address: VI.address },
  ] });
  const wallet = await walletClient.findByUserId(rider);
  await walletClient.createRideHold({ rideId: ride.id, walletId: wallet.id, riderId: rider, driverUserId: driver.userId, amountNgn: HOLD });
  return { rider, driver, ride };
}

function gateway() {
  const events = [];
  return { events, publisher: { publishRideEvent: async (e) => { events.push(e); } }, redis: memoryRedis() };
}

/** What the services do with the event the gateway published: ride-service, then wallet-service. */
async function runServices(event) {
  const updated = [];
  const lifecycle = createTripLifecycleHandler({ rideEventsProducer: { rideRouteUpdated: async (e) => { updated.push(e); } } });
  await lifecycle.handleRideEvent(JSON.parse(JSON.stringify(event)), CTX);
  const consumer = createRideEventsConsumer({
    walletRepository: walletClient,
    walletEventsProducer: { publishHoldAdjusted: async () => {}, publishLocked: async () => {}, publishUnlocked: async () => {}, publishDebited: async () => {}, publishCredited: async () => {} },
  });
  for (const u of updated) await consumer.handle(JSON.parse(JSON.stringify(u)), CTX);
  return updated;
}

const holdOf = async (rideId) => Number((await prisma.rideHold.findUnique({ where: { rideId } })).amountNgn);
const balanceOf = async (userId) => Number((await prisma.wallet.findFirst({ where: { userId } })).balanceNgn);
const update = (w, payload, auth, plan = planner(1500)) => handleRideMessage('ride:route:update', payload, auth, w.publisher, plan, w.redis);

test.after(async () => {
  Object.assign(console, realConsole);
  await prisma.rideHold.deleteMany({ where: { rideId: { in: made.rides } } });
  await prisma.rideStop.deleteMany({ where: { rideId: { in: made.rides } } });
  await prisma.ride.deleteMany({ where: { id: { in: made.rides } } }).catch(() => {});
  const wallets = (await prisma.wallet.findMany({ where: { userId: { in: made.users } }, select: { id: true } })).map((x) => x.id);
  await prisma.transaction.deleteMany({ where: { OR: [{ walletId: { in: wallets } }, { referenceId: { in: made.rides } }] } }).catch(() => {});
  await prisma.wallet.deleteMany({ where: { id: { in: wallets } } }).catch(() => {});
  await prisma.driver.deleteMany({ where: { id: { in: made.drivers } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: made.users } } }).catch(() => {});
  await prisma.$disconnect();
});

test('a stranger rider cannot change the route of a ride that is not theirs', async () => {
  const { ride } = await trip();
  const stranger = await makeUser('RIDER');
  const w = gateway();
  await assert.rejects(update(w, { rideId: ride.id, destination: IKEJA, stops: [] }, { userId: stranger, role: 'RIDER' }), /not yours/);
  await assert.rejects(update(w, { rideId: ride.id, riderId: stranger, destination: IKEJA, stops: [], acceptedFareNgn: 1500 }, { userId: stranger, role: 'RIDER' }), /not yours/);
  assert.equal(w.events.length, 0, 'nothing published');
  assert.equal(await holdOf(ride.id), HOLD);
});

test('a stranger driver cannot change the route either', async () => {
  const { ride } = await trip();
  const other = await makeDriver();
  const w = gateway();
  await assert.rejects(update(w, { rideId: ride.id, driverId: other.driverId, destination: IKEJA, stops: [] }, { userId: other.userId, driverId: other.driverId, role: 'DRIVER' }), /not yours/);
  await assert.rejects(handleRideMessage('ride:stop:confirm', { rideId: ride.id, riderId: randomUUID() }, { userId: other.userId, driverId: other.driverId, role: 'DRIVER' }, w.publisher, {}, w.redis), /not yours/);
  assert.equal(w.events.length, 0);
});

test('the payload riderId / driverId are ignored: the event carries the ride\'s own', async () => {
  const { rider, driver, ride } = await trip();
  const liar = await makeUser('RIDER');
  const w = gateway();
  await update(w, { rideId: ride.id, riderId: liar, driverId: randomUUID(), destination: IKEJA, stops: [] }, { userId: rider, role: 'RIDER' });
  assert.equal(w.events[0].riderId, rider);
  assert.equal(w.events[0].driverId, driver.driverId);
  assert.equal(w.events[0].updatedBy, 'rider');
  assert.equal(w.events[0].priced, false);
});

test('the owning rider, unpriced, near the end of the trip: the hold is NOT lowered and settlement pays the agreed fare', async () => {
  const { rider, driver, ride } = await trip('IN_PROGRESS');
  const w = gateway();
  // The old app: no acceptedFareNgn, an origin near the destination, so the rest-of-trip fare is tiny.
  await update(w, { rideId: ride.id, riderId: rider, origin: { lat: VI.lat + 0.001, lng: VI.lng, address: VI.address }, destination: VI, stops: [] }, { userId: rider, role: 'RIDER' }, planner(1500));
  assert.equal(w.events[0].fareEstimateNgn, 1500, 'the gateway plans it');
  const updated = await runServices(w.events[0]);
  assert.equal(updated[0].fareEstimateNgn, AGREED, 'ride-service keeps the agreed fare');
  assert.equal(await holdOf(ride.id), HOLD, 'the hold did not move');
  assert.equal(await balanceOf(rider), 0, 'nothing freed to withdraw');
  assert.equal(Number((await prisma.ride.findUnique({ where: { id: ride.id } })).fareEstimateNgn), AGREED);

  const consumer = createRideEventsConsumer({ walletRepository: walletClient, walletEventsProducer: new Proxy({}, { get: () => async () => {} }) });
  await consumer.handle({ eventType: 'RIDE_COMPLETED', rideId: ride.id, riderId: rider, driverId: driver.driverId, driverUserId: driver.userId, fareNgn: AGREED, distanceKm: 3, durationSeconds: 600, paymentMethod: 'WALLET', endedBy: 'both_confirmed', completedAt: new Date().toISOString(), timestamp: new Date().toISOString() }, CTX);
  assert.equal(await balanceOf(driver.userId), calculateRideFees(AGREED).driverPayoutNgn, 'the driver is paid the agreed fare');
});

test('wallet-service backstop: an unpriced RIDE_ROUTE_UPDATED with a low estimate cannot lower the hold', async () => {
  const { rider, ride } = await trip();
  const consumer = createRideEventsConsumer({ walletRepository: walletClient, walletEventsProducer: new Proxy({}, { get: () => async () => {} }) });
  const base = { eventType: 'RIDE_ROUTE_UPDATED', rideId: ride.id, riderId: rider, destination: VI, stops: [], fareEstimateNgn: 900, updatedBy: 'rider', timestamp: new Date().toISOString() };
  await consumer.handle(base, CTX);
  assert.equal(await holdOf(ride.id), HOLD);
  await consumer.handle({ ...base, priced: false }, CTX);
  assert.equal(await holdOf(ride.id), HOLD);
});

test('the assigned driver changing the destination: the route moves, the hold is unchanged', async () => {
  const { driver, ride, rider } = await trip('DRIVER_EN_ROUTE');
  const w = gateway();
  const auth = { userId: driver.userId, driverId: driver.driverId, role: 'DRIVER' };
  const answer = await update(w, { rideId: ride.id, riderId: driver.userId, origin: YABA, destination: IKEJA, stops: [], acceptedFareNgn: 1500 }, auth, planner(1500));
  assert.equal(answer.type, 'ride:route:update:accepted');
  assert.equal(w.events[0].updatedBy, 'driver');
  assert.equal(w.events[0].riderId, rider);
  assert.equal(w.events[0].priced, false, 'a driver\'s accepted price is not a rider\'s');
  await runServices(w.events[0]);
  assert.equal(await holdOf(ride.id), HOLD);
  const stop = await prisma.rideStop.findFirst({ where: { rideId: ride.id, type: 'FINAL' } });
  assert.equal(stop.lat, IKEJA.lat, 'the destination did move');
});

test('a user with a driver record who is the ride\'s RIDER is the rider: the priced path still runs', async () => {
  const { rider, ride } = await trip('IN_PROGRESS', 3000);
  const mine = await makeDriver();
  const w = gateway();
  const auth = { userId: rider, driverId: mine.driverId, role: 'BOTH' };
  const refused = await update(w, { rideId: ride.id, destination: IKEJA, stops: [], acceptedFareNgn: 4000 }, auth, planner(6000));
  assert.deepEqual([refused.type, refused.payload.reason, refused.payload.fareNgn], ['ride:route:update:rejected', 'PRICE_CHANGED', 6000]);
  assert.equal(w.events.length, 0);
});

test('the priced path still works: the hold moves to exactly the accepted price', async () => {
  const { rider, ride } = await trip('IN_PROGRESS', 3000);
  const w = gateway();
  const auth = { userId: rider, role: 'RIDER' };
  const plan = planner(6000);
  const quote = await handleRideMessage('ride:route:quote', { rideId: ride.id, destination: IKEJA, stops: [] }, auth, w.publisher, plan, w.redis);
  assert.equal(quote.payload.fareNgn, 6000);
  const done = await update(w, { rideId: ride.id, destination: IKEJA, stops: [], acceptedFareNgn: 6000 }, auth, plan);
  assert.equal(done.type, 'ride:route:update:accepted');
  assert.equal(w.events[0].priced, true);
  await runServices(w.events[0]);
  assert.equal(await holdOf(ride.id), calculateRideFees(6000).totalNgn);
});

test('a ride that is not running (requested, completed, cancelled) is refused', async () => {
  for (const status of ['MATCHING', 'COMPLETED', 'CANCELLED']) {
    const { rider, driver, ride } = await trip(status);
    const w = gateway();
    await assert.rejects(update(w, { rideId: ride.id, destination: IKEJA, stops: [] }, { userId: rider, role: 'RIDER' }), /not running/, status);
    await assert.rejects(update(w, { rideId: ride.id, destination: IKEJA, stops: [] }, { userId: driver.userId, driverId: driver.driverId, role: 'DRIVER' }), /not running/, status);
    assert.equal(w.events.length, 0);
  }
});

test('ride:stop:confirm: the rider or assigned driver only, ids from the ride', async () => {
  const { rider, driver, ride } = await trip('IN_PROGRESS');
  const stranger = await makeUser('RIDER');
  const w = gateway();
  await assert.rejects(handleRideMessage('ride:stop:confirm', { rideId: ride.id, riderId: rider, driverId: driver.driverId }, { userId: stranger, role: 'RIDER' }, w.publisher, {}, w.redis), /not yours/);
  assert.equal(w.events.length, 0);
  await handleRideMessage('ride:stop:confirm', { rideId: ride.id, riderId: stranger, driverId: randomUUID() }, { userId: rider, role: 'RIDER' }, w.publisher, {}, w.redis);
  await handleRideMessage('ride:stop:confirm', { rideId: ride.id }, { userId: driver.userId, driverId: driver.driverId, role: 'DRIVER' }, w.publisher, {}, w.redis);
  assert.deepEqual(w.events.map((e) => [e.riderId, e.driverId, e.confirmedBy]), [[rider, driver.driverId, 'rider'], [rider, driver.driverId, 'driver']]);
});

const walletConsumer = () => createRideEventsConsumer({ walletRepository: walletClient, walletEventsProducer: new Proxy({}, { get: () => async () => {} }) });

test('a priced re-quote of the unchanged route near the end cannot cut the hold; the driver is paid the full agreed fare even after the rider withdraws', async () => {
  const { rider, driver, ride } = await trip('IN_PROGRESS');
  const w = gateway();
  const auth = { userId: rider, role: 'RIDER' };
  const plan = planner(1500);
  await handleRideMessage('ride:route:quote', { rideId: ride.id, destination: VI, stops: [] }, auth, w.publisher, plan, w.redis);
  await update(w, { rideId: ride.id, destination: VI, stops: [], acceptedFareNgn: 1500 }, auth, plan);
  assert.equal(w.events[0].priced, true);
  await runServices(w.events[0]);
  assert.equal(await holdOf(ride.id), HOLD);
  assert.equal(await balanceOf(rider), 0, 'nothing freed to withdraw');
  await walletConsumer().handle({ eventType: 'RIDE_COMPLETED', rideId: ride.id, riderId: rider, driverId: driver.driverId, driverUserId: driver.userId, fareNgn: AGREED, distanceKm: 3, durationSeconds: 600, paymentMethod: 'WALLET', endedBy: 'both_confirmed', completedAt: new Date().toISOString(), timestamp: new Date().toISOString() }, CTX);
  assert.equal(await balanceOf(driver.userId), calculateRideFees(AGREED).driverPayoutNgn);
});

test('wallet-service: no route event, priced or not, sets the hold below the agreed fare', async () => {
  const { rider, ride } = await trip();
  const base = { eventType: 'RIDE_ROUTE_UPDATED', rideId: ride.id, riderId: rider, destination: VI, stops: [], fareEstimateNgn: 900, updatedBy: 'rider', timestamp: new Date().toISOString() };
  await walletConsumer().handle({ ...base, priced: true }, CTX);
  assert.equal(await holdOf(ride.id), HOLD);
});

test('a priced ADD stop still raises the hold', async () => {
  const { rider, ride } = await trip('IN_PROGRESS', 3000);
  const w = gateway();
  const auth = { userId: rider, role: 'RIDER' };
  const plan = planner(6000);
  await handleRideMessage('ride:route:quote', { rideId: ride.id, destination: VI, stops: [IKEJA] }, auth, w.publisher, plan, w.redis);
  await update(w, { rideId: ride.id, destination: VI, stops: [IKEJA], acceptedFareNgn: 6000 }, auth, plan);
  await runServices(w.events[0]);
  assert.equal(await holdOf(ride.id), calculateRideFees(6000).totalNgn);
});

test('a wallet-side ride lookup failure leaves the hold unchanged', async () => {
  const { rider, ride } = await trip('IN_PROGRESS', 3000);
  const { rideClient } = require('../packages/db/dist/index.js');
  const real = rideClient.findById;
  rideClient.findById = async () => { throw new Error('db down'); };
  const realErr = console.error; console.error = () => {};
  try {
    await walletConsumer().handle({ eventType: 'RIDE_ROUTE_UPDATED', rideId: ride.id, riderId: rider, destination: VI, stops: [], fareEstimateNgn: 9000, priced: true, updatedBy: 'rider', timestamp: new Date().toISOString() }, CTX);
  } finally { rideClient.findById = real; console.error = realErr; }
  assert.equal(await holdOf(ride.id), HOLD);
});

test('ride-service skips an update from a driver no longer assigned, and on a completed ride', async () => {
  const { rider, driver, ride } = await trip('DRIVER_EN_ROUTE');
  const ev = (by, driverId) => ({ eventType: 'RIDE_ROUTE_UPDATE_REQUESTED', rideId: ride.id, riderId: rider, driverId, destination: IKEJA, stops: [], updatedBy: by, priced: false, timestamp: new Date().toISOString() });
  const finalStop = () => prisma.rideStop.findFirst({ where: { rideId: ride.id, type: 'FINAL' } });
  await runServices(ev('driver', randomUUID()));
  assert.equal((await finalStop()).lat, VI.lat, 'a driver who is not the assigned one moves nothing');
  await prisma.ride.update({ where: { id: ride.id }, data: { status: 'COMPLETED' } });
  await runServices(ev('rider', driver.driverId));
  assert.equal((await finalStop()).lat, VI.lat, 'a completed ride moves nothing');
});

test('the route quote is refused on a ride that is not running, and is rate-limited', async () => {
  const done = await trip('COMPLETED');
  const w = gateway();
  await assert.rejects(handleRideMessage('ride:route:quote', { rideId: done.ride.id, destination: VI, stops: [] }, { userId: done.rider, role: 'RIDER' }, w.publisher, planner(5000), w.redis), /not running/);
  const { rider, ride } = await trip('IN_PROGRESS');
  let refused = 0;
  for (let i = 0; i < 12; i += 1) {
    await handleRideMessage('ride:route:quote', { rideId: ride.id, destination: VI, stops: [] }, { userId: rider, role: 'RIDER' }, w.publisher, planner(5000), w.redis).catch((e) => { if (/Too many/.test(e.message)) refused += 1; });
  }
  assert.equal(refused, 2);
});
