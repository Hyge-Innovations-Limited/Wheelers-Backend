// When a driver's shift begins and ends: the record behind "hours online".
// Against a real Postgres, through the same driverClient the services use.
//
//   node scripts/run-with-env.cjs node --test --test-force-exit test/driver-shifts.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const { driverClient, driverShiftClient, driverPresence } = require('../packages/db/dist/index.js');

const prisma = new PrismaClient();
const YABA = { lat: 6.5095, lng: 3.3711 };
const made = [];
const near = (a, b, ms = 2000) => Math.abs(a.getTime() - b.getTime()) < ms;

async function makeDriver() {
  const userId = randomUUID();
  await prisma.user.create({ data: { id: userId, privyDid: `test:shift:${userId}`, role: 'DRIVER', name: 'Shift Test' } });
  const driver = await prisma.driver.create({ data: { userId, kycStatus: 'APPROVED' } });
  made.push(userId);
  return driver.id;
}
const shifts = (driverId) => prisma.driverShift.findMany({ where: { driverId }, orderBy: { startedAt: 'asc' } });

test.before(() => {
  console.warn = () => {};
  driverPresence.configure(null);
});

test.after(async () => {
  await prisma.driverShift.deleteMany({ where: { driver: { userId: { in: made } } } });
  await prisma.driverLocationPoint.deleteMany({ where: { driver: { userId: { in: made } } } });
  await prisma.driver.deleteMany({ where: { userId: { in: made } } });
  await prisma.user.deleteMany({ where: { id: { in: made } } });
  await prisma.$disconnect();
});

test('going online opens a shift, going offline closes it', async () => {
  const id = await makeDriver();
  await driverClient.markOnline(id, YABA.lat, YABA.lng);
  let rows = await shifts(id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].endedAt, null);
  assert.ok(near(rows[0].startedAt, new Date()));

  await driverClient.markOffline(id, 'app_closed');
  rows = await shifts(id);
  assert.equal(rows.length, 1);
  assert.ok(near(rows[0].endedAt, new Date()));
  assert.equal(rows[0].endReason, 'app_closed');
  assert.ok(rows[0].endedAt >= rows[0].startedAt);

  await driverClient.markOffline(id); // already off: nothing to close
  assert.equal((await shifts(id)).length, 1);
});

test('the app says "online" on every reconnect: the shift they are in carries on', async () => {
  const id = await makeDriver();
  await driverClient.markOnline(id, YABA.lat, YABA.lng);
  const [first] = await shifts(id);
  for (let i = 0; i < 3; i += 1) await driverClient.markOnline(id, YABA.lat, YABA.lng);
  const rows = await shifts(id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, first.id);
  assert.equal(rows[0].startedAt.getTime(), first.startedAt.getTime());
});

test('ten processes hearing the same driver at once open one shift', async () => {
  const id = await makeDriver();
  await Promise.all(Array.from({ length: 10 }, () => driverClient.markOnline(id, YABA.lat, YABA.lng)));
  const rows = await shifts(id);
  assert.equal(rows.filter((r) => r.endedAt === null).length, 1);
});

test('a trip is part of the shift: starting and finishing one neither ends it nor starts another', async () => {
  const id = await makeDriver();
  await driverClient.markOnline(id, YABA.lat, YABA.lng);
  await driverClient.updateStatus(id, 'ON_RIDE');
  await driverClient.updateStatus(id, 'ONLINE');
  const rows = await shifts(id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].endedAt, null);
});

test('a driver taken offline for silence was last there when last heard from, not now', async () => {
  const id = await makeDriver();
  await driverClient.markOnline(id, YABA.lat, YABA.lng);
  const started = new Date(Date.now() - 60 * 60_000);
  const lastHeard = new Date(Date.now() - 4 * 60_000);
  await prisma.driverShift.updateMany({ where: { driverId: id }, data: { startedAt: started } });
  await prisma.driver.update({ where: { id }, data: { lastSeenAt: lastHeard } });

  await driverClient.markOffline(id, 'inactivity');
  const [row] = await shifts(id);
  assert.equal(row.endReason, 'inactivity');
  assert.ok(near(row.endedAt, lastHeard), 'the minutes of silence are not time on shift');
});

test('a shift that never heard its end is closed when the driver comes back, and a new one begins', async () => {
  const id = await makeDriver();
  await driverClient.markOnline(id, YABA.lat, YABA.lng);
  // The services went down with the driver on shift. They were last heard from two hours ago.
  const started = new Date(Date.now() - 5 * 60 * 60_000);
  const lastHeard = new Date(Date.now() - 2 * 60 * 60_000);
  await prisma.driverShift.updateMany({ where: { driverId: id }, data: { startedAt: started } });
  await prisma.driver.update({ where: { id }, data: { lastSeenAt: lastHeard } });

  await driverClient.markOnline(id, YABA.lat, YABA.lng);
  const rows = await shifts(id);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].endReason, 'stale');
  assert.ok(near(rows[0].endedAt, lastHeard), 'three hours, not five and counting');
  assert.equal(rows[1].endedAt, null);
  assert.ok(near(rows[1].startedAt, new Date()));
});

test('a driver who went offline during a trip is on shift again when the trip returns them to the pool', async () => {
  const id = await makeDriver();
  await driverClient.markOnline(id, YABA.lat, YABA.lng);
  await driverClient.updateStatus(id, 'ON_RIDE');
  await driverClient.markOffline(id, 'app_closed');
  await driverClient.updateStatus(id, 'ONLINE');
  const rows = await shifts(id);
  assert.equal(rows.length, 2);
  assert.notEqual(rows[0].endedAt, null);
  assert.equal(rows[1].endedAt, null);
});

test('a shift cannot end before it began', async () => {
  const id = await makeDriver();
  await driverClient.markOnline(id, YABA.lat, YABA.lng);
  await driverShiftClient.close(id, 'inactivity', new Date(Date.now() - 24 * 60 * 60_000));
  const [row] = await shifts(id);
  assert.equal(row.endedAt.getTime(), row.startedAt.getTime());
});
