// An old driver app still has Skip and sends driver:reject with the payload it always sent
// (rideId, a riderId that may be empty, no reason). The new server must answer it the same way.
//   node scripts/run-with-env.cjs node --test --test-force-exit tests/regression/old-driver-skip.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const { handleRideMessage } = require('../../apps/api-gateway/dist/websocket/handlers/ride.handler.js');

const prisma = new PrismaClient();
const made = { users: [], rides: [], drivers: [] };
test.after(async () => {
  await prisma.ride.deleteMany({ where: { id: { in: made.rides } } });
  await prisma.driver.deleteMany({ where: { id: { in: made.drivers } } });
  await prisma.user.deleteMany({ where: { id: { in: made.users } } });
  await prisma.$disconnect();
});

test('old driver app Skip: driver:reject with empty riderId and no reason is accepted and publishes RIDE_DRIVER_REJECTED for the ride\'s rider', async () => {
  const riderId = randomUUID(); const driverUserId = randomUUID(); const driverId = randomUUID(); const rideId = randomUUID();
  await prisma.user.create({ data: { id: riderId, privyDid: `test:skip:${riderId}`, role: 'RIDER', name: 'Skip rider' } });
  await prisma.user.create({ data: { id: driverUserId, privyDid: `test:skip:${driverUserId}`, role: 'DRIVER', name: 'Skip driver' } });
  made.users.push(riderId, driverUserId);
  await prisma.driver.create({ data: { id: driverId, userId: driverUserId, kycStatus: 'APPROVED', status: 'ONLINE', lastSeenAt: new Date(), vehicleModel: 'Camry', vehiclePlate: 'KJA482XY' } });
  made.drivers.push(driverId);
  await prisma.ride.create({ data: { id: rideId, riderId, status: 'MATCHING', pickupLat: 6.5244, pickupLng: 3.387, pickupAddress: 'Akoka', destLat: 6.5095, destLng: 3.3711, destAddress: 'Yaba', riderOfferNgn: 3000, fareEstimateNgn: 3000 } });
  made.rides.push(rideId);
  const published = [];
  const publisher = { publishRideEvent: async (e) => { published.push(e); } };
  const out = await handleRideMessage('driver:reject', { rideId, riderId: '' }, { userId: driverUserId, driverId, role: 'DRIVER' }, publisher, {}, null);
  assert.equal(out.type, 'driver:reject:accepted');
  assert.equal(out.payload.rideId, rideId);
  const ev = published.find((e) => e.eventType === 'RIDE_DRIVER_REJECTED');
  assert.equal(ev.riderId, riderId);
  assert.equal(ev.driverId, driverId);
});
