// The driver's face check before every ride (Timi, 18 Nov 2026). Booked: a scan is due within 2 minutes (look
// straight, turn the way the screen says, straight again). The same person all through, the head really turned, and
// close enough to the KYC selfie: passed. Not the driver after 3 tries, or no scan in time: the ride goes back to the
// search for the rider and Telegram hears it. The check cannot run: the ride goes back, the driver takes no rides for
// a while, Telegram hears it. Until passed (FACE_CHECK=on) no Arrived, no Start. Shadow: all recorded, nothing enforced.
// Real Postgres, Redis 15; a fake face engine for the flow, the real library on its sample photos at the end.
//
//   npm -w @wheleers/config run build && npm -w @wheleers/db run build && npm -w @wheleers/api-gateway run build
//   node scripts/run-with-env.cjs node --test --test-force-exit test/driver-face-check.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const { RedisClient } = require('../apps/api-gateway/dist/redis/client.js');
const fc = require('../apps/api-gateway/dist/face/face-check.js');
const { handleRideMessage } = require('../apps/api-gateway/dist/websocket/handlers/ride.handler.js');
const { FACE_CHECK_SECONDS, FACE_CHECK_TRIES, FACE_CHECK_MAX_SUBMITS } = require('../packages/config/dist/index.js');

const prisma = new PrismaClient();
let redis;
const made = { users: [], drivers: [], rides: [] };
const realConsole = { ...console };
test.before(async () => {
  redis = new RedisClient(process.env.TEST_REDIS_URL || 'redis://127.0.0.1:6379/15');
  await redis.connect();
});
test.beforeEach(() => { console.log = console.info = console.warn = console.error = () => {}; });
test.afterEach(() => { Object.assign(console, realConsole); delete process.env.FACE_CHECK; });
test.after(async () => {
  for (const id of made.users) { await redis.del(`face:blocked:${id}`).catch(() => {}); await redis.del(`face:capable:${id}`).catch(() => {}); }
  await prisma.faceCheck.deleteMany({ where: { rideId: { in: made.rides } } });
  await prisma.driverFaceTemplate.deleteMany({ where: { driverId: { in: made.drivers } } });
  await prisma.driverKycSubmission.deleteMany({ where: { driverId: { in: made.drivers } } });
  await prisma.ride.deleteMany({ where: { id: { in: made.rides } } });
  await prisma.driver.deleteMany({ where: { id: { in: made.drivers } } });
  await prisma.user.deleteMany({ where: { id: { in: made.users } } });
  await prisma.$disconnect();
  await redis.disconnect().catch(() => {});
});

async function user(role) {
  const id = randomUUID();
  await prisma.user.create({ data: { id, privyDid: `test:face:${id}`, role, name: `Face ${role}` } });
  made.users.push(id);
  return id;
}
async function driver({ selfie = true } = {}) {
  const userId = await user('DRIVER');
  const d = await prisma.driver.create({ data: { userId, kycStatus: 'APPROVED', status: 'ON_RIDE', vehicleModel: 'Corolla', vehiclePlate: 'KJA1' } });
  made.drivers.push(d.id);
  await prisma.driverKycSubmission.create({ data: { driverId: d.id, selfieKey: selfie ? `drivers/kyc/${d.id}/selfie.jpg` : null, status: 'APPROVED' } });
  return { id: d.id, userId };
}
async function booked(d, extra = {}) {
  const riderId = await user('RIDER');
  const r = await prisma.ride.create({
    data: { riderId, driverId: d.id, status: 'DRIVER_ASSIGNED', pickupLat: 6.6, pickupLng: 3.35, pickupAddress: 'Opebi', destLat: 6.5, destLng: 3.36, destAddress: 'Surulere', fareEstimateNgn: 5000, riderOfferNgn: 5000, agreedFareNgn: 5000, matchedAt: new Date(), ...extra },
  });
  made.rides.push(r.id);
  return r;
}

// A fake engine: each "photo" is a buffer whose first byte names who is in it and which way they look.
// person 1 = the driver (matches the selfie), person 2 = someone else; 0 = no face; 9 = two faces; 7 = too far.
const DRIVER = Array.from({ length: 128 }, (_, i) => Math.sin(i) * 0.1);
const OTHER = DRIVER.map((v, i) => v + (i % 2 ? 0.08 : -0.08));
const photo = (who, turn = 0) => { const b = Buffer.alloc(2000, 1); b[0] = who; b[1] = turn === 0 ? 0 : turn > 0 ? 1 : 2; return b; };
const fakeEngine = {
  calls: 0,
  async faces(buf) {
    this.calls += 1;
    const who = buf[0];
    const turn = buf[1] === 0 ? 0 : buf[1] === 1 ? 0.3 : -0.3;
    const face = (descriptor) => ({ descriptor, turn, score: 0.99, size: who === 7 ? 0.05 : 0.4 });
    if (who === 0) return [];
    if (who === 9) return [face(DRIVER), face(OTHER)];
    return [face(who === 2 ? OTHER : DRIVER)];
  },
};
const b64 = (b) => b.toString('base64');
const scan = (who, turned = 0.3) => [photo(who), photo(who, turned), photo(who)].map(b64);

function world(mode = 'on', over = {}) {
  const w = {
    events: [], alerts: [], told: [], uploads: [], removed: [],
    redis, mode, engine: fakeEngine, shrink: async (b) => b,
    publisher: { publishRideEvent: async (e) => { w.events.push(e); } },
    kycStorage: { getFile: async () => ({ bytes: photo(1) }) },
    frameStorage: {
      upload: async ({ type }) => { const key = `drivers/face-checks/x/${type}.jpg`; w.uploads.push(key); return key; },
      remove: async (key) => { w.removed.push(key); },
      getFile: async () => null,
    },
    notifyDriver: async (userId, type, payload) => { w.told.push({ userId, type, payload }); },
    alert: async (title, body) => { w.alerts.push({ title, body }); },
    ...over,
  };
  return w;
}

test('booked: a scan is due in 2 minutes with a head turn to ask for; never a group trip, never with the check off', async () => {
  const w = world('on');
  const d = await driver();
  const r = await booked(d);
  const view = await fc.startFaceCheck(w, { rideId: r.id, driverId: d.id, driverUserId: d.userId });
  assert.ok(['left', 'right'].includes(view.challenge));
  assert.equal(view.triesLeft, FACE_CHECK_TRIES);
  assert.equal(view.mode, 'on');
  const secs = (Date.parse(view.deadlineAt) - Date.now()) / 1000;
  assert.ok(secs > FACE_CHECK_SECONDS - 5 && secs <= FACE_CHECK_SECONDS, `deadline ${secs}s`);
  assert.equal((await fc.startFaceCheck(w, { rideId: r.id, driverId: d.id, driverUserId: d.userId })).checkId, view.checkId, 'the same check, never a second');
  assert.deepEqual(await fc.pendingFaceCheck(r.id, d.id), view, 'after a reconnect');

  const g = await booked(d, { groupRole: 'TRIP' });
  assert.equal(await fc.startFaceCheck(w, { rideId: g.id, driverId: d.id, driverUserId: d.userId }), null, 'group trips not checked yet');
  const off = await booked(d);
  assert.equal(await fc.startFaceCheck(world('off'), { rideId: off.id, driverId: off.driverId, driverUserId: d.userId }), null);
  const other = await driver();
  assert.equal(await fc.startFaceCheck(w, { rideId: off.id, driverId: other.id, driverUserId: other.userId }), null, 'not the ride\'s driver');
  // Shadow: only for an app that can scan (driver:online faceChecks).
  assert.equal(await fc.startFaceCheck(world('shadow'), { rideId: off.id, driverId: d.id, driverUserId: d.userId }), null);
  await fc.noteFaceCheckDriver(redis, d.userId);
  assert.equal((await fc.startFaceCheck(world('shadow'), { rideId: off.id, driverId: d.id, driverUserId: d.userId })).mode, 'shadow');
});

test('the driver, head turned: passed; Arrived and Start are refused until then', async () => {
  const w = world('on');
  const d = await driver();
  const r = await booked(d);
  await fc.startFaceCheck(w, { rideId: r.id, driverId: d.id, driverUserId: d.userId });
  await assert.rejects(fc.assertFaceCheckPassed(r.id, d.id, 'on'), /Scan your face first/);
  await fc.assertFaceCheckPassed(r.id, d.id, 'shadow'); // shadow never blocks

  // Over the real socket path: Arrived and Start say the same.
  process.env.FACE_CHECK = 'on';
  const auth = { userId: d.userId, driverId: d.id, role: 'DRIVER' };
  await assert.rejects(handleRideMessage('ride:arrived', { rideId: r.id }, auth, w.publisher, {}, redis), /Scan your face first/);
  await assert.rejects(handleRideMessage('ride:start', { rideId: r.id, riderId: r.riderId, lockedFareNgn: 5000 }, auth, w.publisher, {}, redis), /Scan your face first/);
  assert.equal(w.events.length, 0, 'nothing published');

  assert.deepEqual(await fc.submitFaceCheck(w, { driverUserId: d.userId, rideId: r.id, frames: scan(1) }), { status: 'passed' });
  await fc.assertFaceCheckPassed(r.id, d.id, 'on');
  const row = await prisma.faceCheck.findUnique({ where: { rideId_driverId: { rideId: r.id, driverId: d.id } } });
  assert.equal(row.status, 'PASSED');
  assert.equal(row.frameKeys.length, 3, 'three frames kept');
  assert.ok(row.bestDistance < 0.01);
  assert.equal((await prisma.driverFaceTemplate.findUnique({ where: { driverId: d.id } })).selfieKey, `drivers/kyc/${d.id}/selfie.jpg`, 'the selfie\'s face kept');
  assert.ok(w.told.some((t) => t.type === 'ride:face_check:passed'));
  assert.equal(w.alerts.length, 0);
  assert.equal(await fc.pendingFaceCheck(r.id, d.id), null);
  assert.equal((await fc.submitFaceCheck(w, { driverUserId: d.userId, rideId: r.id, frames: scan(1) })).status, 'none', 'done once');
  await handleRideMessage('ride:arrived', { rideId: r.id }, auth, w.publisher, {}, redis);
  assert.equal(w.events.at(-1).eventType, 'RIDE_ARRIVED');
});

test('someone else: a new turn each try; out of tries the ride goes back to the search and Telegram hears it', async () => {
  const w = world('on');
  const d = await driver();
  const r = await booked(d);
  await fc.startFaceCheck(w, { rideId: r.id, driverId: d.id, driverUserId: d.userId });
  for (let i = 1; i < FACE_CHECK_TRIES; i++) {
    const answer = await fc.submitFaceCheck(w, { driverUserId: d.userId, rideId: r.id, frames: scan(2) });
    assert.equal(answer.status, 'retry');
    assert.equal(answer.triesLeft, FACE_CHECK_TRIES - i);
    assert.match(answer.reason, /didn't match/);
  }
  assert.equal((await fc.submitFaceCheck(w, { driverUserId: d.userId, rideId: r.id, frames: scan(2) })).status, 'failed');
  const cancel = w.events.find((e) => e.eventType === 'RIDE_CANCELLED');
  assert.equal(cancel.cancelledBy, 'driver', 'a driver cancel: ride-service offers it to every other driver');
  assert.equal(cancel.reason, 'face_check_failed');
  assert.equal(cancel.driverId, d.id);
  assert.equal(cancel.driverUserId, d.userId);
  assert.equal(w.alerts.length, 1);
  assert.match(w.alerts[0].title, /face didn't match/);
  assert.match(w.alerts[0].body, /sent back to the search/);
  assert.ok(w.told.some((t) => t.type === 'ride:face_check:failed'));
  assert.equal(await fc.faceCheckBidRefusal(redis, d.userId, 'shadow'), null, 'a failed match does not hold the driver back');
  // Back in the search (ride-service): this driver never bids on it again.
  await prisma.ride.update({ where: { id: r.id }, data: { status: 'MATCHING', driverId: null } });
  await fc.noteFaceCheckDriver(redis, d.userId);
  process.env.FACE_CHECK = 'on';
  await assert.rejects(
    handleRideMessage('driver:accept', { rideId: r.id, agreedFareNgn: 5000, etaSeconds: 300 }, { userId: d.userId, driverId: d.id, role: 'DRIVER' }, w.publisher, {}, redis),
    /You can't take this ride/,
  );
});

test('no head turn counts as a miss; an unclear photo does not, up to the scan limit', async () => {
  const w = world('on');
  const d = await driver();
  const r = await booked(d);
  await fc.startFaceCheck(w, { rideId: r.id, driverId: d.id, driverUserId: d.userId });
  const still = await fc.submitFaceCheck(w, { driverUserId: d.userId, rideId: r.id, frames: [photo(1), photo(1), photo(1)].map(b64) });
  assert.equal(still.status, 'retry');
  assert.equal(still.triesLeft, FACE_CHECK_TRIES - 1, 'a photo held up never turns');
  assert.match(still.reason, /Turn your head/);

  for (const [who, said] of [[0, /couldn't see your face/], [9, /Only you/], [7, /closer/]]) {
    const answer = await fc.submitFaceCheck(w, { driverUserId: d.userId, rideId: r.id, frames: scan(who) });
    assert.equal(answer.status, 'retry');
    assert.match(answer.reason, said);
    assert.equal(answer.triesLeft, FACE_CHECK_TRIES - 1, 'not counted');
  }
  // Bad frames (too small, two not three) are a retry and not a scan.
  assert.equal((await fc.submitFaceCheck(w, { driverUserId: d.userId, rideId: r.id, frames: ['abc', 'def'] })).status, 'retry');
  let last;
  let n = 4; // one no-turn scan and three unclear ones so far
  do { last = await fc.submitFaceCheck(w, { driverUserId: d.userId, rideId: r.id, frames: scan(0) }); n += 1; } while (last.status === 'retry' && n < 20);
  assert.equal(last.status, 'failed', 'scans are limited');
  assert.equal(n, FACE_CHECK_MAX_SUBMITS);
  assert.equal((await prisma.faceCheck.findFirst({ where: { rideId: r.id } })).status, 'FAILED');
});

test('the check cannot run: the ride goes back, the driver takes no rides for a while, Telegram always', async () => {
  const w = world('on');
  const d = await driver({ selfie: false });
  const r = await booked(d);
  await fc.startFaceCheck(w, { rideId: r.id, driverId: d.id, driverUserId: d.userId });
  await fc.noteFaceCheckDriver(redis, d.userId);
  assert.equal(await fc.faceCheckBidRefusal(redis, d.userId, 'on'), null);
  const answer = await fc.submitFaceCheck(w, { driverUserId: d.userId, rideId: r.id, frames: scan(1) });
  assert.equal(answer.status, 'error');
  assert.equal(w.events.at(-1).reason, 'face_check_unavailable');
  assert.match(w.alerts[0].title, /couldn't run/);
  assert.match(await fc.faceCheckBidRefusal(redis, d.userId, 'on'), /can't take rides/);
  // Over the socket: the bid is refused.
  const other = await booked(await driver(), { status: 'MATCHING', driverId: null });
  process.env.FACE_CHECK = 'on';
  await assert.rejects(
    handleRideMessage('driver:accept', { rideId: other.id, agreedFareNgn: 5000, etaSeconds: 300 }, { userId: d.userId, driverId: d.id, role: 'DRIVER' }, w.publisher, {}, redis),
    /can't take rides/,
  );

  // The library itself failing is the same.
  const w2 = world('on', { engine: { faces: async () => { throw new Error('wasm gone'); } } });
  const d2 = await driver();
  const r2 = await booked(d2);
  await fc.startFaceCheck(w2, { rideId: r2.id, driverId: d2.id, driverUserId: d2.userId });
  assert.equal((await fc.submitFaceCheck(w2, { driverUserId: d2.userId, rideId: r2.id, frames: scan(1) })).status, 'error');
  assert.match((await prisma.faceCheck.findFirst({ where: { rideId: r2.id } })).lastReason, /engine: wasm gone/);
});

test('an app that cannot scan may not bid once the check is on', async () => {
  const d = await driver();
  assert.match(await fc.faceCheckBidRefusal(redis, d.userId, 'on'), /Update the app/);
  assert.equal(await fc.faceCheckBidRefusal(redis, d.userId, 'shadow'), null);
  assert.equal(await fc.faceCheckBidRefusal(redis, d.userId, 'off'), null);
  await fc.noteFaceCheckDriver(redis, d.userId);
  assert.equal(await fc.faceCheckBidRefusal(redis, d.userId, 'on'), null);
});

test('no scan in 2 minutes: the sweep ends it once (the ride goes back); a ride that moved on closes quietly', async () => {
  const w = world('on');
  const d = await driver();
  const r = await booked(d);
  await fc.startFaceCheck(w, { rideId: r.id, driverId: d.id, driverUserId: d.userId });
  const later = { ...w, now: () => Date.now() + (FACE_CHECK_SECONDS + 1) * 1000 };
  const [a, b] = await Promise.all([fc.sweepFaceChecks(later), fc.sweepFaceChecks(later)]);
  assert.ok(a.expired + b.expired >= 1);
  assert.equal(w.events.filter((e) => e.eventType === 'RIDE_CANCELLED' && e.rideId === r.id).length, 1, 'acted on once');
  assert.equal(w.events.find((e) => e.rideId === r.id).reason, 'face_check_timeout');
  assert.equal((await prisma.faceCheck.findFirst({ where: { rideId: r.id } })).status, 'EXPIRED');
  // A late scan is told it is over.
  assert.equal((await fc.submitFaceCheck(later, { driverUserId: d.userId, rideId: r.id, frames: scan(1) })).status, 'none');

  const d2 = await driver();
  const gone = await booked(d2);
  await fc.startFaceCheck(w, { rideId: gone.id, driverId: d2.id, driverUserId: d2.userId });
  await prisma.ride.update({ where: { id: gone.id }, data: { status: 'CANCELLED' } });
  const before = w.events.length;
  await fc.sweepFaceChecks(later);
  assert.equal(w.events.length, before, 'nothing sent for a ride already over');
  assert.equal((await prisma.faceCheck.findFirst({ where: { rideId: gone.id } })).lastReason, 'ride moved on');
});

test('shadow: everything is checked and alerted, nothing is cancelled or blocked', async () => {
  const w = world('shadow');
  const d = await driver({ selfie: false });
  await fc.noteFaceCheckDriver(redis, d.userId);
  const r = await booked(d);
  await fc.startFaceCheck(w, { rideId: r.id, driverId: d.id, driverUserId: d.userId });
  assert.equal((await fc.submitFaceCheck(w, { driverUserId: d.userId, rideId: r.id, frames: scan(1) })).status, 'error');
  assert.equal(w.events.length, 0, 'the ride goes on');
  assert.match(w.alerts[0].title, /^\[shadow\]/);
  assert.equal(await redis.get(`face:blocked:${d.userId}`), null);
  assert.equal(w.told.length, 0, 'the driver is not told in shadow');
});

test('frames are deleted after 30 days', async () => {
  const w = world('on');
  const d = await driver();
  const r = await booked(d);
  await prisma.faceCheck.create({
    data: { rideId: r.id, driverId: d.id, driverUserId: d.userId, challenge: 'left', mode: 'on', status: 'PASSED', deadlineAt: new Date(), frameKeys: ['drivers/face-checks/a.jpg', 'drivers/face-checks/b.jpg'], createdAt: new Date(Date.now() - 31 * 86_400_000) },
  });
  await fc.sweepFaceChecks(w);
  assert.ok(w.removed.includes('drivers/face-checks/a.jpg') && w.removed.includes('drivers/face-checks/b.jpg'));
  assert.ok((await prisma.faceCheck.findFirst({ where: { rideId: r.id } })).framesDeletedAt);
  const again = w.removed.length;
  await fc.sweepFaceChecks(w);
  assert.equal(w.removed.length, again, 'once');
});

test('POST /drivers/face-check over HTTP: signed in only, a scan answered', async () => {
  const http = require('node:http');
  const local = require('../apps/api-gateway/dist/auth/local.js');
  const { handleDriverFaceCheckRoute } = require('../apps/api-gateway/dist/http/driver-face-check.route.js');
  const jwtSecret = 'test-secret-that-is-at-least-32-characters-long';
  const w = world('on');
  const server = http.createServer((req, res) => { void handleDriverFaceCheckRoute(req, res, { ...w, jwtSecret }); });
  await new Promise((r) => server.listen(0, r));
  const url = `http://127.0.0.1:${server.address().port}/drivers/face-check`;
  try {
    const d = await driver();
    const r = await booked(d);
    await fc.startFaceCheck(w, { rideId: r.id, driverId: d.id, driverUserId: d.userId });
    const headers = { authorization: `Bearer ${local.createLocalAccessToken(d.userId, jwtSecret, 3600)}`, 'content-type': 'application/json' };
    assert.equal((await fetch(url, { method: 'POST', body: '{}' })).status, 401);
    assert.equal((await fetch(url, { method: 'POST', headers, body: JSON.stringify({ rideId: r.id }) })).status, 400);
    // Another driver cannot scan for this ride.
    const stranger = await driver();
    const strangerHeaders = { ...headers, authorization: `Bearer ${local.createLocalAccessToken(stranger.userId, jwtSecret, 3600)}` };
    assert.equal((await (await fetch(url, { method: 'POST', headers: strangerHeaders, body: JSON.stringify({ rideId: r.id, frames: scan(1) }) })).json()).status, 'none');
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ rideId: r.id, frames: scan(1) }) });
    assert.deepEqual(await res.json(), { status: 'passed' });
  } finally {
    server.close();
  }
});

test('the real library: finds faces, one person is close to themselves and far from others', { timeout: 120_000 }, async () => {
  const Jimp = require('jimp');
  const { faceEngine, faceDistance } = require('../apps/api-gateway/dist/face/engine.js');
  const demo = path.join(path.dirname(require.resolve('@vladmandic/face-api/package.json')), 'demo');
  const group = await Jimp.read(path.join(demo, 'sample1.jpg'));
  const found = await faceEngine.faces(await group.getBufferAsync(Jimp.MIME_JPEG));
  assert.ok(found.length >= 2, `faces in the group photo: ${found.length}`);
  for (const f of found) {
    assert.equal(f.descriptor.length, 128);
    assert.ok(Math.abs(f.turn) < 0.6, 'a turn measure in range');
  }
  // Another photo of the same people (smaller, brighter, softer): each face's nearest is itself.
  const copy = group.clone().resize(900, Jimp.AUTO).brightness(0.15).blur(1);
  const again = await faceEngine.faces(await copy.getBufferAsync(Jimp.MIME_JPEG));
  const same = found.map((f) => Math.min(...again.map((g) => faceDistance(f.descriptor, g.descriptor))));
  const others = [];
  for (const f of found) for (const g of found) if (f !== g) others.push(faceDistance(f.descriptor, g.descriptor));
  assert.ok(Math.max(...same) < 0.45, `same person: ${same.map((x) => x.toFixed(2))}`);
  assert.ok(Math.min(...others) > Math.max(...same), 'never closer to someone else than to themselves');
  // Not a photo: no faces, no crash.
  assert.deepEqual(await faceEngine.faces(fs.readFileSync(path.join(demo, 'facemesh.png')).subarray(0, 0)).catch(() => []), []);
});

test('a frame that is not a photo is a try-again, never a broken check (the driver is not held back)', async () => {
  const w = world('on', { shrink: undefined });
  const d = await driver();
  const r = await booked(d);
  await fc.startFaceCheck(w, { rideId: r.id, driverId: d.id, driverUserId: d.userId });
  const answer = await fc.submitFaceCheck(w, { driverUserId: d.userId, rideId: r.id, frames: [photo(1), photo(1, 0.3), photo(1)].map(b64) });
  assert.equal(answer.status, 'retry');
  assert.equal(answer.triesLeft, FACE_CHECK_TRIES);
  const row = await prisma.faceCheck.findFirst({ where: { rideId: r.id } });
  assert.equal(row.status, 'PENDING');
  assert.equal(row.submits, 0, 'not counted');
  assert.equal(w.events.length + w.alerts.length, 0);
});
