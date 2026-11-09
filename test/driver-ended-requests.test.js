/**
 * A driver's app away (closed, in the background) when a request ended: on
 * the next connect, every request they were shown that is over is told, in
 * the live socket's words, so it leaves the screen.
 *
 *   npm run build && node scripts/run-with-env.cjs node --test test/driver-ended-requests.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const { handleRideEvent } = require('../apps/api-gateway/dist/kafka/consumer.js');
const { endedNoticeOf, tellEndedRequests } = require('../apps/api-gateway/dist/websocket/driver-ended-requests.js');

const prisma = new PrismaClient();
const made = { users: [], rides: [], drivers: [] };

test.after(async () => {
  await prisma.ride.deleteMany({ where: { id: { in: made.rides } } });
  await prisma.driver.deleteMany({ where: { id: { in: made.drivers } } });
  await prisma.user.deleteMany({ where: { id: { in: made.users } } });
  await prisma.$disconnect();
});

/** Sets only, as the gateway keeps them. */
function memoryRedis() {
  const sets = new Map();
  const set = (k) => { if (!sets.has(k)) sets.set(k, new Set()); return sets.get(k); };
  return {
    async get() { return null; },
    async set() {},
    async del() {},
    async send(cmd, key, ...values) {
      if (cmd === 'SADD') { for (const v of values) set(key).add(v); return values.length; }
      if (cmd === 'SREM') { for (const v of values) set(key).delete(v); return values.length; }
      if (cmd === 'SMEMBERS') return [...(sets.get(key) ?? [])];
      return null;
    },
  };
}
async function user(role) {
  const id = randomUUID();
  await prisma.user.create({ data: { id, privyDid: `test:ended-requests:${id}`, role, name: `Ada ${role}` } });
  made.users.push(id);
  return id;
}
async function driver() {
  const userId = await user('DRIVER');
  const d = await prisma.driver.create({ data: { userId, kycStatus: 'APPROVED', status: 'ONLINE', lastSeenAt: new Date(), vehicleModel: 'Corolla', vehiclePlate: 'KJA1' } });
  made.drivers.push(d.id);
  return { id: d.id, userId };
}
async function ride(riderId, data = {}) {
  const r = await prisma.ride.create({ data: { riderId, status: 'MATCHING', pickupLat: 6.5244, pickupLng: 3.387, pickupAddress: 'Akoka', destLat: 6.5095, destLng: 3.3711, destAddress: 'Yaba', riderOfferNgn: 3000, fareEstimateNgn: 3000, ...data } });
  made.rides.push(r.id);
  return r;
}

test('what each ended request says: rider cancelled (or replaced it), search ended, booked by someone else; nothing while open or when the trip is ours', () => {
  const r = (status, extra = {}) => ({ id: 'r1', status, driverId: null, cancelledBy: null, cancelReason: null, ...extra });
  assert.equal(endedNoticeOf(r('MATCHING'), 'd1'), null);
  assert.equal(endedNoticeOf(r('REQUESTED'), 'd1'), null);
  assert.deepEqual(endedNoticeOf(r('CANCELLED', { cancelledBy: 'rider' }), 'd1'), { type: 'ride:bid_timeout', payload: { rideId: 'r1', reason: 'rider_cancelled' } });
  assert.deepEqual(endedNoticeOf(r('CANCELLED', { cancelledBy: 'system', cancelReason: 'Replaced by a newer request' }), 'd1').payload.reason, 'rider_cancelled');
  assert.deepEqual(endedNoticeOf(r('CANCELLED', { cancelledBy: 'system' }), 'd1').payload.reason, 'timed_out');
  assert.deepEqual(endedNoticeOf(r('DRIVER_ASSIGNED', { driverId: 'd2' }), 'd1'), { type: 'ride:bid_lost', payload: { rideId: 'r1', reason: 'booked_other' } });
  assert.equal(endedNoticeOf(r('IN_PROGRESS', { driverId: 'd1' }), 'd1'), null, 'our own trip: the active-ride resync has it');
});

test('a driver shown a request while away: on connect, the cancelled one is told once; the open one is left alone', async () => {
  const riderId = await user('RIDER');
  const d = await driver();
  const cancelled = await ride(riderId);
  const open = await ride(riderId);
  const redis = memoryRedis();
  const offer = (r) => ({
    eventType: 'RIDE_OFFER_SENT', rideId: r.id, riderId, driverId: d.id, driverUserId: d.userId, pickup: { address: 'Akoka' }, destination: { address: 'Yaba' },
    stops: [], riderOfferNgn: 3000, expiresAt: new Date(Date.now() + 60_000).toISOString(), timestamp: new Date().toISOString(),
  });
  const deps = {
    registry: { sendToUser: async () => {}, isUserConnected: async () => false, hasUser: () => false },
    redisClient: redis,
    publisher: { publishRideEvent: async () => {}, publishDriverEvent: async () => {}, publishWalletEvent: async () => {}, publishNotificationEvent: async () => {} },
  };
  await handleRideEvent(offer(cancelled), deps, new Map());
  await handleRideEvent(offer(open), deps, new Map());
  await prisma.ride.update({ where: { id: cancelled.id }, data: { status: 'CANCELLED', cancelledBy: 'rider' } });

  const sent = [];
  const registry = { sendToSocket: (_socket, type, payload) => sent.push({ type, payload }) };
  await tellEndedRequests(registry, {}, redis, d.userId, d.id);
  assert.deepEqual(sent, [{ type: 'ride:bid_timeout', payload: { rideId: cancelled.id, reason: 'rider_cancelled' } }]);

  sent.length = 0;
  await tellEndedRequests(registry, {}, redis, d.userId, d.id);
  assert.deepEqual(sent, [], 'told once; the open request is checked again next time');
});
