// A test driver held at a fixed spot (DRIVER_TEST_PINS): going online and the
// idle location pings put them there whatever their phone says, so requests
// near the spot reach them. Other drivers, and the setting unset, are as before.
// Through the real entry points: the driver socket (driver:online, driver:gps),
// the ride service's DRIVER_ONLINE (markOnline) and the nearby search.
// Against the local Postgres.
//
//   node scripts/run-with-env.cjs node --test --test-force-exit --test-concurrency=1 test/driver-test-pin.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const { driverClient, pinnedPosition } = require('../packages/db/dist/index.js');
const { handleDriverMessage } = require('../apps/api-gateway/dist/websocket/handlers/driver.handler.js');

const prisma = new PrismaClient();
const made = { users: [], drivers: [] };
const UNILAG = { lat: 6.5158, lng: 3.3896 };
const IKEJA = { lat: 6.6018, lng: 3.3515 };
const realConsole = { ...console };
test.beforeEach(() => { console.log = console.info = console.warn = console.error = () => {}; });
test.afterEach(() => { Object.assign(console, realConsole); delete process.env.DRIVER_TEST_PINS; });
test.after(async () => {
  await prisma.driverShift.deleteMany({ where: { driverId: { in: made.drivers } } }).catch(() => {});
  await prisma.driverLocationPoint?.deleteMany({ where: { driverId: { in: made.drivers } } }).catch(() => {});
  await prisma.driver.deleteMany({ where: { id: { in: made.drivers } } });
  await prisma.user.deleteMany({ where: { id: { in: made.users } } });
  await prisma.$disconnect();
});

async function driver() {
  const userId = randomUUID();
  await prisma.user.create({ data: { id: userId, privyDid: `test:pin:${userId}`, role: 'DRIVER', name: 'Pin Test' } });
  made.users.push(userId);
  const d = await prisma.driver.create({ data: { userId, kycStatus: 'APPROVED', status: 'OFFLINE', vehicleModel: 'Corolla', vehiclePlate: 'KJA9' } });
  made.drivers.push(d.id);
  return { id: d.id, userId };
}
const near = (a, b) => Math.abs(a.lat - b.lat) < 1e-6 && Math.abs(a.lng - b.lng) < 1e-6;

test('the setting is read as "<driverId>@lat,lng"; anything else, or unset, changes nothing', () => {
  const id = randomUUID();
  assert.deepEqual(pinnedPosition(id, IKEJA.lat, IKEJA.lng), IKEJA, 'unset');
  process.env.DRIVER_TEST_PINS = `${id}@${UNILAG.lat},${UNILAG.lng}`;
  assert.deepEqual(pinnedPosition(id, IKEJA.lat, IKEJA.lng), UNILAG);
  assert.deepEqual(pinnedPosition(id.toUpperCase(), IKEJA.lat, IKEJA.lng), UNILAG, 'case does not matter');
  assert.deepEqual(pinnedPosition(randomUUID(), IKEJA.lat, IKEJA.lng), IKEJA, 'another driver');
  process.env.DRIVER_TEST_PINS = `${id}@95,3.3;not-an-id@6.5,3.3`;
  assert.deepEqual(pinnedPosition(id, IKEJA.lat, IKEJA.lng), IKEJA, 'a bad pin is ignored');
});

test('a pinned driver goes online and pings at the pin, so a request at Unilag finds them while their phone is in Ikeja', async () => {
  const pinned = await driver();
  const other = await driver();
  process.env.DRIVER_TEST_PINS = `${pinned.id}@${UNILAG.lat},${UNILAG.lng}`;

  // Going online through the socket: the event the ride service gets carries the pin.
  const events = [];
  const publisher = { publishDriverEvent: async (e) => { events.push(e); }, publishGpsEvent: async () => {} };
  await handleDriverMessage('driver:online', { lat: IKEJA.lat, lng: IKEJA.lng }, { userId: pinned.userId, driverId: pinned.id, role: 'DRIVER' }, publisher);
  assert.ok(near(events[0], UNILAG), JSON.stringify(events[0]));
  // The ride service saves it (markOnline), for both drivers, each from their phone.
  await driverClient.markOnline(pinned.id, IKEJA.lat, IKEJA.lng);
  await driverClient.markOnline(other.id, IKEJA.lat, IKEJA.lng);
  assert.ok(near(await prisma.driver.findUnique({ where: { id: pinned.id } }), UNILAG));
  assert.ok(near(await prisma.driver.findUnique({ where: { id: other.id } }), IKEJA), 'another driver: their phone');

  // Idle pings from Ikeja keep them at Unilag.
  await handleDriverMessage('driver:gps', { lat: IKEJA.lat, lng: IKEJA.lng }, { userId: pinned.userId, driverId: pinned.id, role: 'DRIVER' }, publisher);
  await driverClient.updateLocation(pinned.id, IKEJA.lat + 0.001, IKEJA.lng);

  // A request at Unilag (2 km): the pinned driver, not the one really in Ikeja (~10 km away).
  const found = (await driverClient.findNearby(UNILAG.lat, UNILAG.lng, 2, 50)).map((d) => d.id);
  assert.ok(found.includes(pinned.id), 'the pinned driver is found at Unilag');
  assert.ok(!found.includes(other.id));

  // Unset: their phone again.
  delete process.env.DRIVER_TEST_PINS;
  await driverClient.markOnline(pinned.id, IKEJA.lat, IKEJA.lng);
  assert.ok(near(await prisma.driver.findUnique({ where: { id: pinned.id } }), IKEJA));
});
