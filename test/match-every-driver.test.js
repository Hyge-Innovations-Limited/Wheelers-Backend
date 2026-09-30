// A ride request goes to EVERY approved, online driver inside the match
// radius, not just the nearest five. Against the local Postgres (and Redis
// when it is up).
//
//   node scripts/run-with-env.cjs node --test --test-force-exit test/match-every-driver.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');

const { matchDriver } = require('../apps/ride-service/dist/handlers/match-driver.handler.js');
const { validateRideEnv } = require('../packages/config/dist/index.js');
const { driverClient } = require('../packages/db/dist/index.js');

const prisma = new PrismaClient();
const made = [];
// A quiet corner of the map, far from any other test's drivers.
const PICKUP = { lat: 6.4, lng: 3.9 };
const kmNorth = (km) => ({ lat: PICKUP.lat + km / 111, lng: PICKUP.lng });

async function driver(at, kycStatus = 'APPROVED') {
  const userId = randomUUID();
  await prisma.user.create({ data: { id: userId, privyDid: `test:match-all:${userId}`, role: 'DRIVER', name: 'Match Test' } });
  const row = await prisma.driver.create({ data: { userId, kycStatus, status: 'OFFLINE' } });
  made.push(userId);
  await driverClient.markOnline(row.id, at.lat, at.lng);
  return row.id;
}

test('twelve drivers in range: all twelve get the request; one unapproved and one too far do not', async () => {
  const env = validateRideEnv();
  assert.ok(Number(env.MAX_MATCH_ATTEMPTS) >= 100, `the default reaches everyone in range (got ${env.MAX_MATCH_ATTEMPTS})`);

  const inRange = [];
  for (let i = 0; i < 12; i += 1) inRange.push(await driver(kmNorth(0.2 + i * 0.3)));
  const unapproved = await driver(kmNorth(0.5), 'SUBMITTED');
  const tooFar = await driver(kmNorth(9));

  const result = await matchDriver({
    rideEnv: { ...env, MATCH_RADIUS_KM: '5' },
    onlineDrivers: new Map(),
    rideRequested: { rideId: randomUUID(), pickup: { ...PICKUP, address: 'Test pickup' } },
  });
  assert.equal(result.ok, true);
  const got = result.drivers.map((d) => d.driverId);
  for (const id of inRange) assert.ok(got.includes(id), 'every driver in range');
  assert.ok(!got.includes(unapproved), 'never an unapproved driver');
  assert.ok(!got.includes(tooFar), 'never one outside the radius');
  const mine = result.drivers.filter((d) => inRange.includes(d.driverId));
  assert.deepEqual(mine.map((d) => d.distanceKm), [...mine.map((d) => d.distanceKm)].sort((a, b) => a - b), 'nearest first');
});

test.after(async () => {
  const drivers = await prisma.driver.findMany({ where: { userId: { in: made } }, select: { id: true } });
  const ids = drivers.map((d) => d.id);
  await prisma.driverShift.deleteMany({ where: { driverId: { in: ids } } }).catch(() => {});
  await prisma.driverLocation?.deleteMany?.({ where: { driverId: { in: ids } } }).catch(() => {});
  await prisma.driver.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: made } } }).catch(() => {});
  await prisma.$disconnect();
  process.exit(0);
});
