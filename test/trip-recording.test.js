/**
 * Trip voice recording: who may upload, what is refused, who may listen, and
 * the 30-day sweep. Real handlers and Postgres; a stand-in for R2.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');

const { handleTripRecordingRoute, recordsTrips, sweepTripRecordings } = require('../apps/api-gateway/dist/http/trip-recording.route.js');
const { handleTripRecordingMessage } = require('../apps/api-gateway/dist/websocket/trip-recording.js');
const local = require('../apps/api-gateway/dist/auth/local.js');

const prisma = new PrismaClient();
const SECRET = 'test-secret-that-is-at-least-32-characters-long';
const ADMIN_KEY = 'test-admin-key';
const seeded = { users: [], drivers: [], rides: [], admins: [] };

function fakeStorage() {
  const objects = new Map();
  return {
    objects,
    removed: [],
    keyFor: (rideId, i) => `trips/${rideId}/segment-${String(i).padStart(3, '0')}.m4a`,
    uploadUrl: async (key) => `https://r2.example/put/${key}`,
    listenUrl: async (key) => `https://r2.example/get/${key}`,
    sizeOf: async (key) => (objects.has(key) ? objects.get(key) : null),
    remove: async function (keys) { for (const k of keys) { objects.delete(k); this.removed.push(k); } },
  };
}

function deps(storage, extra = {}) {
  return { jwtSecret: SECRET, adminApiKey: ADMIN_KEY, enabled: true, driverIds: [], storage, ...extra };
}

async function call(d, method, path, { token, body, headers = {} } = {}) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  const req = require('node:stream').Readable.from(payload ? [Buffer.from(payload)] : []);
  req.method = method;
  req.url = path;
  req.headers = { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json', ...headers };
  req.socket = { remoteAddress: '127.0.0.1' };
  const res = { statusCode: 0, body: null, setHeader() {}, writeHead(code) { this.statusCode = code; }, end(t) { this.body = t ? JSON.parse(t) : null; } };
  const handled = await handleTripRecordingRoute(req, res, d, new URL(`http://x${path}`));
  return { handled, status: res.statusCode, body: res.body };
}

async function seedUser(role) {
  const user = await prisma.user.create({ data: { privyDid: `did:test:${randomUUID()}`, role, name: `${role} rec` } });
  seeded.users.push(user.id);
  return user;
}

async function seedDriver() {
  const user = await seedUser('DRIVER');
  const driver = await prisma.driver.create({ data: { userId: user.id, status: 'ONLINE', vehicleModel: 'Camry', vehiclePlate: 'REC1234' } });
  seeded.drivers.push(driver.id);
  return { user, driver, token: local.createLocalAccessToken(user.id, SECRET) };
}

async function seedRide(riderId, driverId, extra = {}) {
  const ride = await prisma.ride.create({
    data: {
      riderId, driverId, status: 'IN_PROGRESS',
      pickupLat: 6.6018, pickupLng: 3.3515, pickupAddress: 'Opebi, Ikeja',
      destLat: 6.4969, destLng: 3.3556, destAddress: 'Surulere',
      fareEstimateNgn: 5200, agreedFareNgn: 5200,
      ...extra,
    },
  });
  seeded.rides.push(ride.id);
  return ride;
}

async function seedAdmin(role) {
  const admin = await prisma.adminUser.create({ data: { username: `rec-${role}-${randomUUID()}`, passwordHash: 'x', name: `Rec ${role}`, role } });
  seeded.admins.push(admin.id);
  return local.createLocalAccessToken(admin.id, SECRET);
}

test.after(async () => {
  await prisma.tripRecording.deleteMany({ where: { rideId: { in: seeded.rides } } });
  await prisma.adminActivity.deleteMany({ where: { kind: 'trip_recording_listen', detail: { path: ['rideId'], string_contains: '' } } }).catch(() => undefined);
  await prisma.ride.deleteMany({ where: { id: { in: seeded.rides } } });
  await prisma.driver.deleteMany({ where: { id: { in: seeded.drivers } } });
  await prisma.adminUser.deleteMany({ where: { id: { in: seeded.admins } } });
  await prisma.user.deleteMany({ where: { id: { in: seeded.users } } });
  await prisma.$disconnect();
});

test('flag off or not on the pilot list: the phone does not record, and uploads are refused', async () => {
  const { driver, token } = await seedDriver();
  const storage = fakeStorage();
  assert.equal(recordsTrips({ enabled: false, driverIds: [], storage }, driver.id), false);
  assert.equal(recordsTrips({ enabled: true, driverIds: ['someone-else'], storage }, driver.id), false);
  assert.equal(recordsTrips({ enabled: true, driverIds: [], storage: null }, driver.id), false);
  assert.equal(recordsTrips({ enabled: true, driverIds: [driver.id], storage }, driver.id), true);

  const off = await call(deps(storage, { enabled: false }), 'GET', '/drivers/me/trip-recording', { token });
  assert.deepEqual([off.status, off.body.recordTrips], [200, false]);
  const rider = await seedUser('RIDER');
  const ride = await seedRide(rider.id, driver.id);
  const refused = await call(deps(storage, { enabled: false }), 'POST', '/drivers/me/trip-recordings/upload-url', { token, body: { rideId: ride.id, segmentIndex: 0, bytes: 1000 } });
  assert.equal(refused.status, 404);
});

test('the ride\'s own driver gets an upload link; another driver gets 403', async () => {
  const mine = await seedDriver();
  const other = await seedDriver();
  const rider = await seedUser('RIDER');
  const ride = await seedRide(rider.id, mine.driver.id);
  const storage = fakeStorage();

  const ok = await call(deps(storage), 'POST', '/drivers/me/trip-recordings/upload-url', { token: mine.token, body: { rideId: ride.id, segmentIndex: 0, bytes: 900_000 } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.key, `trips/${ride.id}/segment-000.m4a`);
  assert.match(ok.body.url, /^https:\/\//);

  const stranger = await call(deps(storage), 'POST', '/drivers/me/trip-recordings/upload-url', { token: other.token, body: { rideId: ride.id, segmentIndex: 0, bytes: 900_000 } });
  assert.equal(stranger.status, 403);

  const riderToken = local.createLocalAccessToken(rider.id, SECRET);
  const notDriver = await call(deps(storage), 'POST', '/drivers/me/trip-recordings/upload-url', { token: riderToken, body: { rideId: ride.id, segmentIndex: 0, bytes: 900_000 } });
  assert.equal(notDriver.status, 403);
  assert.equal((await call(deps(storage), 'POST', '/drivers/me/trip-recordings/upload-url', { body: { rideId: ride.id } })).status, 401);
});

test('oversize, a bad segment, a ride not running and a ride ended over 30 days ago are refused', async () => {
  const { driver, token } = await seedDriver();
  const rider = await seedUser('RIDER');
  const storage = fakeStorage();
  const live = await seedRide(rider.id, driver.id);
  const post = (body) => call(deps(storage), 'POST', '/drivers/me/trip-recordings/upload-url', { token, body });

  assert.equal((await post({ rideId: live.id, segmentIndex: 0, bytes: 21 * 1024 * 1024 })).status, 413);
  assert.equal((await post({ rideId: live.id, segmentIndex: 40, bytes: 1000 })).status, 400);
  assert.equal((await post({ rideId: live.id, segmentIndex: -1, bytes: 1000 })).status, 400);

  const assigned = await seedRide(rider.id, driver.id, { status: 'DRIVER_ASSIGNED' });
  assert.equal((await post({ rideId: assigned.id, segmentIndex: 0, bytes: 1000 })).status, 409);

  const old = await seedRide(rider.id, driver.id, { status: 'COMPLETED', completedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000) });
  assert.equal((await post({ rideId: old.id, segmentIndex: 0, bytes: 1000 })).status, 409);

  const recent = await seedRide(rider.id, driver.id, { status: 'COMPLETED', completedAt: new Date(Date.now() - 2 * 60 * 60 * 1000) });
  assert.equal((await post({ rideId: recent.id, segmentIndex: 0, bytes: 1000 })).status, 200, 'a finished trip may still upload its last segments');
});

test('complete: needs the object there, records it once, and a repeat is the same row', async () => {
  const { driver, token } = await seedDriver();
  const rider = await seedUser('RIDER');
  const ride = await seedRide(rider.id, driver.id);
  const storage = fakeStorage();
  const complete = () => call(deps(storage), 'POST', '/drivers/me/trip-recordings/complete', { token, body: { rideId: ride.id, segmentIndex: 2, durationSec: 300 } });

  assert.equal((await complete()).status, 409, 'nothing uploaded yet');
  storage.objects.set(`trips/${ride.id}/segment-002.m4a`, 1_200_000);
  assert.equal((await complete()).status, 200);
  assert.equal((await complete()).status, 200);
  const rows = await prisma.tripRecording.findMany({ where: { rideId: ride.id } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].bytes, 1_200_000);
  assert.equal(rows[0].durationSec, 300);

  storage.objects.set(`trips/${ride.id}/segment-003.m4a`, 25 * 1024 * 1024);
  const big = await call(deps(storage), 'POST', '/drivers/me/trip-recordings/complete', { token, body: { rideId: ride.id, segmentIndex: 3 } });
  assert.equal(big.status, 413);
  assert.ok(storage.removed.includes(`trips/${ride.id}/segment-003.m4a`), 'an oversize upload is deleted');
});

test('listening: support and owners only, signed links, and every listen logged', async () => {
  const { driver } = await seedDriver();
  const rider = await seedUser('RIDER');
  const ride = await seedRide(rider.id, driver.id);
  const storage = fakeStorage();
  await prisma.tripRecording.create({ data: { rideId: ride.id, driverId: driver.id, segmentIndex: 0, objectKey: `trips/${ride.id}/segment-000.m4a`, bytes: 1000 } });
  const path = `/admin/rides/${ride.id}/recordings`;

  assert.equal((await call(deps(storage), 'GET', path)).status, 401);
  assert.equal((await call(deps(storage), 'GET', path, { token: await seedAdmin('STAFF') })).status, 403);

  const support = await call(deps(storage), 'GET', path, { token: await seedAdmin('SUPPORT') });
  assert.equal(support.status, 200);
  assert.equal(support.body.recordings.length, 1);
  assert.equal(support.body.recordings[0].url, `https://r2.example/get/trips/${ride.id}/segment-000.m4a`);
  const owner = await call(deps(storage), 'GET', path, { headers: { 'x-admin-key': ADMIN_KEY } });
  assert.equal(owner.status, 200);

  const logged = await prisma.adminActivity.findMany({ where: { kind: 'trip_recording_listen', page: path } });
  assert.equal(logged.length, 2);
  assert.ok(logged.every((row) => row.flagged));
});

test('the sweep deletes only what is older than 30 days, object and row', async () => {
  const { driver } = await seedDriver();
  const rider = await seedUser('RIDER');
  const ride = await seedRide(rider.id, driver.id, { status: 'COMPLETED', completedAt: new Date() });
  const storage = fakeStorage();
  const old = await prisma.tripRecording.create({ data: { rideId: ride.id, driverId: driver.id, segmentIndex: 0, objectKey: 'trips/old.m4a', bytes: 1, createdAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000) } });
  const fresh = await prisma.tripRecording.create({ data: { rideId: ride.id, driverId: driver.id, segmentIndex: 1, objectKey: 'trips/fresh.m4a', bytes: 1, createdAt: new Date(Date.now() - 29 * 24 * 60 * 60 * 1000) } });

  const removed = await sweepTripRecordings(storage);
  assert.ok(removed >= 1);
  assert.ok(storage.removed.includes('trips/old.m4a'));
  assert.ok(!storage.removed.includes('trips/fresh.m4a'));
  assert.ok((await prisma.tripRecording.findUnique({ where: { id: old.id } })).deletedAt);
  assert.equal((await prisma.tripRecording.findUnique({ where: { id: fresh.id } })).deletedAt, null);
});

test('ride:recording:started: only the ride\'s driver on a running trip; the rider is told once', async () => {
  const { driver, user } = await seedDriver();
  const other = await seedDriver();
  const rider = await seedUser('RIDER');
  const ride = await seedRide(rider.id, driver.id);
  const sent = [];
  const wsDeps = { recordsFor: () => true, registry: { sendToUser: async (userId, type, payload) => { sent.push({ userId, type, payload }); } } };
  const auth = (u, d) => ({ userId: u.id, driverId: d.id });

  assert.equal(await handleTripRecordingMessage('ride:other', { rideId: ride.id }, auth(user, driver), wsDeps), null);
  const stranger = await handleTripRecordingMessage('ride:recording:started', { rideId: ride.id }, auth(other.user, other.driver), wsDeps);
  assert.equal(stranger.payload.ok, false);

  const ok = await handleTripRecordingMessage('ride:recording:started', { rideId: ride.id }, auth(user, driver), wsDeps);
  assert.equal(ok.payload.ok, true);
  await handleTripRecordingMessage('ride:recording:started', { rideId: ride.id }, auth(user, driver), wsDeps);
  assert.deepEqual(sent, [{ userId: rider.id, type: 'ride:recording', payload: { rideId: ride.id } }], 'told once');
  assert.ok((await prisma.ride.findUnique({ where: { id: ride.id } })).recordingId);

  const off = await handleTripRecordingMessage('ride:recording:started', { rideId: ride.id }, auth(user, driver), { ...wsDeps, recordsFor: () => false });
  assert.equal(off.payload.ok, false);
});
