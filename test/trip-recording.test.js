/**
 * Trip voice recording: who may upload, what is refused, who may listen, and
 * the 30-day sweep. Real handlers and Postgres; a stand-in for R2.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');

const { handleTripRecordingRoute, recordsTrips, sweepTripRecordings } = require('../apps/api-gateway/dist/http/trip-recording.route.js');
const local = require('../apps/api-gateway/dist/auth/local.js');

const prisma = new PrismaClient();
const SECRET = 'test-secret-that-is-at-least-32-characters-long';
const ADMIN_KEY = 'test-admin-key';
const seeded = { users: [], drivers: [], rides: [], admins: [] };

const M4A = Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20]);

function fakeStorage() {
  // key -> { size, etag, bytes, modified }
  const objects = new Map();
  return {
    objects,
    removed: [],
    failDelete: new Set(),
    put(key, size, { etag = `"e-${key}"`, bytes = M4A, modified = new Date() } = {}) { objects.set(key, { size, etag, bytes, modified }); },
    keyFor: (rideId, i) => `trips/${rideId}/segment-${String(i).padStart(3, '0')}.m4a`,
    uploadUrl: async (key) => `https://r2.example/put/${key}`,
    listenUrl: async (key) => `https://r2.example/get/${key}`,
    stat: async (key) => (objects.has(key) ? { size: objects.get(key).size, etag: objects.get(key).etag } : null),
    head: async (key) => objects.get(key)?.bytes ?? Buffer.alloc(0),
    remove: async function (keys) {
      const failed = [];
      for (const k of keys) {
        if (this.failDelete.has(k)) { failed.push(k); continue; }
        objects.delete(k);
        this.removed.push(k);
      }
      return failed;
    },
    listOlderThan: async (cutoff) => [...objects.entries()].filter(([, o]) => o.modified < cutoff).map(([k]) => k),
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
      // The phone started recording 10 minutes ago.
      recordingStartedAt: new Date(Date.now() - 10 * 60 * 1000),
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

const HOUR = 60 * 60 * 1000;

test('refused: oversize, a bad segment, a trip never announced, a ride not running, too old, longer than the trip', async () => {
  const { driver, token } = await seedDriver();
  const rider = await seedUser('RIDER');
  const storage = fakeStorage();
  const live = await seedRide(rider.id, driver.id);
  const post = (body) => call(deps(storage), 'POST', '/drivers/me/trip-recordings/upload-url', { token, body });

  assert.equal((await post({ rideId: live.id, segmentIndex: 0, bytes: 21 * 1024 * 1024 })).status, 413);
  assert.equal((await post({ rideId: live.id, segmentIndex: 40, bytes: 1000 })).status, 400);
  assert.equal((await post({ rideId: live.id, segmentIndex: -1, bytes: 1000 })).status, 400);
  assert.equal((await post({ rideId: 'no-such-ride', segmentIndex: 0, bytes: 1000 })).status, 403);

  const never = await seedRide(rider.id, driver.id, { recordingStartedAt: null });
  const unannounced = await post({ rideId: never.id, segmentIndex: 0, bytes: 1000 });
  assert.deepEqual([unannounced.status, unannounced.body.code], [409, 'not_recorded'], 'never marked as recorded while it ran: nothing is taken');
  const neverDone = await seedRide(rider.id, driver.id, { status: 'COMPLETED', completedAt: new Date(), recordingStartedAt: null });
  assert.equal((await post({ rideId: neverDone.id, segmentIndex: 0, bytes: 1000 })).body.code, 'not_recorded');

  const assigned = await seedRide(rider.id, driver.id, { status: 'DRIVER_ASSIGNED' });
  assert.equal((await post({ rideId: assigned.id, segmentIndex: 0, bytes: 1000 })).status, 409);

  const old = await seedRide(rider.id, driver.id, { status: 'COMPLETED', recordingStartedAt: new Date(Date.now() - 50 * HOUR), completedAt: new Date(Date.now() - 49 * HOUR) });
  assert.equal((await post({ rideId: old.id, segmentIndex: 0, bytes: 1000 })).body.code, 'too_old');
  const noEnd = await seedRide(rider.id, driver.id, { status: 'COMPLETED', completedAt: null });
  assert.equal((await post({ rideId: noEnd.id, segmentIndex: 0, bytes: 1000 })).body.code, 'too_old', 'a finished ride with no end time is treated as too old');

  // 10 minutes in: pieces 0-1, plus 3 for restarts and the last short piece.
  assert.equal((await post({ rideId: live.id, segmentIndex: 4, bytes: 1000 })).status, 200);
  const tooLong = await post({ rideId: live.id, segmentIndex: 5, bytes: 1000 });
  assert.deepEqual([tooLong.status, tooLong.body.code], [409, 'too_long']);
  const short = await seedRide(rider.id, driver.id, { status: 'COMPLETED', recordingStartedAt: new Date(Date.now() - 3 * HOUR), completedAt: new Date(Date.now() - 3 * HOUR + 10 * 60 * 1000) });
  assert.equal((await post({ rideId: short.id, segmentIndex: 39, bytes: 1000 })).body.code, 'too_long', 'a 10-minute trip cannot gain 40 pieces later');

  const recent = await seedRide(rider.id, driver.id, { status: 'COMPLETED', recordingStartedAt: new Date(Date.now() - 3 * HOUR), completedAt: new Date(Date.now() - 2 * HOUR) });
  assert.equal((await post({ rideId: recent.id, segmentIndex: 0, bytes: 1000 })).status, 200, 'a finished trip may still upload its last segments');
  const cancelled = await seedRide(rider.id, driver.id, { status: 'CANCELLED', recordingStartedAt: new Date(Date.now() - 3 * HOUR), cancelledAt: new Date(Date.now() - 2 * HOUR) });
  assert.equal((await post({ rideId: cancelled.id, segmentIndex: 0, bytes: 1000 })).status, 200, 'a trip cancelled mid-way keeps its recording');
});

test('complete: needs a real m4a there, records it once with its ETag, and a recorded piece never gets a new link', async () => {
  const { driver, token } = await seedDriver();
  const rider = await seedUser('RIDER');
  const ride = await seedRide(rider.id, driver.id);
  const storage = fakeStorage();
  const complete = (segmentIndex = 1) => call(deps(storage), 'POST', '/drivers/me/trip-recordings/complete', { token, body: { rideId: ride.id, segmentIndex, durationSec: 300 } });
  const key = `trips/${ride.id}/segment-001.m4a`;

  const early = await complete();
  assert.deepEqual([early.status, early.body.code], [425, 'not_arrived'], 'not there yet: the phone tries again, it does not drop the file');
  storage.put(key, 1_200_000);
  assert.equal((await complete()).status, 200);
  assert.equal((await complete()).status, 200);
  const rows = await prisma.tripRecording.findMany({ where: { rideId: ride.id } });
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].bytes, rows[0].durationSec, rows[0].etag], [1_200_000, 300, `"e-${key}"`]);

  const again = await call(deps(storage), 'POST', '/drivers/me/trip-recordings/upload-url', { token, body: { rideId: ride.id, segmentIndex: 1, bytes: 1_200_000 } });
  assert.deepEqual([again.status, again.body.code], [409, 'already_recorded'], 'nobody can overwrite a recorded piece');

  storage.put(`trips/${ride.id}/segment-002.m4a`, 25 * 1024 * 1024);
  assert.equal((await complete(2)).status, 413);
  assert.ok(storage.removed.includes(`trips/${ride.id}/segment-002.m4a`), 'an oversize upload is deleted');

  storage.put(`trips/${ride.id}/segment-003.m4a`, 5000, { bytes: Buffer.from('<html>not audio') });
  assert.equal((await complete(3)).status, 415);
  assert.ok(storage.removed.includes(`trips/${ride.id}/segment-003.m4a`), 'a file that is not a recording is deleted');
});

test('start: only the ride\'s driver on a running trip; it marks the trip once and gives the next piece number', async () => {
  const mine = await seedDriver();
  const other = await seedDriver();
  const rider = await seedUser('RIDER');
  const ride = await seedRide(rider.id, mine.driver.id, { recordingStartedAt: null });
  const storage = fakeStorage();
  const d = deps(storage);
  const start = (token, rideId = ride.id) => call(d, 'POST', '/drivers/me/trip-recordings/start', { token, body: { rideId } });

  assert.equal((await start(other.token)).status, 403);
  const ok = await start(mine.token);
  assert.deepEqual([ok.status, ok.body.ok, ok.body.nextSegmentIndex], [200, true, 0]);
  const marked = (await prisma.ride.findUnique({ where: { id: ride.id } })).recordingStartedAt;
  assert.ok(marked);
  await prisma.tripRecording.create({ data: { rideId: ride.id, driverId: mine.driver.id, segmentIndex: 0, objectKey: 'k0', bytes: 1 } });
  const again = await start(mine.token);
  assert.equal(again.body.nextSegmentIndex, 1, 'after a reinstall the phone carries on from the server, never over a recorded piece');
  assert.equal((await prisma.ride.findUnique({ where: { id: ride.id } })).recordingStartedAt.getTime(), marked.getTime(), 'marked once: a second start keeps the first time');

  const done = await seedRide(rider.id, mine.driver.id, { status: 'COMPLETED', completedAt: new Date(), recordingStartedAt: null });
  assert.equal((await start(mine.token, done.id)).body.code, 'not_running');
  assert.equal((await call(deps(storage, { enabled: false }), 'POST', '/drivers/me/trip-recordings/start', { token: mine.token, body: { rideId: ride.id } })).status, 404);
});

test('listening: support and owners only, logged first, and a changed file is marked', async () => {
  const { driver } = await seedDriver();
  const rider = await seedUser('RIDER');
  const ride = await seedRide(rider.id, driver.id);
  const storage = fakeStorage();
  const key0 = `trips/${ride.id}/segment-000.m4a`;
  const key1 = `trips/${ride.id}/segment-001.m4a`;
  storage.put(key0, 1000, { etag: '"a"' });
  storage.put(key1, 1000, { etag: '"swapped"' });
  await prisma.tripRecording.create({ data: { rideId: ride.id, driverId: driver.id, segmentIndex: 0, objectKey: key0, bytes: 1000, etag: '"a"' } });
  await prisma.tripRecording.create({ data: { rideId: ride.id, driverId: driver.id, segmentIndex: 1, objectKey: key1, bytes: 1000, etag: '"b"' } });
  const path = `/admin/rides/${ride.id}/recordings`;

  assert.equal((await call(deps(storage), 'GET', path)).status, 401);
  assert.equal((await call(deps(storage), 'GET', path, { token: await seedAdmin('STAFF') })).status, 403);

  const support = await call(deps(storage), 'GET', path, { token: await seedAdmin('SUPPORT') });
  assert.equal(support.status, 200);
  assert.deepEqual(support.body.recordings.map((r) => [r.segmentIndex, r.changed]), [[0, false], [1, true]]);
  assert.equal(support.body.recordings[0].url, `https://r2.example/get/${key0}`);
  assert.ok(support.body.recordingStartedAt);
  const owner = await call(deps(storage), 'GET', path, { headers: { 'x-admin-key': ADMIN_KEY } });
  assert.equal(owner.status, 200);

  const logged = await prisma.adminActivity.findMany({ where: { kind: 'trip_recording_listen', page: path } });
  assert.equal(logged.length, 2);
  assert.ok(logged.every((row) => row.flagged));
});

test('the sweep: older than 30 days goes, object and row; a failed delete is kept to retry; a never-confirmed upload goes too', async () => {
  const { driver } = await seedDriver();
  const rider = await seedUser('RIDER');
  const ride = await seedRide(rider.id, driver.id, { status: 'COMPLETED', completedAt: new Date() });
  const storage = fakeStorage();
  const DAY = 24 * HOUR;
  const old = await prisma.tripRecording.create({ data: { rideId: ride.id, driverId: driver.id, segmentIndex: 0, objectKey: `sweep-${ride.id}/old.m4a`, bytes: 1, createdAt: new Date(Date.now() - 31 * DAY) } });
  const stuck = await prisma.tripRecording.create({ data: { rideId: ride.id, driverId: driver.id, segmentIndex: 2, objectKey: `sweep-${ride.id}/stuck.m4a`, bytes: 1, createdAt: new Date(Date.now() - 31 * DAY) } });
  const fresh = await prisma.tripRecording.create({ data: { rideId: ride.id, driverId: driver.id, segmentIndex: 1, objectKey: `sweep-${ride.id}/fresh.m4a`, bytes: 1, createdAt: new Date(Date.now() - 29 * DAY) } });
  storage.put(`sweep-${ride.id}/stuck.m4a`, 1);
  storage.failDelete.add(`sweep-${ride.id}/stuck.m4a`);
  storage.put(`trips/${ride.id}/orphan.m4a`, 1, { modified: new Date(Date.now() - 31 * DAY) });
  storage.put(`trips/${ride.id}/recent-orphan.m4a`, 1, { modified: new Date(Date.now() - 2 * DAY) });

  await sweepTripRecordings(storage);
  assert.ok(storage.removed.includes(`sweep-${ride.id}/old.m4a`));
  assert.ok(!storage.removed.includes(`sweep-${ride.id}/fresh.m4a`));
  assert.ok((await prisma.tripRecording.findUnique({ where: { id: old.id } })).deletedAt);
  assert.equal((await prisma.tripRecording.findUnique({ where: { id: stuck.id } })).deletedAt, null, 'R2 did not delete it: the row stays, the next sweep tries again');
  assert.equal((await prisma.tripRecording.findUnique({ where: { id: fresh.id } })).deletedAt, null);
  assert.ok(storage.removed.includes(`trips/${ride.id}/orphan.m4a`), 'an upload never confirmed is deleted at 30 days too');
  assert.ok(!storage.removed.includes(`trips/${ride.id}/recent-orphan.m4a`));
});
