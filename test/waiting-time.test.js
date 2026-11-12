// Waiting time (Timi, 12 Nov 2026): 5 minutes free after the driver arrives, then ₦70 a minute until the
// trip starts. Taken from the rider's wallet at the start when it covers it (held, then all of it to the
// driver when the trip ends; back to the rider if it is cancelled). When it does not: the driver is asked
// once and the meter stops there; an older driver app is never stopped. Through the real ride:start socket,
// a real Redis (database 15) and a real Postgres.
//
//   node scripts/run-with-env.cjs node --test --test-force-exit test/waiting-time.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const WebSocket = require('../apps/api-gateway/node_modules/ws');

const { RedisClient } = require('../apps/api-gateway/dist/redis/client.js');
const { SocketRegistry } = require('../apps/api-gateway/dist/websocket/registry.js');
const { createGatewayWebSocketServer } = require('../apps/api-gateway/dist/websocket/server.js');
const { waitingView, waitingLineForRider } = require('../apps/api-gateway/dist/rides/waiting.js');
const { createRideEventsConsumer } = require('../apps/wallet-service/dist/consumers/ride-events.consumer.js');
const local = require('../apps/api-gateway/dist/auth/local.js');
const { waitingClient, waitingReference, rideClient } = require('../packages/db/dist/index.js');
const { waitingCharge, waitingTerms } = require('../packages/config/dist/index.js');

const REDIS_URL = process.env.TEST_REDIS_URL || 'redis://127.0.0.1:6379/15';
const JWT_SECRET = 'test-secret-that-is-at-least-32-characters-long';
const prisma = new PrismaClient();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const minutesAgo = (m, s = 0) => new Date(Date.now() - (m * 60 + s) * 1000);

const clients = [];
async function redis() {
  const client = new RedisClient(REDIS_URL);
  await client.connect();
  clients.push(client);
  return client;
}

const made = { users: [], rides: [] };
async function user(role, name, balanceNgn) {
  const id = randomUUID();
  await prisma.user.create({ data: { id, privyDid: `test:waiting:${id}`, role, name } });
  if (balanceNgn !== undefined) await prisma.wallet.create({ data: { userId: id, balanceNgn } });
  made.users.push(id);
  return id;
}
/** A driver waiting at the pickup since `arrivedAt`; the rider's wallet holds `balanceNgn`. */
async function waitingTrip({ arrivedAt, balanceNgn = 0, paymentMethod = 'WALLET' }) {
  const riderId = await user('RIDER', 'Ada Obi', balanceNgn);
  const driverUserId = await user('DRIVER', 'Tunde Bakare', 0);
  const driver = await prisma.driver.create({ data: { userId: driverUserId, kycStatus: 'APPROVED' } });
  const ride = await prisma.ride.create({ data: {
    riderId, driverId: driver.id, status: 'ARRIVED', arrivedAt, paymentMethod,
    pickupLat: 6.5, pickupLng: 3.37, pickupAddress: 'Yaba', destLat: 6.62, destLng: 3.5, destAddress: 'Ikorodu',
  } });
  made.rides.push(ride.id);
  return { rideId: ride.id, riderId, driverUserId };
}
const wallet = async (userId) => {
  const w = await prisma.wallet.findUnique({ where: { userId } });
  return w ? { balance: Number(w.balanceNgn), locked: Number(w.lockedNgn) } : null;
};

const published = [];
let g;
test.before(async () => {
  console.info = () => {};
  console.warn = () => {};
  console.error = () => {};
  const commandRedis = await redis();
  await commandRedis.send('FLUSHDB');
  const registry = new SocketRegistry({ instanceId: `waiting-${randomUUID()}`, commandRedis, subscriberRedis: await redis() });
  await registry.start();
  const server = http.createServer((req, res) => { res.statusCode = 404; res.end(); });
  createGatewayWebSocketServer({
    server, jwtSecret: JWT_SECRET, allowedOrigins: new Set(), idleTimeoutMs: 60_000, registry,
    publisher: { publishRideEvent: async (e) => { published.push(e); }, publishDriverEvent: async () => {} },
    routePlanner: {}, redis: commandRedis,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  g = { server, registry, port: server.address().port };
});

const sockets = [];
function open(userId) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${g.port}/ws?token=${local.createLocalAccessToken(userId, JWT_SECRET)}`);
    socket.inbox = [];
    socket.on('message', (raw) => socket.inbox.push(JSON.parse(raw.toString())));
    socket.once('open', () => { sockets.push(socket); resolve(socket); });
    socket.once('error', reject);
  });
}
/** Start the trip as a driver app would; the answer: STARTED, or the refusal (code and details). */
async function start(socket, trip, extra = {}) {
  socket.inbox.length = 0;
  socket.send(JSON.stringify({ type: 'ride:start', payload: { rideId: trip.rideId, riderId: trip.riderId, lockedFareNgn: 5000, paymentMethod: 'WALLET', ...extra } }));
  const end = Date.now() + 4000;
  while (Date.now() < end) {
    const hit = socket.inbox.find((m) => m.type === 'ride:start:accepted' || m.type === 'error');
    if (hit) return hit.type === 'error' ? { code: hit.payload.code ?? hit.payload.message, details: hit.payload.details, message: hit.payload.message } : { code: 'STARTED' };
    await sleep(20);
  }
  throw new Error('no answer to ride:start');
}
const NEW_APP = { canConfirmWaiting: true };
const startedEvents = (rideId) => published.filter((e) => e.eventType === 'RIDE_STARTED' && e.rideId === rideId).length;

const walletConsumer = () => createRideEventsConsumer({ walletRepository: { completeRideHoldWithDriverPayout: async () => null, cancelRideHold: async () => null }, walletEventsProducer: new Proxy({}, { get: () => async () => {} }) });
const completed = (trip) => ({ eventType: 'RIDE_COMPLETED', rideId: trip.rideId, riderId: trip.riderId, driverId: randomUUID(), driverUserId: trip.driverUserId, fareNgn: 5000, distanceKm: 20, durationSeconds: 1800, endedBy: 'both_confirmed', paymentMethod: 'WALLET', completedAt: new Date().toISOString(), timestamp: new Date().toISOString() });
const cancelled = (trip) => ({ eventType: 'RIDE_CANCELLED', rideId: trip.rideId, riderId: trip.riderId, cancelledBy: 'driver', timestamp: new Date().toISOString() });

test('the rule: 5 minutes free, then ₦70 for each full minute', () => {
  const at = new Date('2026-11-12T10:00:00Z');
  const after = (s) => new Date(at.getTime() + s * 1000);
  assert.deepEqual(waitingTerms(), { freeSeconds: 300, ngnPerMinute: 70 });
  assert.equal(waitingCharge(at, after(299)).feeNgn, 0);
  assert.equal(waitingCharge(at, after(300)).feeNgn, 0, 'the 5th minute is free');
  assert.equal(waitingCharge(at, after(359)).feeNgn, 0, 'a part minute is not charged');
  assert.deepEqual(waitingCharge(at, after(360)), { waitedSeconds: 360, chargedMinutes: 1, feeNgn: 70 });
  assert.deepEqual(waitingCharge(at, after(9 * 60 + 59)), { waitedSeconds: 599, chargedMinutes: 4, feeNgn: 280 });
  assert.equal(waitingCharge(null, after(900)).feeNgn, 0, 'no arrival, no fee');
  assert.equal(waitingCharge(after(10), at).feeNgn, 0, 'a clock going backwards is no fee');
});

test('wallet covers it: held at the start, all of it paid to the driver at the end, once', async () => {
  const trip = await waitingTrip({ arrivedAt: minutesAgo(9, 30), balanceNgn: 1000 });
  const driver = await open(trip.driverUserId);
  assert.equal((await start(driver, trip, NEW_APP)).code, 'STARTED', 'no question when the wallet covers it');
  assert.equal(startedEvents(trip.rideId), 1);

  const ride = await waitingClient.state(trip.rideId);
  assert.deepEqual([ride.waitingMinutes, Number(ride.waitingFeeNgn), ride.waitingPaid], [4, 280, true]);
  assert.deepEqual(await wallet(trip.riderId), { balance: 720, locked: 280 }, 'held, not spendable during the trip');

  // A retried start takes nothing more.
  assert.equal((await start(driver, trip, NEW_APP)).code, 'STARTED');
  assert.deepEqual(await wallet(trip.riderId), { balance: 720, locked: 280 });

  const consumer = walletConsumer();
  await consumer.handle(completed(trip), {});
  await consumer.handle(completed(trip), {});   // redelivered
  assert.deepEqual(await wallet(trip.riderId), { balance: 720, locked: 0 });
  assert.deepEqual(await wallet(trip.driverUserId), { balance: 280, locked: 0 }, 'all of it to the driver, once');
  const ledger = await prisma.transaction.findMany({ where: { referenceId: trip.rideId, type: 'WAITING_FEE' }, orderBy: { direction: 'asc' } });
  assert.deepEqual(ledger.map((t) => [t.direction, Number(t.amountNgn)]), [['CREDIT', 280], ['DEBIT', 280]]);
  const reservation = await prisma.walletReservation.findUnique({ where: { referenceId: waitingReference(trip.rideId) } });
  assert.equal(reservation.status, 'CONSUMED');
});

test('wallet short: the driver is asked once, the meter stops there, Yes starts it as not paid', async () => {
  const trip = await waitingTrip({ arrivedAt: minutesAgo(9, 30), balanceNgn: 100 });
  const driver = await open(trip.driverUserId);
  const asked = await start(driver, trip, NEW_APP);
  assert.equal(asked.code, 'WAITING_UNPAID');
  assert.equal(asked.details.minutes, 4);
  assert.equal(asked.details.amountNgn, 280);
  assert.match(asked.message, /owes ₦280 waiting time \(4 min\)/);
  assert.equal(startedEvents(trip.rideId), 0, 'not started');
  const stopped = (await waitingClient.state(trip.rideId)).waitingStoppedAt;
  assert.ok(stopped, 'the meter stopped when the driver was asked');
  assert.equal(stopped.toISOString(), asked.details.stoppedAt);

  // Time passes (the driver tapped No, or is thinking): the meter does not run on.
  await prisma.ride.update({ where: { id: trip.rideId }, data: { arrivedAt: new Date(Date.parse(stopped) - (9 * 60 + 30) * 1000) } });
  assert.equal((await start(driver, trip, { ...NEW_APP, startAnyway: true })).code, 'STARTED');
  const ride = await waitingClient.state(trip.rideId);
  assert.deepEqual([ride.waitingMinutes, Number(ride.waitingFeeNgn), ride.waitingPaid], [4, 280, false]);
  assert.deepEqual(await wallet(trip.riderId), { balance: 100, locked: 0 }, 'nothing taken: they settle in person');
  assert.equal(await prisma.walletReservation.count({ where: { referenceId: waitingReference(trip.rideId) } }), 0);

  await walletConsumer().handle(completed(trip), {});
  assert.deepEqual(await wallet(trip.driverUserId), { balance: 0, locked: 0 }, 'nothing paid out that was not taken');
});

test('after No, the next Start is not asked again (and the meter stays stopped)', async () => {
  const trip = await waitingTrip({ arrivedAt: minutesAgo(12), balanceNgn: 0 });
  const driver = await open(trip.driverUserId);
  assert.equal((await start(driver, trip, NEW_APP)).code, 'WAITING_UNPAID');
  // The driver tapped No and later taps Start again.
  await sleep(1100);
  assert.equal((await start(driver, trip, NEW_APP)).code, 'STARTED');
  const ride = await waitingClient.state(trip.rideId);
  assert.deepEqual([ride.waitingMinutes, Number(ride.waitingFeeNgn), ride.waitingPaid], [7, 490, false]);
});

test('an older driver app is never stopped; a cash ride is never taken from the wallet', async () => {
  const old = await waitingTrip({ arrivedAt: minutesAgo(8, 10), balanceNgn: 0 });
  assert.equal((await start(await open(old.driverUserId), old)).code, 'STARTED', 'no question an old app cannot answer');
  const oldRide = await waitingClient.state(old.rideId);
  assert.deepEqual([oldRide.waitingMinutes, Number(oldRide.waitingFeeNgn), oldRide.waitingPaid], [3, 210, false]);

  const cash = await waitingTrip({ arrivedAt: minutesAgo(8, 10), balanceNgn: 5000, paymentMethod: 'CASH' });
  const driver = await open(cash.driverUserId);
  assert.equal((await start(driver, cash, NEW_APP)).code, 'WAITING_UNPAID', 'cash: the driver is asked');
  assert.equal((await start(driver, cash, { ...NEW_APP, startAnyway: true })).code, 'STARTED');
  assert.deepEqual(await wallet(cash.riderId), { balance: 5000, locked: 0 }, 'a cash rider\'s wallet is not touched');
});

test('within the free 5 minutes: no fee, nothing written, nothing asked', async () => {
  const trip = await waitingTrip({ arrivedAt: minutesAgo(4, 50), balanceNgn: 0 });
  assert.equal((await start(await open(trip.driverUserId), trip, NEW_APP)).code, 'STARTED');
  const ride = await waitingClient.state(trip.rideId);
  assert.deepEqual([ride.waitingMinutes, ride.waitingFeeNgn, ride.waitingPaid, ride.waitingStoppedAt], [null, null, null, null]);
});

test('cancelled after the start: the held fee goes back to the rider, and is never paid out after', async () => {
  const trip = await waitingTrip({ arrivedAt: minutesAgo(7, 5), balanceNgn: 500 });
  assert.equal((await start(await open(trip.driverUserId), trip, NEW_APP)).code, 'STARTED');
  assert.deepEqual(await wallet(trip.riderId), { balance: 360, locked: 140 });
  const consumer = walletConsumer();
  await consumer.handle(cancelled(trip), {});
  await consumer.handle(cancelled(trip), {});
  assert.deepEqual(await wallet(trip.riderId), { balance: 500, locked: 0 }, 'back, once');
  assert.equal((await waitingClient.state(trip.rideId)).waitingPaid, false);
  await consumer.handle(completed(trip), {});
  assert.equal(await wallet(trip.driverUserId).then((w) => w.balance), 0);
});

test('the waiting clock starts at the first Arrived: a second tap (or a redelivered event) does not restart it', async () => {
  const trip = await waitingTrip({ arrivedAt: minutesAgo(3), balanceNgn: 0 });
  const before = (await waitingClient.state(trip.rideId)).arrivedAt.toISOString();
  await rideClient.markArrived(trip.rideId);
  assert.equal((await waitingClient.state(trip.rideId)).arrivedAt.toISOString(), before);
  // A new driver after a re-match comes from another status: a fresh clock, and no stop left over.
  await prisma.ride.update({ where: { id: trip.rideId }, data: { status: 'DRIVER_EN_ROUTE', waitingStoppedAt: new Date() } });
  await rideClient.markArrived(trip.rideId);
  const again = await waitingClient.state(trip.rideId);
  assert.ok(again.arrivedAt.getTime() > Date.parse(before));
  assert.equal(again.waitingStoppedAt, null);
});

test('what the screens get: terms, the server clock, the fee once written; the rider\'s line', async () => {
  const view = waitingView({ arrivedAt: new Date('2026-11-12T10:00:00Z'), waitingStoppedAt: null, waitingMinutes: 4, waitingFeeNgn: 280, waitingPaid: true });
  assert.equal(view.freeSeconds, 300);
  assert.equal(view.ngnPerMinute, 70);
  assert.ok(Math.abs(Date.parse(view.now) - Date.now()) < 5000);
  assert.deepEqual([view.arrivedAt, view.stoppedAt, view.minutes, view.feeNgn, view.paid], ['2026-11-12T10:00:00.000Z', null, 4, 280, true]);
  assert.equal(waitingView({ arrivedAt: null }), null, 'not arrived: nothing');
  assert.equal(waitingLineForRider({ minutes: 4, feeNgn: 280, paid: true }), 'Waiting time: 4 min · ₦280, paid from your wallet.');
  assert.equal(waitingLineForRider({ minutes: 4, feeNgn: 280, paid: false }), "Waiting time: 4 min · ₦280. Your wallet couldn't cover it, so pay your driver.");
  assert.equal(waitingLineForRider({ minutes: 0, feeNgn: 0, paid: false }), null);
});

test('"free waiting is over" finds only rides whose free minutes just ran out, still waiting', async () => {
  const due = await waitingTrip({ arrivedAt: minutesAgo(5, 10) });
  const early = await waitingTrip({ arrivedAt: minutesAgo(4) });
  const long = await waitingTrip({ arrivedAt: minutesAgo(30) });
  const stopped = await waitingTrip({ arrivedAt: minutesAgo(5, 10) });
  await prisma.ride.update({ where: { id: stopped.rideId }, data: { waitingStoppedAt: new Date() } });
  const found = (await waitingClient.freeTimeEnded(new Date(Date.now() - 60_000), new Date(), 300)).map((r) => r.id);
  assert.ok(found.includes(due.rideId));
  for (const other of [early, long, stopped]) assert.ok(!found.includes(other.rideId));
});

test.after(async () => {
  for (const s of sockets) { try { s.terminate(); } catch { /* closed */ } }
  await g.registry.shutdown().catch(() => {});
  await new Promise((resolve) => g.server.close(resolve));
  await prisma.walletReservation.deleteMany({ where: { userId: { in: made.users } } });
  await prisma.transaction.deleteMany({ where: { referenceId: { in: made.rides } } });
  await prisma.wallet.deleteMany({ where: { userId: { in: made.users } } });
  await prisma.ride.deleteMany({ where: { id: { in: made.rides } } });
  await prisma.driver.deleteMany({ where: { userId: { in: made.users } } });
  await prisma.user.deleteMany({ where: { id: { in: made.users } } });
  await prisma.$disconnect();
  for (const c of clients) await c.disconnect().catch(() => {});
});
