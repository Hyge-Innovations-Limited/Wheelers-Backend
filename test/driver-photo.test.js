// The driver's face in the rider's avatar (DRIVER_PHOTO_ENABLED): driverPhotoUrl + driverPhotoKey.
// Profile photo (only our own R2 key) > KYC selfie > null. Through the real entry points that build the
// payloads (handleRideEvent counter offer + matched, GET /rides/active, GET /ride-page/state) against the local
// Postgres. The signer is a stub: no real R2 is ever touched, and no key is read from .env.
//
//   node scripts/run-with-env.cjs node --test --test-force-exit --test-concurrency=1 --test-reporter=tap test/driver-photo.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { randomUUID, createHash } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');

const local = require('../apps/api-gateway/dist/auth/local.js');
const bidState = require('../apps/api-gateway/dist/whatsapp-flows/bid-state.js');
const { handleRidePageRoute } = require('../apps/api-gateway/dist/http/ride-page.route.js');
const { handleActiveRideRoute } = require('../apps/api-gateway/dist/http/ride.route.js');
const { handleRideEvent } = require('../apps/api-gateway/dist/kafka/consumer.js');
const photo = require('../apps/api-gateway/dist/drivers/driver-photo.js');

const prisma = new PrismaClient();
const JWT_SECRET = 'test-secret-that-is-at-least-32-characters-long';
const realConsole = { log: console.log, info: console.info, warn: console.warn, error: console.error };
const made = { users: [], drivers: [], rides: [] };
const YABA = { lat: 6.5095, lng: 3.3711, address: '12 Herbert Macaulay Way, Yaba, Lagos' };
const VI = { lat: 6.4281, lng: 3.4219, address: 'Adeola Odeku Street, Victoria Island, Lagos' };

function memoryRedis() {
  const store = new Map(); const ttls = new Map();
  return {
    store, ttls,
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async set(k, v, ttl) { store.set(k, v); if (ttl) ttls.set(k, ttl); },
    async del(k) { store.delete(k); },
    async setIfNotExists(k, v) { if (store.has(k)) return false; store.set(k, v); return true; },
    sets: new Map(),
    async send(cmd, key, member) {
      if (cmd === 'SADD') { const set = this.sets.get(key) ?? new Set(); const had = set.has(member); set.add(member); this.sets.set(key, set); return had ? 0 : 1; }
      if (cmd === 'SCARD') return (this.sets.get(key) ?? new Set()).size;
      if (cmd === 'SREM') { (this.sets.get(key) ?? new Set()).delete(member); return 1; }
      if (cmd === 'EXPIRE') { this.ttls.set(key, Number(member)); return 1; }
      return null;
    },
  };
}

/** A signer that counts, and answers an opaque URL (a real one carries the key in its path, signed). */
function stubStorage() {
  const signed = [];
  return {
    signed,
    async getSignedUrl(key, expires) {
      signed.push({ key, expires });
      return `https://r2.stub.test/signed/${createHash('sha256').update(key).digest('hex').slice(0, 16)}?X-Sig=abc`;
    },
  };
}

async function makeUser(role, name, extra = {}) {
  const id = randomUUID();
  await prisma.user.create({ data: { id, privyDid: `local:${id}`, role, name, phone: `+23480${Math.floor(1e8 + Math.random() * 9e8)}`, privacyConsent: 'AGREED', ...extra } });
  await prisma.wallet.create({ data: { userId: id, balanceNgn: 20_000 } });
  made.users.push(id);
  return id;
}
/** A driver; selfieKey / photoUrl are what the photo can come from. */
async function makeDriver({ selfieKey, photoUrl, name = 'Chinedu Okafor' } = {}) {
  const userId = await makeUser('DRIVER', name, photoUrl !== undefined ? { photoUrl } : {});
  const driver = await prisma.driver.create({ data: { userId, status: 'ONLINE', kycStatus: 'APPROVED', lat: 6.5, lng: 3.37, lastSeenAt: new Date(), vehicleModel: 'Corolla', vehiclePlate: `LND-${Math.floor(100 + Math.random() * 899)}XA`, totalRides: 12 } });
  made.drivers.push(driver.id);
  if (selfieKey) await prisma.driverKycSubmission.create({ data: { driverId: driver.id, selfieKey } });
  return { userId, driverId: driver.id, id: driver.id };
}
async function makeRide(riderId, data = {}) {
  const ride = await prisma.ride.create({ data: { riderId, pickupLat: YABA.lat, pickupLng: YABA.lng, pickupAddress: YABA.address, destLat: VI.lat, destLng: VI.lng, destAddress: VI.address, riderOfferNgn: 6000, ...data } });
  made.rides.push(ride.id);
  return ride;
}
const resolverWith = (storage, redis) => photo.createDriverPhotoResolver({ storage, redis });

test.beforeEach(() => { console.log = console.info = console.warn = console.error = () => {}; });
test.afterEach(() => { Object.assign(console, realConsole); });
test.after(async () => {
  await prisma.driverBid.deleteMany({ where: { rideId: { in: made.rides } } });
  await prisma.ride.deleteMany({ where: { id: { in: made.rides } } });
  await prisma.driverKycSubmission.deleteMany({ where: { driverId: { in: made.drivers } } });
  await prisma.driver.deleteMany({ where: { id: { in: made.drivers } } });
  await prisma.wallet.deleteMany({ where: { userId: { in: made.users } } });
  await prisma.user.deleteMany({ where: { id: { in: made.users } } });
  await prisma.$disconnect();
});

/* ── the resolver ─────────────────────────────────────────────────────── */

test('the KYC selfie is signed for an hour; the URL is https, the key is a stable version of the driver + object', async () => {
  const storage = stubStorage();
  const d = await makeDriver({ selfieKey: 'drivers/kyc/abc/selfie-1.jpg' });
  const got = await resolverWith(storage, memoryRedis()).forDriver(d.driverId);
  assert.match(got.driverPhotoUrl, /^https:\/\/r2\.stub\.test\/signed\//);
  assert.match(got.driverPhotoKey, new RegExp(`^${d.driverId}-[0-9a-f]{10}$`));
  assert.deepEqual(storage.signed, [{ key: 'drivers/kyc/abc/selfie-1.jpg', expires: 3600 }]);
  // A new selfie is a new key (the client cache drops the old picture); the same one keeps its key.
  await prisma.driverKycSubmission.update({ where: { driverId: d.driverId }, data: { selfieKey: 'drivers/kyc/abc/selfie-2.jpg' } });
  const second = await resolverWith(storage, memoryRedis()).forDriver(d.driverId);
  assert.notEqual(second.driverPhotoKey, got.driverPhotoKey);
  const again = await resolverWith(stubStorage(), memoryRedis()).forDriver(d.driverId);
  assert.equal(again.driverPhotoKey, second.driverPhotoKey);
});

test('an own-R2 profile photo wins over the selfie', async () => {
  const storage = stubStorage();
  const d = await makeDriver({ selfieKey: 'drivers/kyc/x/selfie.jpg' });
  await prisma.user.update({ where: { id: d.userId }, data: { photoUrl: `drivers/profile/${d.driverId}/face-1.jpg` } });
  await resolverWith(storage, memoryRedis()).forDriver(d.driverId);
  assert.deepEqual(storage.signed.map((s) => s.key), [`drivers/profile/${d.driverId}/face-1.jpg`]);
});

test('a foreign photoUrl is ignored: another site, another driver\'s folder, a path trick, a data URL', async () => {
  const bads = (own) => ['https://evil.example/me.jpg', 'http://x/y.png', 'data:image/png;base64,AAAA', '//cdn/x.jpg', '../../etc/passwd', 'drivers/profile/someone-else/face.jpg', `drivers/${'a'}/../b.jpg`, '/drivers/x.jpg', 'riders/face/1.jpg', ' drivers/x/y.jpg',
    // The driver's own KYC documents and car photos are not a profile photo.
    `drivers/kyc/${own}/licence-1.jpg`, `drivers/kyc/${own}/nin-1.jpg`, `drivers/kyc/${own}/vehicle-1700000000-abc.jpg`, `drivers/${own}/face.jpg`, `drivers/profile/${own}/`, `drivers/profile/${own}/../x.jpg`];
  for (const i of bads('X').keys()) {
    const storage = stubStorage();
    const d = await makeDriver({ selfieKey: 'drivers/kyc/own/selfie.jpg' });
    const bad = bads(d.driverId)[i];
    await prisma.user.update({ where: { id: d.userId }, data: { photoUrl: bad } });
    await resolverWith(storage, memoryRedis()).forDriver(d.driverId);
    assert.deepEqual(storage.signed.map((s) => s.key), ['drivers/kyc/own/selfie.jpg'], `ignored: ${bad}`);
  }
});

test('no photo at all is null/null; storage off or unconfigured is null/null and signs nothing', async () => {
  const none = await makeDriver({ photoUrl: 'https://evil.example/me.jpg' });
  assert.deepEqual(await resolverWith(stubStorage(), memoryRedis()).forDriver(none.driverId), { driverPhotoUrl: null, driverPhotoKey: null });
  const withSelfie = await makeDriver({ selfieKey: 'drivers/kyc/o/s.jpg' });
  for (const off of [null, undefined]) {
    assert.deepEqual(await resolverWith(off, memoryRedis()).forDriver(withSelfie.driverId), { driverPhotoUrl: null, driverPhotoKey: null });
  }
  assert.deepEqual(await resolverWith(stubStorage(), memoryRedis()).forDriver('no-such-driver'), { driverPhotoUrl: null, driverPhotoKey: null });
  // A signer that throws, or answers something that is not an https URL, gives null and never the key.
  const broken = { async getSignedUrl() { throw new Error('r2 down'); } };
  assert.deepEqual(await resolverWith(broken, memoryRedis()).forDriver(withSelfie.driverId), { driverPhotoUrl: null, driverPhotoKey: null });
  const raw = { async getSignedUrl(key) { return key; } };
  assert.deepEqual(await resolverWith(raw, memoryRedis()).forDriver(withSelfie.driverId), { driverPhotoUrl: null, driverPhotoKey: null });
});

test('the signed URL is cached in Redis driver:{id}:photo for 50 minutes; a cache hit does not sign (or read the database) again', async () => {
  const storage = stubStorage(); const redis = memoryRedis();
  let reads = 0;
  const d = await makeDriver({ selfieKey: 'drivers/kyc/c/s.jpg' });
  const resolver = photo.createDriverPhotoResolver({ storage, redis, loadSources: async (id) => { reads += 1; return { kycSubmission: { selfieKey: 'drivers/kyc/c/s.jpg' } }; } });
  const first = await resolver.forDriver(d.driverId);
  assert.equal(redis.ttls.get(`driver:${d.driverId}:photo`), 3000);
  for (let i = 0; i < 6; i += 1) assert.deepEqual(await resolver.forDriver(d.driverId), first, 'a stable URL');
  // Even a fresh process (new resolver, same Redis) signs nothing.
  assert.deepEqual(await photo.createDriverPhotoResolver({ storage, redis, loadSources: async () => { reads += 1; return null; } }).forDriver(d.driverId), first);
  assert.equal(storage.signed.length, 1);
  assert.equal(reads, 1);
  // Many readers at the same moment share one sign.
  const s2 = stubStorage();
  const r2 = photo.createDriverPhotoResolver({ storage: s2, redis: memoryRedis(), loadSources: async () => ({ kycSubmission: { selfieKey: 'drivers/kyc/c/s.jpg' } }) });
  await Promise.all(Array.from({ length: 8 }, () => r2.forDriver('d-1')));
  assert.equal(s2.signed.length, 1);
});

/* ── /rides/active ────────────────────────────────────────────────────── */

async function activeRide(deps, token) {
  let server;
  try {
    server = http.createServer((req, res) => { void handleActiveRideRoute(req, res, deps); });
    await new Promise((resolve) => server.listen(0, resolve));
    return (await (await fetch(`http://127.0.0.1:${server.address().port}/rides/active`, { headers: { authorization: `Bearer ${token}` } })).json()).ride;
  } finally { await new Promise((resolve) => server.close(resolve)); }
}

test('/rides/active: a search with 5 offers costs at most 5 signs, repeated polls none; flag off carries no photo field at all', async () => {
  const rider = await makeUser('RIDER', 'Timi Rider');
  const token = local.createLocalAccessToken(rider, JWT_SECRET, 3600);
  const search = await makeRide(rider, { status: 'MATCHING' });
  const keys = [];
  for (let i = 0; i < 5; i += 1) {
    const d = await makeDriver({ selfieKey: `drivers/kyc/secret-${i}/selfie.jpg`, name: `Driver ${i}` });
    keys.push(`drivers/kyc/secret-${i}/selfie.jpg`);
    await prisma.driverBid.create({ data: { rideId: search.id, driverId: d.driverId, driverUserId: d.userId, riderId: rider, amountNgn: 6000 + i * 100, etaSeconds: 200 } });
  }
  const off = await activeRide({ jwtSecret: JWT_SECRET }, token);
  assert.equal(off.search.offers.length, 5);
  for (const o of off.search.offers) { assert.equal('driverPhotoUrl' in o, false); assert.equal('driverPhotoKey' in o, false); }

  const storage = stubStorage(); const redis = memoryRedis();
  const deps = { jwtSecret: JWT_SECRET, redisClient: redis, driverPhoto: resolverWith(storage, redis) };
  const on = await activeRide(deps, token);
  assert.equal(on.search.offers.length, 5);
  assert.ok(on.search.offers.every((o) => /^https:\/\/r2\.stub\.test\//.test(o.driverPhotoUrl) && typeof o.driverPhotoKey === 'string'));
  assert.equal(new Set(on.search.offers.map((o) => o.driverPhotoUrl)).size, 5);
  for (let i = 0; i < 4; i += 1) await activeRide(deps, token);
  assert.equal(storage.signed.length, 5, '5 offers, 5 signs, however many polls');
  // Everything else in the payload is exactly as it was.
  const strip = (o) => { const { driverPhotoUrl, driverPhotoKey, driverRidesCompleted, ...rest } = o; return rest; };
  assert.deepEqual(on.search.offers.map(strip), off.search.offers);
  for (const k of keys) assert.equal(JSON.stringify(on).includes(k), false, 'no raw object key');
  assert.equal(JSON.stringify(on).includes('selfie.jpg'), false);
});

test('/rides/active: the matched driver carries the photo; a driver with none is null/null; flag off adds nothing', async () => {
  const rider = await makeUser('RIDER', 'Timi Rider');
  const token = local.createLocalAccessToken(rider, JWT_SECRET, 3600);
  const withFace = await makeDriver({ selfieKey: 'drivers/kyc/m/selfie.jpg' });
  const r1 = await makeRide(rider, { status: 'DRIVER_ASSIGNED', driverId: withFace.driverId, agreedFareNgn: 6000 });
  const storage = stubStorage(); const redis = memoryRedis();
  const deps = { jwtSecret: JWT_SECRET, redisClient: redis, driverPhoto: resolverWith(storage, redis) };
  const on = await activeRide(deps, token);
  assert.equal(on.id, r1.id);
  assert.match(on.driver.driverPhotoUrl, /^https:\/\//);
  assert.match(on.driver.driverPhotoKey, new RegExp(`^${withFace.driverId}-`));
  const off = await activeRide({ jwtSecret: JWT_SECRET }, token);
  assert.equal('driverPhotoUrl' in off.driver, false);
  assert.deepEqual(off.driver, (({ driverPhotoUrl, driverPhotoKey, driverRidesCompleted, ...rest }) => rest)(on.driver));

  await prisma.ride.update({ where: { id: r1.id }, data: { status: 'CANCELLED' } });
  const bare = await makeDriver({});
  await makeRide(rider, { status: 'DRIVER_ASSIGNED', driverId: bare.driverId, agreedFareNgn: 6000 });
  const none = await activeRide(deps, token);
  assert.equal(none.driver.driverPhotoUrl, null);
  assert.equal(none.driver.driverPhotoKey, null);
});

/* ── the ride page ────────────────────────────────────────────────────── */

async function pageState(deps, userId) {
  const bearer = local.createWalletPageToken(userId, 'ride', JWT_SECRET, local.RIDE_PAGE_TOKEN_TTL_SECONDS);
  const req = { method: 'GET', headers: { authorization: `Bearer ${bearer}` }, async *[Symbol.asyncIterator]() {} };
  const res = { statusCode: 200, body: null, headers: {}, setHeader() {}, writeHead(c) { this.statusCode = c; return this; }, end(t) { this.body = t ? JSON.parse(t) : null; } };
  await handleRidePageRoute(req, res, deps, new URL('http://x/ride-page/state'));
  return res.body;
}
const pageDeps = (redis, extra = {}) => ({ jwtSecret: JWT_SECRET, redisClient: redis, publisher: { publishRideEvent: async () => {}, publishNotificationEvent: async () => {} }, paymentsClient: {}, notifyChat: async () => {}, ...extra });

test('ride page offers: 5 offers cost at most 5 signs, polls none; flag off is exactly today\'s state; no raw key', async () => {
  const rider = await makeUser('RIDER', 'Timi Rider');
  const redis = memoryRedis();
  const rideId = randomUUID();
  await bidState.storeWhatsappRide(redis, rideId, { riderId: rider, phone: '+2348030000001', paymentMethod: 'WALLET', pickupAddress: YABA.address, destinationAddress: VI.address, pickupLat: YABA.lat, pickupLng: YABA.lng, destinationLat: VI.lat, destinationLng: VI.lng, offerNgn: 6000, suggestedFareNgn: 6000, distanceKm: 11, durationSeconds: 1500, stops: [], createdAt: new Date().toISOString() });
  await bidState.setRideState(redis, rideId, 'bidding');
  await bidState.setActiveRide(redis, rider, rideId);
  for (let i = 0; i < 5; i += 1) {
    const d = await makeDriver({ selfieKey: `drivers/kyc/page-${i}/selfie.jpg`, name: `Driver ${i}` });
    await bidState.addBid(redis, rideId, { bidId: randomUUID(), driverId: d.driverId, driverUserId: d.userId, counterOfferNgn: 6000 + i, driverName: `Driver ${i}`, driverRating: 4.9, vehiclePlate: 'LND-1', vehicleModel: 'Corolla', etaSeconds: 200, distanceKm: 1, receivedAt: new Date().toISOString() });
  }
  const off = await pageState(pageDeps(redis), rider);
  assert.equal(off.phase, 'offers');
  assert.equal(off.offers.length, 5);
  assert.equal(JSON.stringify(off).includes('driverPhoto'), false, 'flag off: nothing new in the state');

  const storage = stubStorage(); const cache = memoryRedis();
  const deps = pageDeps(redis, { driverPhoto: resolverWith(storage, cache) });
  const on = await pageState(deps, rider);
  assert.ok(on.offers.every((o) => /^https:\/\//.test(o.driverPhotoUrl) && o.driverPhotoKey));
  for (let i = 0; i < 4; i += 1) await pageState(deps, rider);
  assert.equal(storage.signed.length, 5);
  const strip = (o) => { const { driverPhotoUrl, driverPhotoKey, driverRidesCompleted, ...rest } = o; return rest; };
  assert.deepEqual(on.offers.map(strip), off.offers);
  assert.equal(JSON.stringify(on).includes('selfie.jpg'), false);
});

test('ride page confirmed trip: the driver carries the photo (live trip), null when none; flag off adds nothing', async () => {
  const rider = await makeUser('RIDER', 'Timi Rider');
  const d = await makeDriver({ selfieKey: 'drivers/kyc/t/selfie.jpg' });
  await makeRide(rider, { status: 'DRIVER_EN_ROUTE', driverId: d.driverId, agreedFareNgn: 6000, distanceKm: 11, durationSeconds: 1500 });
  const redis = memoryRedis();
  const off = await pageState(pageDeps(redis), rider);
  assert.equal(off.phase, 'confirmed');
  assert.equal('driverPhotoUrl' in off.driver, false);
  const storage = stubStorage();
  const on = await pageState(pageDeps(redis, { driverPhoto: resolverWith(storage, memoryRedis()) }), rider);
  assert.match(on.driver.driverPhotoUrl, /^https:\/\//);
  assert.match(on.driver.driverPhotoKey, new RegExp(`^${d.driverId}-`));
  assert.deepEqual((({ driverPhotoUrl, driverPhotoKey, driverRidesCompleted, ...rest }) => rest)(on.driver), off.driver);

  const rider2 = await makeUser('RIDER', 'Other Rider');
  const bare = await makeDriver({});
  await makeRide(rider2, { status: 'DRIVER_EN_ROUTE', driverId: bare.driverId, agreedFareNgn: 6000, distanceKm: 11, durationSeconds: 1500 });
  const none = await pageState(pageDeps(redis, { driverPhoto: resolverWith(stubStorage(), memoryRedis()) }), rider2);
  assert.equal(none.driver.driverPhotoUrl, null);
  assert.equal(none.driver.driverPhotoKey, null);
});

test('ride page confirmed from the chat\'s accepted bid (no live trip row yet): the photo is found through the ride\'s driver', async () => {
  const rider = await makeUser('RIDER', 'Timi Rider');
  const d = await makeDriver({ selfieKey: 'drivers/kyc/ab/selfie.jpg' });
  const ride = await makeRide(rider, { status: 'DRIVER_ASSIGNED', driverId: d.driverId, agreedFareNgn: 6000 });
  const redis = memoryRedis();
  await bidState.storeWhatsappRide(redis, ride.id, { riderId: rider, phone: '+2348030000001', paymentMethod: 'WALLET', pickupAddress: YABA.address, destinationAddress: VI.address, pickupLat: YABA.lat, pickupLng: YABA.lng, destinationLat: VI.lat, destinationLng: VI.lng, offerNgn: 6000, suggestedFareNgn: 6000, distanceKm: 11, durationSeconds: 1500, stops: [], createdAt: new Date().toISOString() });
  await bidState.setRideState(redis, ride.id, 'confirmed');
  await bidState.setActiveRide(redis, rider, ride.id);
  await bidState.storeAcceptedBid(redis, ride.id, { driverName: 'Chinedu Okafor', driverPhone: '+2348031234567', driverUserId: d.userId, vehicleModel: 'Corolla', vehiclePlate: 'LND-1', vehicleColor: 'Black', driverRating: 4.9, totalRides: 12, etaSeconds: 200, fareNgn: 6000 });
  const storage = stubStorage();
  const state = await pageState(pageDeps(redis, { driverPhoto: resolverWith(storage, memoryRedis()) }), rider);
  assert.equal(state.phase, 'confirmed');
  assert.match(state.driver.driverPhotoUrl, /^https:\/\//);
});

/* ── the consumer: counter offer + matched ────────────────────────────── */

function consumerWorld(extra = {}) {
  const toApp = []; const redis = memoryRedis();
  return {
    toApp, redis,
    deps: {
      registry: { sendToUser: async (userId, type, payload) => { toApp.push({ userId, type, payload }); }, hasUser: () => true, isUserConnected: async () => true },
      redisClient: redis,
      publisher: { publishRideEvent: async () => {}, publishNotificationEvent: async () => {}, publishWalletEvent: async () => {}, publishDriverEvent: async () => {} },
      ...extra,
    },
  };
}

test('counter offer to the rider (ride:counter_offer): carries the photo when on, exactly as before when off', async () => {
  const rider = await makeUser('RIDER', 'Timi Rider');
  const d = await makeDriver({ selfieKey: 'drivers/kyc/co/selfie.jpg' });
  const ride = await makeRide(rider, { status: 'MATCHING' });
  const row = await prisma.driverBid.create({ data: { rideId: ride.id, driverId: d.driverId, driverUserId: d.userId, riderId: rider, amountNgn: 7000, etaSeconds: 200 } });
  const event = { eventType: 'RIDE_COUNTER_OFFER', rideId: ride.id, bidId: row.id, riderId: rider, driverId: d.driverId, driverUserId: d.userId, counterOfferNgn: 7000, driverName: 'Chinedu Okafor', driverRating: 4.9, vehiclePlate: 'KJA1', vehicleModel: 'Corolla', etaSeconds: 200, timestamp: new Date().toISOString() };
  const off = consumerWorld();
  await handleRideEvent(event, off.deps, new Map());
  const offMsg = off.toApp.find((m) => m.type === 'ride:counter_offer');
  assert.ok(offMsg, 'the rider is told');
  assert.equal('driverPhotoUrl' in offMsg.payload, false);

  const storage = stubStorage();
  const on = consumerWorld({ driverPhoto: resolverWith(storage, memoryRedis()) });
  await handleRideEvent(event, on.deps, new Map());
  const onMsg = on.toApp.find((m) => m.type === 'ride:counter_offer');
  assert.match(onMsg.payload.driverPhotoUrl, /^https:\/\//);
  assert.match(onMsg.payload.driverPhotoKey, new RegExp(`^${d.driverId}-`));
  assert.deepEqual((({ driverPhotoUrl, driverPhotoKey, driverRidesCompleted, ...rest }) => rest)(onMsg.payload), offMsg.payload);
  assert.equal(JSON.stringify(onMsg).includes('selfie.jpg'), false);
});

test('matched (ride:matched) to the rider: carries the photo when on, exactly as before when off', async () => {
  const rider = await makeUser('RIDER', 'Timi Rider');
  const d = await makeDriver({ selfieKey: 'drivers/kyc/mt/selfie.jpg' });
  const ride = await makeRide(rider, { status: 'DRIVER_ASSIGNED', driverId: d.driverId, agreedFareNgn: 6000 });
  const event = { eventType: 'RIDE_DRIVER_ASSIGNED', rideId: ride.id, riderId: rider, driverId: d.driverId, driverUserId: d.userId, driverName: 'Chinedu Okafor', driverRating: 4.9, vehiclePlate: 'KJA1', vehicleModel: 'Corolla', etaSeconds: 300, agreedFareNgn: 6000, lockedFareNgn: 6000, paymentMethod: 'WALLET', offeredDriverUserIds: [], timestamp: new Date().toISOString() };
  const off = consumerWorld();
  await handleRideEvent(event, off.deps, new Map());
  const offMsg = off.toApp.find((m) => m.userId === rider && m.type === 'ride:matched');
  assert.ok(offMsg, 'the rider gets ride:matched');
  assert.equal('driverPhotoUrl' in offMsg.payload, false);

  const storage = stubStorage();
  const on = consumerWorld({ driverPhoto: resolverWith(storage, memoryRedis()) });
  await handleRideEvent(event, on.deps, new Map());
  const onMsg = on.toApp.find((m) => m.userId === rider && m.type === 'ride:matched');
  assert.match(onMsg.payload.driverPhotoUrl, /^https:\/\//);
  assert.match(onMsg.payload.driverPhotoKey, new RegExp(`^${d.driverId}-`));
  // The driver's own copy of ride:matched is untouched.
  assert.equal(on.toApp.filter((m) => m.userId === d.userId).every((m) => !('driverPhotoUrl' in m.payload)), true);
});

test('an offer that changed before the tap (offer_changed) re-sends the offer with the photo when on, none when off', async () => {
  const { acceptOfferInApp } = require('../apps/api-gateway/dist/rides/app-accept.js');
  const rider = await makeUser('RIDER', 'Timi Rider');
  const d = await makeDriver({ selfieKey: 'drivers/kyc/oc/selfie.jpg' });
  const ride = await makeRide(rider, { status: 'MATCHING' });
  const row = await prisma.driverBid.create({ data: { rideId: ride.id, driverId: d.driverId, driverUserId: d.userId, riderId: rider, amountNgn: 9000, etaSeconds: 200 } });
  const input = { rideId: ride.id, driverId: d.driverId, driverUserId: d.userId, bidId: row.id, paymentMethod: 'WALLET', agreedFareNgn: 7000 };
  const deps = { publisher: { publishRideEvent: async () => {} }, redis: memoryRedis() };
  try {
    photo.setDriverPhotoResolver(undefined);
    const off = await acceptOfferInApp(deps, rider, input);
    assert.equal(off.payload.reason, 'offer_changed');
    assert.equal('driverPhotoUrl' in off.payload.counterOffer, false);
    photo.setDriverPhotoResolver(resolverWith(stubStorage(), memoryRedis()));
    const on = await acceptOfferInApp({ ...deps, redis: memoryRedis() }, rider, input);
    assert.match(on.payload.counterOffer.driverPhotoUrl, /^https:\/\//);
    assert.match(on.payload.counterOffer.driverPhotoKey, new RegExp(`^${d.driverId}-`));
    assert.deepEqual((({ driverPhotoUrl, driverPhotoKey, driverRidesCompleted, ...rest }) => rest)(on.payload.counterOffer), off.payload.counterOffer);
  } finally { photo.setDriverPhotoResolver(undefined); }
});

test('a replacement driver on the same ride shows their own photo at once (accepted-bid branch), not the old face', async () => {
  const rider = await makeUser('RIDER', 'Timi Rider');
  const a = await makeDriver({ selfieKey: 'drivers/kyc/aa/selfie.jpg' });
  const b = await makeDriver({ selfieKey: 'drivers/kyc/bb/selfie.jpg' });
  const ride = await makeRide(rider, { status: 'DRIVER_ASSIGNED', driverId: a.driverId, agreedFareNgn: 6000 });
  const redis = memoryRedis();
  await bidState.storeWhatsappRide(redis, ride.id, { riderId: rider, phone: '+2348030000001', paymentMethod: 'WALLET', pickupAddress: YABA.address, destinationAddress: VI.address, pickupLat: YABA.lat, pickupLng: YABA.lng, destinationLat: VI.lat, destinationLng: VI.lng, offerNgn: 6000, suggestedFareNgn: 6000, distanceKm: 11, durationSeconds: 1500, stops: [], createdAt: new Date().toISOString() });
  await bidState.setRideState(redis, ride.id, 'confirmed');
  await bidState.setActiveRide(redis, rider, ride.id);
  const accept = (d) => bidState.storeAcceptedBid(redis, ride.id, { driverName: 'X', driverPhone: '+2348031234567', driverUserId: d.userId, vehicleModel: 'Corolla', vehiclePlate: 'LND-1', vehicleColor: 'Black', driverRating: 4.9, totalRides: 12, etaSeconds: 200, fareNgn: 6000 });
  const deps = pageDeps(redis, { driverPhoto: resolverWith(stubStorage(), memoryRedis()) });
  await accept(a);
  const first = await pageState(deps, rider);
  assert.match(first.driver.driverPhotoKey, new RegExp(`^${a.driverId}-`));
  await prisma.ride.update({ where: { id: ride.id }, data: { driverId: b.driverId } });
  await accept(b);
  const second = await pageState(deps, rider);
  assert.match(second.driver.driverPhotoKey, new RegExp(`^${b.driverId}-`));
});

/* ── rating + rides completed, the cache, the face budget, CSP, MCP ───── */

async function finishRides(driverId, riderId, n) {
  for (let i = 0; i < n; i += 1) await makeRide(riderId, { status: 'COMPLETED', driverId, agreedFareNgn: 5000 });
}

test('rating and rides completed ride with the photo on every rider payload; flag off adds neither the count nor any photo field', async () => {
  const { acceptOfferInApp } = require('../apps/api-gateway/dist/rides/app-accept.js');
  const rider = await makeUser('RIDER', 'Timi Rider');
  const token = local.createLocalAccessToken(rider, JWT_SECRET, 3600);
  const d = await makeDriver({ selfieKey: 'drivers/kyc/rr/selfie.jpg' });
  await prisma.driver.update({ where: { id: d.driverId }, data: { rating: 4.7 } });
  await finishRides(d.driverId, rider, 3);
  await makeRide(rider, { status: 'CANCELLED', driverId: d.driverId });
  const resolver = () => resolverWith(stubStorage(), memoryRedis());
  const hasCount = (o) => o.driverRidesCompleted === 3;

  // ws counter offer + matched
  const search = await makeRide(rider, { status: 'MATCHING' });
  const row = await prisma.driverBid.create({ data: { rideId: search.id, driverId: d.driverId, driverUserId: d.userId, riderId: rider, amountNgn: 9000, etaSeconds: 200 } });
  const co = { eventType: 'RIDE_COUNTER_OFFER', rideId: search.id, bidId: row.id, riderId: rider, driverId: d.driverId, driverUserId: d.userId, counterOfferNgn: 9000, driverName: 'C', driverRating: 4.7, vehiclePlate: 'K', vehicleModel: 'C', etaSeconds: 200, timestamp: new Date().toISOString() };
  const on = consumerWorld({ driverPhoto: resolver() }); await handleRideEvent(co, on.deps, new Map());
  const m = on.toApp.find((x) => x.type === 'ride:counter_offer').payload;
  assert.ok(hasCount(m) && m.driverRating === 4.7);
  const off = consumerWorld(); await handleRideEvent(co, off.deps, new Map());
  assert.equal('driverRidesCompleted' in off.toApp.find((x) => x.type === 'ride:counter_offer').payload, false);

  // /rides/active offers
  const act = await activeRide({ jwtSecret: JWT_SECRET, redisClient: memoryRedis(), driverPhoto: resolver() }, token);
  assert.ok(act.search.offers.every((o) => hasCount(o) && o.driverRating === 4.7));
  const actOff = await activeRide({ jwtSecret: JWT_SECRET }, token);
  assert.equal(JSON.stringify(actOff).includes('driverRidesCompleted'), false);

  // ride page offers (existing names: rating)
  const redis = memoryRedis(); const rideId = randomUUID();
  await bidState.storeWhatsappRide(redis, rideId, { riderId: rider, phone: '+2348030000001', paymentMethod: 'WALLET', pickupAddress: YABA.address, destinationAddress: VI.address, pickupLat: YABA.lat, pickupLng: YABA.lng, destinationLat: VI.lat, destinationLng: VI.lng, offerNgn: 6000, suggestedFareNgn: 6000, distanceKm: 11, durationSeconds: 1500, stops: [], createdAt: new Date().toISOString() });
  await bidState.setRideState(redis, rideId, 'bidding'); await bidState.setActiveRide(redis, rider, rideId);
  await bidState.addBid(redis, rideId, { bidId: randomUUID(), driverId: d.driverId, driverUserId: d.userId, counterOfferNgn: 6000, driverName: 'C', driverRating: 4.7, vehiclePlate: 'L', vehicleModel: 'C', etaSeconds: 200, distanceKm: 1, receivedAt: new Date().toISOString() });
  const page = await pageState(pageDeps(redis, { driverPhoto: resolver() }), rider);
  assert.ok(page.offers.every((o) => hasCount(o) && o.rating === 4.7));
  assert.equal(JSON.stringify(await pageState(pageDeps(redis), rider)).includes('driverRidesCompleted'), false);

  // offer_changed counterOffer
  const input = { rideId: search.id, driverId: d.driverId, driverUserId: d.userId, bidId: row.id, paymentMethod: 'WALLET', agreedFareNgn: 7000 };
  try {
    photo.setDriverPhotoResolver(resolver());
    const changed = await acceptOfferInApp({ publisher: { publishRideEvent: async () => {} }, redis: memoryRedis() }, rider, input);
    assert.ok(hasCount(changed.payload.counterOffer) && changed.payload.counterOffer.driverRating === 4.7);
  } finally { photo.setDriverPhotoResolver(undefined); }
});

test('rides completed and the confirmed driver: matched and the booked trip carry the count; /rides/active driver too', async () => {
  const rider = await makeUser('RIDER', 'Timi Rider');
  const token = local.createLocalAccessToken(rider, JWT_SECRET, 3600);
  const d = await makeDriver({ selfieKey: 'drivers/kyc/bk/selfie.jpg' });
  await finishRides(d.driverId, rider, 2);
  await makeRide(rider, { status: 'DRIVER_EN_ROUTE', driverId: d.driverId, agreedFareNgn: 6000, distanceKm: 11, durationSeconds: 1500 });
  const resolver = resolverWith(stubStorage(), memoryRedis());
  assert.equal((await activeRide({ jwtSecret: JWT_SECRET, redisClient: memoryRedis(), driverPhoto: resolver }, token)).driver.driverRidesCompleted, 2);
  assert.equal((await pageState(pageDeps(memoryRedis(), { driverPhoto: resolver }), rider)).driver.driverRidesCompleted, 2);
  const ride = (await prisma.ride.findFirst({ where: { riderId: rider, status: 'DRIVER_EN_ROUTE' } }));
  const event = { eventType: 'RIDE_DRIVER_ASSIGNED', rideId: ride.id, riderId: rider, driverId: d.driverId, driverUserId: d.userId, driverName: 'C', driverRating: 4.9, vehiclePlate: 'K', vehicleModel: 'C', etaSeconds: 300, agreedFareNgn: 6000, lockedFareNgn: 6000, paymentMethod: 'WALLET', offeredDriverUserIds: [], timestamp: new Date().toISOString() };
  const w = consumerWorld({ driverPhoto: resolver }); await handleRideEvent(event, w.deps, new Map());
  assert.equal(w.toApp.find((m) => m.userId === rider && m.type === 'ride:matched').payload.driverRidesCompleted, 2);
});

test('the completed-ride count is cached in Redis for 10 minutes: polls do not COUNT again', async () => {
  let counts = 0; const redis = memoryRedis();
  const make = () => photo.createDriverPhotoResolver({ storage: stubStorage(), redis, loadSources: async () => null, countRides: async () => { counts += 1; return 7; } });
  const a = make();
  for (let i = 0; i < 5; i += 1) assert.equal(await a.ridesCompleted('d-9'), 7);
  assert.equal(await make().ridesCompleted('d-9'), 7);
  assert.equal(counts, 1);
  assert.equal(redis.ttls.get('driver:d-9:rides-completed'), 600);
  const down = photo.createDriverPhotoResolver({ storage: stubStorage(), redis: memoryRedis(), countRides: async () => { throw new Error('db'); } });
  assert.equal(await down.ridesCompleted('d-x'), null);
});

test('face budget: 25 different drivers a Lagos day on offers; the 26th gets no photo (rating and rides stay), a repeat still does, the booked driver always does', async () => {
  const redis = memoryRedis(); const storage = stubStorage();
  const resolver = photo.createDriverPhotoResolver({ storage, redis, loadSources: async () => ({ kycSubmission: { selfieKey: 'drivers/kyc/z/s.jpg' } }), countRides: async () => 4 });
  const warns = [];
  console.warn = (...a) => warns.push(a);
  for (let i = 1; i <= 25; i += 1) assert.ok((await photo.driverPhotoFields(resolver, `d-${i}`, { riderId: 'r-1' })).driverPhotoUrl, `driver ${i}`);
  const over = await photo.driverPhotoFields(resolver, 'd-26', { riderId: 'r-1' });
  assert.deepEqual([over.driverPhotoUrl, over.driverPhotoKey, over.driverRidesCompleted], [null, null, 4]);
  await photo.driverPhotoFields(resolver, 'd-27', { riderId: 'r-1' });
  assert.equal(warns.filter((w) => /face budget/.test(String(w[0]))).length, 1, 'the rider is logged once');
  assert.ok((await photo.driverPhotoFields(resolver, 'd-3', { riderId: 'r-1' })).driverPhotoUrl, 'a repeat driver still has a face');
  assert.ok((await photo.driverPhotoFields(resolver, 'd-26')).driverPhotoUrl, 'the booked driver always has a face');
  assert.ok((await photo.driverPhotoFields(resolver, 'd-26', { riderId: 'r-2' })).driverPhotoUrl, 'another rider has their own budget');
  const key = [...redis.sets.keys()].find((k) => k.startsWith('rider:r-1:faces:'));
  assert.match(key, /^rider:r-1:faces:\d{4}-\d{2}-\d{2}$/);
  assert.equal(redis.sets.get(key).size, 25);
  assert.equal(redis.ttls.get(key), 36 * 3600);
});

test('face budget through the real counter-offer entry point', async () => {
  const rider = await makeUser('RIDER', 'Timi Rider');
  const d = await makeDriver({ selfieKey: 'drivers/kyc/fb/selfie.jpg' });
  const ride = await makeRide(rider, { status: 'MATCHING' });
  const row = await prisma.driverBid.create({ data: { rideId: ride.id, driverId: d.driverId, driverUserId: d.userId, riderId: rider, amountNgn: 7000, etaSeconds: 200 } });
  const event = { eventType: 'RIDE_COUNTER_OFFER', rideId: ride.id, bidId: row.id, riderId: rider, driverId: d.driverId, driverUserId: d.userId, counterOfferNgn: 7000, driverName: 'C', driverRating: 4.9, vehiclePlate: 'K', vehicleModel: 'C', etaSeconds: 200, timestamp: new Date().toISOString() };
  const cache = memoryRedis();
  for (let i = 0; i < 25; i += 1) await cache.send('SADD', photo.facesKey(rider), `other-${i}`);
  const w = consumerWorld({ driverPhoto: photo.createDriverPhotoResolver({ storage: stubStorage(), redis: cache }) });
  await handleRideEvent(event, w.deps, new Map());
  const p = w.toApp.find((m) => m.type === 'ride:counter_offer').payload;
  assert.deepEqual([p.driverPhotoUrl, p.driverPhotoKey, p.driverRating, p.driverRidesCompleted], [null, null, 4.9, 0]);
});

test('ride page CSP lets the signed R2 host load images and nothing wider', () => {
  const { ridePageCsp, r2PhotoHost } = require('../apps/api-gateway/dist/http/ride-page-csp.js');
  const csp = ridePageCsp('abc123');
  const img = csp.split(';').map((x) => x.trim()).find((x) => x.startsWith('img-src'));
  assert.ok(img.split(' ').includes('https://abc123.r2.cloudflarestorage.com'));
  assert.equal(/\*\.r2\.|https:\/\/\*\s|\shttps:(\s|$)/.test(img), false, 'no wildcard host');
  assert.equal(ridePageCsp(undefined).includes('r2.cloudflarestorage'), false);
  assert.equal(r2PhotoHost('a b; evil'), null);
});

test('the ride page finds the ACCEPTED driver (by their user), not whoever ride.driverId says', async () => {
  const rider = await makeUser('RIDER', 'Timi Rider');
  const a = await makeDriver({ selfieKey: 'drivers/kyc/old/selfie.jpg' });
  const b = await makeDriver({ selfieKey: 'drivers/kyc/new/selfie.jpg' });
  const ride = await makeRide(rider, { status: 'MATCHING', driverId: a.driverId, agreedFareNgn: 6000 });
  const redis = memoryRedis();
  await bidState.storeWhatsappRide(redis, ride.id, { riderId: rider, phone: '+2348030000001', paymentMethod: 'WALLET', pickupAddress: YABA.address, destinationAddress: VI.address, pickupLat: YABA.lat, pickupLng: YABA.lng, destinationLat: VI.lat, destinationLng: VI.lng, offerNgn: 6000, suggestedFareNgn: 6000, distanceKm: 11, durationSeconds: 1500, stops: [], createdAt: new Date().toISOString() });
  await bidState.setRideState(redis, ride.id, 'confirmed'); await bidState.setActiveRide(redis, rider, ride.id);
  await bidState.storeAcceptedBid(redis, ride.id, { driverName: 'B', driverPhone: '+2348031234567', driverUserId: b.userId, vehicleModel: 'C', vehiclePlate: 'L', vehicleColor: 'Black', driverRating: 4.9, totalRides: 1, etaSeconds: 200, fareNgn: 6000 });
  // ride.driverId still says A (the database has not caught up); the accepted bid names B.
  const state = await pageState(pageDeps(redis, { driverPhoto: resolverWith(stubStorage(), memoryRedis()) }), rider);
  assert.match(state.driver.driverPhotoKey, new RegExp(`^${b.driverId}-`));
});

test('MCP strips the photo link and key from the events it keeps', () => {
  const { stripHeavy } = require('../apps/mcp-server/dist/gateway/ride-session.js');
  const out = stripHeavy({ rideId: 'r', route: [1, 2], driverName: 'X', driverPhotoUrl: 'https://r2.test/s', driverPhotoKey: 'd-abc', driverRidesCompleted: 3 });
  assert.deepEqual(out, { rideId: 'r', driverName: 'X', driverRidesCompleted: 3 });
});
