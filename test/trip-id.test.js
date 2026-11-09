// The short trip ID (WH-01234): numbered in booking order, shown wherever a
// person looks at a trip, and found by admin search however it is typed.
//
//   node scripts/run-with-env.cjs node --test --test-force-exit test/trip-id.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const { formatTripId, parseTripId } = require('../packages/config/dist/index.js');
const { adminMetricsClient, rideClient } = require('../packages/db/dist/index.js');

const prisma = new PrismaClient();
const made = { users: [], rides: [] };

async function ride(riderId) {
  const r = await prisma.ride.create({
    data: { riderId, status: 'COMPLETED', pickupLat: 6.5, pickupLng: 3.37, pickupAddress: 'Trip ID test pickup', destLat: 6.45, destLng: 3.43, destAddress: 'Trip ID test destination' },
  });
  made.rides.push(r.id);
  return r;
}

test.after(async () => {
  await prisma.ride.deleteMany({ where: { id: { in: made.rides } } });
  await prisma.user.deleteMany({ where: { id: { in: made.users } } });
  await prisma.$disconnect();
});

test('a trip ID is WH- and at least five digits, and is read back however it is typed', () => {
  assert.equal(formatTripId(1), 'WH-00001');
  assert.equal(formatTripId(1234), 'WH-01234');
  assert.equal(formatTripId(123456), 'WH-123456');
  assert.equal(formatTripId(null), null);
  for (const typed of ['WH-01234', 'wh-1234', 'WH1234', 'wh 01234', '#1234', '01234']) assert.equal(parseTripId(typed), 1234, typed);
  for (const typed of ['Yaba', 'WH-', 'WH-12a', '', null]) assert.equal(parseTripId(typed), null, String(typed));
});

test('every new ride takes the next number, and none is ever reused', async () => {
  const user = await prisma.user.create({ data: { privyDid: `test:trip-id:${randomUUID()}`, name: 'Trip ID Rider' } });
  made.users.push(user.id);
  const a = await ride(user.id);
  const b = await ride(user.id);
  assert.ok(Number.isInteger(a.tripNumber) && a.tripNumber > 0);
  assert.equal(b.tripNumber, a.tripNumber + 1);
  assert.equal(await rideClient.tripNumberOf(b.id), b.tripNumber);
  assert.equal(await rideClient.tripNumberOf(randomUUID()), null);
  await assert.rejects(prisma.ride.update({ where: { id: b.id }, data: { tripNumber: a.tripNumber } }), 'two rides cannot share one');
});

test('the admin finds a trip by its ID, however it is typed', async () => {
  const user = await prisma.user.create({ data: { privyDid: `test:trip-id:${randomUUID()}`, name: 'Trip ID Rider' } });
  made.users.push(user.id);
  const r = await ride(user.id);
  const tripId = formatTripId(r.tripNumber);
  for (const q of [tripId, tripId.toLowerCase(), `#${r.tripNumber}`]) {
    const found = await adminMetricsClient.listRides({ status: 'all', q });
    assert.ok(found.items.some((item) => item.id === r.id && item.tripId === tripId), q);
  }
});
