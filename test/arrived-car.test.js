// "Driver is here. Look for the Camry, plate LAG23469." — the car from the
// driver's profile, never the "UNKNOWN" placeholder an old bid may carry.
// Against the local Postgres.
//
//   node scripts/run-with-env.cjs node --test --test-force-exit test/arrived-car.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const { handleRideEvent } = require('../apps/api-gateway/dist/kafka/consumer.js');
const { storeAcceptedBid } = require('../apps/api-gateway/dist/whatsapp-flows/bid-state.js');

const prisma = new PrismaClient();
const made = { users: [], rides: [] };
test.beforeEach(() => { console.log = console.info = console.warn = console.error = () => {}; });

function memoryRedis() {
  const store = new Map();
  return { store, async get(k) { return store.has(k) ? store.get(k) : null; }, async set(k, v) { store.set(k, v); }, async del(k) { store.delete(k); }, async setIfNotExists(k, v) { if (store.has(k)) return false; store.set(k, v); return true; }, async send() { return null; } };
}

test('the arrived message names the car from the profile, not "UNKNOWN"', async () => {
  const phone = `+234801${Math.floor(1000000 + Math.random() * 8999999)}`;
  const riderId = randomUUID(); const driverUserId = randomUUID();
  await prisma.user.createMany({ data: [
    { id: riderId, privyDid: `test:car:${riderId}`, role: 'RIDER', name: 'Car Rider', phone },
    { id: driverUserId, privyDid: `test:car:${driverUserId}`, role: 'DRIVER', name: 'Timilehin Olowu' },
  ] });
  made.users.push(riderId, driverUserId);
  const driver = await prisma.driver.create({ data: { userId: driverUserId, kycStatus: 'APPROVED', status: 'ON_RIDE', vehicleModel: 'Camry', vehiclePlate: 'LAG23469', lat: 6.52, lng: 3.38, lastSeenAt: new Date() } });
  const ride = await prisma.ride.create({ data: { riderId, driverId: driver.id, channel: 'WHATSAPP', status: 'ARRIVED', pickupLat: 6.52, pickupLng: 3.38, pickupAddress: 'Ilemere Rd', destLat: 6.6, destLng: 3.5, destAddress: 'Ikorodu Garage', riderOfferNgn: 4500, fareEstimateNgn: 4500, distanceKm: 3, paymentMethod: 'WALLET' } });
  made.rides.push(ride.id);

  const redis = memoryRedis();
  await storeAcceptedBid(redis, ride.id, { driverId: driver.id, driverName: 'Timilehinolowu', vehicleModel: 'UNKNOWN', vehiclePlate: 'UNKNOWN', counterOfferNgn: 4500 });

  const sent = [];
  const realFetch = global.fetch;
  global.fetch = async (_url, init) => { sent.push(JSON.parse(init.body)); return { ok: true, status: 200, text: async () => '', json: async () => ({ messages: [{ id: 'wamid.X' }] }) }; };
  try {
    await handleRideEvent({ eventType: 'RIDE_ARRIVED', rideId: ride.id, riderId, driverId: driver.id, timestamp: new Date().toISOString() },
      { registry: { sendToUser: async () => {} }, redisClient: redis, publisher: {}, whatsappNotifier: { metaAccessToken: 't', metaPhoneNumberId: '1' } }, new Map());
  } finally { global.fetch = realFetch; }

  const text = JSON.stringify(sent);
  assert.match(text, /Look for the \*Camry\*, plate \*LAG23469\*/);
  assert.doesNotMatch(text, /UNKNOWN/);
});

test.after(async () => {
  await prisma.ride.deleteMany({ where: { id: { in: made.rides } } }).catch(() => {});
  await prisma.driver.deleteMany({ where: { userId: { in: made.users } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: made.users } } }).catch(() => {});
  await prisma.$disconnect();
});
