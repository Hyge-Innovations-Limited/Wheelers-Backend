// Rider safety (Timi, 14 Nov 2026): 30 safety tips, three at a time (before,
// during, after a trip); "This trip is recorded for your safety", said once
// and only when the driver's phone really records; and on each offer, what was
// checked about the driver (only checks that passed and are in date).
// Against the local Postgres; WhatsApp is captured, not sent.
//
//   node scripts/run-with-env.cjs node --test --test-force-exit test/rider-safety.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { prisma } = require('@wheleers/db');
const { SAFETY_TIPS, safetyTipsFor, TRIP_RECORDED_LINE } = require('@wheleers/config');
const { handleRideEvent, sayTripRecorded } = require('../apps/api-gateway/dist/kafka/consumer.js');
const { driverCheckBadges, driverChecksFor, clearDriverChecksCache } = require('../apps/api-gateway/dist/drivers/driver-checks.js');
const { justFinishedFor, safetyView } = require('../apps/api-gateway/dist/rides/safety.js');
const { markRidePageSeen } = require('../apps/api-gateway/dist/whatsapp-flows/bid-state.js');

const made = { users: [], rides: [], drivers: [] };
test.beforeEach(() => { console.log = console.info = console.warn = () => {}; });

function memoryRedis() {
  const store = new Map();
  return {
    store,
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async set(k, v) { store.set(k, v); },
    async del(k) { store.delete(k); },
    async setIfNotExists(k, v) { if (store.has(k)) return false; store.set(k, v); return true; },
    async send() { return null; },
  };
}
function metaCapture() {
  const sent = [];
  const realFetch = global.fetch;
  global.fetch = async (_url, init) => { sent.push(JSON.parse(init.body)); return { ok: true, status: 200, text: async () => '', json: async () => ({ messages: [{ id: 'wamid.X' }] }) }; };
  return { sent, texts: () => sent.map((m) => m.text?.body ?? m.interactive?.body?.text ?? JSON.stringify(m)), restore: () => { global.fetch = realFetch; } };
}
async function person(role, extra = {}) {
  const id = randomUUID();
  const phone = `+234803${Math.floor(1000000 + Math.random() * 8999999)}`;
  await prisma.user.create({ data: { id, privyDid: `test:safety:${id}`, role, name: role === 'DRIVER' ? 'Tunde Adebayo' : 'Safety Rider', phone, ...extra } });
  made.users.push(id);
  return { id, phone };
}
async function driverRow(extra = {}) {
  const u = await person('DRIVER');
  const d = await prisma.driver.create({ data: { userId: u.id, kycStatus: 'APPROVED', status: 'ON_RIDE', vehicleModel: 'Camry', vehiclePlate: 'LAG234KJ', ...extra } });
  made.drivers.push(d.id);
  return { ...d, userId: u.id };
}
async function rideFor(riderId, driverId, extra = {}) {
  const r = await prisma.ride.create({ data: { riderId, driverId, channel: 'WHATSAPP', status: 'IN_PROGRESS', pickupLat: 6.52, pickupLng: 3.38, pickupAddress: 'Yaba', destLat: 6.6, destLng: 3.35, destAddress: 'Ikeja', riderOfferNgn: 4500, fareEstimateNgn: 4500, ...extra } });
  made.rides.push(r.id);
  return r;
}
const started = (ride) => ({ eventType: 'RIDE_STARTED', rideId: ride.id, riderId: ride.riderId, driverId: ride.driverId, startedAt: new Date().toISOString(), timestamp: new Date().toISOString() });
function depsFor(redis, sockets = []) {
  return { registry: { sendToUser: async (user, event, payload) => { sockets.push({ user, event, payload }); }, isUserConnected: async () => false, hasUser: () => false }, redisClient: redis, publisher: {}, whatsappNotifier: { metaAccessToken: 't', metaPhoneNumberId: '1' } };
}

test.after(async () => {
  await prisma.ride.deleteMany({ where: { id: { in: made.rides } } }).catch(() => {});
  await prisma.driverCheck.deleteMany({ where: { driverId: { in: made.drivers } } }).catch(() => {});
  await prisma.driverDocument.deleteMany({ where: { driverId: { in: made.drivers } } }).catch(() => {});
  await prisma.driverKycSubmission.deleteMany({ where: { driverId: { in: made.drivers } } }).catch(() => {});
  await prisma.driver.deleteMany({ where: { id: { in: made.drivers } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: made.users } } }).catch(() => {});
  await prisma.$disconnect();
});

test('30 tips, ten for each moment; three different ones per trip, the same three every time; before starts with the plate', () => {
  assert.deepEqual(Object.values(SAFETY_TIPS).map((l) => l.length), [10, 10, 10]);
  assert.equal(new Set(Object.values(SAFETY_TIPS).flat()).size, 30, 'no tip twice');
  for (const tip of Object.values(SAFETY_TIPS).flat()) assert.ok(tip.length <= 70, `short: ${tip}`);
  for (let i = 0; i < 300; i += 1) {
    for (const moment of ['before', 'during', 'after']) {
      const tips = safetyTipsFor(`ride-${i}`, moment);
      assert.equal(new Set(tips).size, 3);
      assert.deepEqual(safetyTipsFor(`ride-${i}`, moment), tips, 'the same trip, the same tips');
    }
  }
  assert.equal(safetyTipsFor('r1', 'before', ' lag 234 kj ')[0], 'Check the plate is LAG 234 KJ.');
  assert.equal(safetyTipsFor('r1', 'before')[0], 'Check the plate matches before you get in.');
  const many = new Set(Array.from({ length: 50 }, (_, i) => safetyTipsFor(`t${i}`, 'during').join('|')));
  assert.ok(many.size > 10, 'different trips get different tips');
});

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 14, 12);
const at = (daysAgo) => new Date(NOW - daysAgo * DAY);
const facts = (over = {}) => ({
  kycStatus: 'APPROVED',
  licenceExpiresOn: new Date(NOW + 300 * DAY),
  kycSubmission: { ninImageKey: 'k/nin.jpg', status: 'APPROVED', reviewedAt: at(20), submittedAt: at(22) },
  checks: [
    { kind: 'plate', paperType: null, outcome: 'verified', createdAt: at(5) },
    { kind: 'insurance', paperType: null, outcome: 'verified', createdAt: at(6) },
    { kind: 'licenceFace', paperType: null, outcome: 'verified', createdAt: at(7) },
    { kind: 'licence', paperType: null, outcome: 'verified', createdAt: at(8) },
  ],
  documents: [{ status: 'APPROVED', expiresOn: new Date(NOW + 100 * DAY), reviewedAt: at(9) }],
  ...over,
});
const kinds = (f) => driverCheckBadges(f, NOW).map((b) => b.kind);

test('checks: every one that passed and is in date, in one order, with when; insurance with its end date', () => {
  const badges = driverCheckBadges(facts(), NOW);
  assert.deepEqual(badges.map((b) => b.kind), ['nin', 'licence', 'face', 'insurance', 'plate']);
  assert.equal(badges[0].at, at(20).toISOString(), 'NIN: when the team approved the KYC');
  assert.equal(badges.find((b) => b.kind === 'insurance').until, new Date(NOW + 100 * DAY).toISOString());
  assert.deepEqual(driverCheckBadges(null, NOW), []);
});

test('checks: a failed or expired check is not shown (and a later failure hides an earlier pass)', () => {
  assert.deepEqual(kinds(facts({ licenceExpiresOn: at(1) })).includes('licence'), false, 'licence ran out');
  const failedAfterPass = facts({ checks: [{ kind: 'licence', paperType: null, outcome: 'mismatch', createdAt: at(1) }, ...facts().checks] });
  assert.equal(kinds(failedAfterPass).includes('licence'), false, 'the latest licence check failed');
  assert.equal(kinds(facts({ documents: [{ status: 'APPROVED', expiresOn: at(2), reviewedAt: at(9) }] })).includes('insurance'), false, 'insurance ran out');
  const insuranceFailed = facts({ checks: [{ kind: 'insurance', paperType: null, outcome: 'not_found', createdAt: at(1) }, ...facts().checks.filter((c) => c.kind !== 'insurance')] });
  assert.equal(kinds(insuranceFailed).includes('insurance'), false, 'a failed insurance check wins over an approved paper');
  assert.equal(kinds(facts({ kycSubmission: { ninImageKey: null, status: 'APPROVED', reviewedAt: at(1), submittedAt: at(2) } })).includes('nin'), false, 'no NIN on the KYC');
  assert.equal(kinds(facts({ kycStatus: 'SUBMITTED' })).includes('nin'), false, 'KYC not approved');
  assert.equal(kinds(facts({ kycSubmission: { ninImageKey: 'k/nin.jpg', status: 'SUBMITTED', reviewedAt: null, submittedAt: at(30) } })).includes('nin'), true, 'approved some other way (the driver is approved, the KYC row was not moved): NIN still shows');
  assert.equal(kinds(facts({ checks: facts().checks.map((c) => (c.kind === 'plate' ? { ...c, outcome: 'error' } : c)) })).includes('plate'), false, 'a plate check that errored');
  assert.equal(kinds(facts({ checks: facts().checks.map((c) => (c.kind === 'licenceFace' ? { ...c, outcome: 'mismatch' } : c)) })).includes('face'), false);
});

test('checks: an approved insurance paper counts with no check; a hand check of the paper counts as its check', () => {
  const paperOnly = facts({ checks: facts().checks.filter((c) => c.kind !== 'insurance') });
  assert.ok(kinds(paperOnly).includes('insurance'));
  const byHand = facts({ documents: [], checks: [{ kind: 'manual', paperType: 'insurance', outcome: 'verified', createdAt: at(3) }, ...facts().checks.filter((c) => c.kind !== 'insurance')] });
  assert.ok(kinds(byHand).includes('insurance'));
});

test('checks from the database, cached per driver; an unknown driver has none', async () => {
  clearDriverChecksCache();
  const d = await driverRow({ licenceExpiresOn: new Date(Date.now() + 200 * DAY) });
  await prisma.driverCheck.create({ data: { driverId: d.id, kind: 'licence', source: 'prembly', outcome: 'verified', byName: 'Test' } });
  await prisma.driverCheck.create({ data: { driverId: d.id, kind: 'plate', source: 'autoreg', outcome: 'mismatch', byName: 'Test' } });
  assert.deepEqual((await driverChecksFor(d.id)).map((b) => b.kind), ['licence'], 'the failed plate check is not shown');
  assert.deepEqual(await driverChecksFor(randomUUID()), []);
  assert.deepEqual(await driverChecksFor(null), []);
});

test('WhatsApp, off the ride page: "Trip started" once, with the three tips; recorded only when it is', async () => {
  const r = await person('RIDER');
  const d = await driverRow();
  const ride = await rideFor(r.id, d.id);
  const redis = memoryRedis();
  await redis.set(`whatsapp:user:${r.id}:phone`, r.phone);
  const meta = metaCapture();
  try {
    await handleRideEvent(started(ride), depsFor(redis), new Map());
    await handleRideEvent(started(ride), depsFor(redis), new Map());
  } finally { meta.restore(); }
  const texts = meta.texts();
  assert.equal(texts.length, 1, 'once, even when delivered again');
  assert.match(texts[0], /\*Trip started\*/);
  assert.doesNotMatch(texts[0], /recorded/, 'not recorded: not said');
  for (const tip of safetyTipsFor(ride.id, 'during')) assert.ok(texts[0].includes(tip), tip);
  assert.match(texts[0], /\*Stay safe\*\n1\. /);
});

test('recorded before the message: the line is in "Trip started", and not said again', async () => {
  const r = await person('RIDER');
  const d = await driverRow();
  const ride = await rideFor(r.id, d.id, { recordingStartedAt: new Date() });
  const redis = memoryRedis();
  await redis.set(`whatsapp:user:${r.id}:phone`, r.phone);
  const meta = metaCapture();
  try {
    await handleRideEvent(started(ride), depsFor(redis), new Map());
    await sayTripRecorded(depsFor(redis), ride.id);
  } finally { meta.restore(); }
  const texts = meta.texts();
  assert.equal(texts.length, 1);
  assert.ok(texts[0].includes(`🎙 ${TRIP_RECORDED_LINE}`));
});

test('recorded after the message: one line on its own; never twice; nothing for a trip that is not recorded or not running', async () => {
  const r = await person('RIDER');
  const d = await driverRow();
  const ride = await rideFor(r.id, d.id);
  const redis = memoryRedis();
  await redis.set(`whatsapp:user:${r.id}:phone`, r.phone);
  const meta = metaCapture();
  try {
    await handleRideEvent(started(ride), depsFor(redis), new Map());
    await sayTripRecorded(depsFor(redis), ride.id);
    assert.equal(meta.sent.length, 1, 'not recorded yet: nothing more');
    await prisma.ride.update({ where: { id: ride.id }, data: { recordingStartedAt: new Date() } });
    await sayTripRecorded(depsFor(redis), ride.id);
    await sayTripRecorded(depsFor(redis), ride.id);
    const done = await rideFor(r.id, d.id, { status: 'COMPLETED', recordingStartedAt: new Date() });
    await sayTripRecorded(depsFor(redis), done.id);
  } finally { meta.restore(); }
  const texts = meta.texts();
  assert.equal(texts.length, 2);
  assert.equal(texts[1], `🎙 ${TRIP_RECORDED_LINE}`);
});

test('recorded before "Trip started" was sent: the line waits for that message (not said first, on its own)', async () => {
  const r = await person('RIDER');
  const d = await driverRow();
  const ride = await rideFor(r.id, d.id, { recordingStartedAt: new Date() });
  const redis = memoryRedis();
  await redis.set(`whatsapp:user:${r.id}:phone`, r.phone);
  const meta = metaCapture();
  try {
    await sayTripRecorded(depsFor(redis), ride.id);
    assert.equal(meta.sent.length, 0, 'the phone was quicker than the event: nothing yet');
    await handleRideEvent(started(ride), depsFor(redis), new Map());
  } finally { meta.restore(); }
  assert.equal(meta.sent.length, 1);
  assert.ok(meta.texts()[0].includes(TRIP_RECORDED_LINE), 'said inside "Trip started"');
});

test('on the ride page: nothing in the chat (the page shows it)', async () => {
  const r = await person('RIDER');
  const d = await driverRow();
  const ride = await rideFor(r.id, d.id, { recordingStartedAt: new Date() });
  const redis = memoryRedis();
  await redis.set(`whatsapp:user:${r.id}:phone`, r.phone);
  await markRidePageSeen(redis, r.id);
  const meta = metaCapture();
  try {
    await handleRideEvent(started(ride), depsFor(redis), new Map());
    await sayTripRecorded(depsFor(redis), ride.id);
  } finally { meta.restore(); }
  assert.equal(meta.sent.length, 0);
  const view = safetyView(await prisma.ride.findUnique({ where: { id: ride.id } }), 'LAG234KJ');
  assert.equal(view.recorded, true, 'the page reads it from the trip');
  assert.equal(view.safety.before[0], 'Check the plate is LAG234KJ.');
});

test('app riders: ride:started says whether it is recorded; ride:recorded once when it starts later', async () => {
  const r = await person('RIDER');
  const d = await driverRow();
  const ride = await rideFor(r.id, d.id, { channel: 'APP' });
  const redis = memoryRedis();
  const sockets = [];
  await handleRideEvent(started(ride), depsFor(redis, sockets), new Map());
  assert.equal(sockets.find((s) => s.event === 'ride:started' && s.user === r.id).payload.recorded, false);
  await prisma.ride.update({ where: { id: ride.id }, data: { recordingStartedAt: new Date() } });
  await sayTripRecorded(depsFor(redis, sockets), ride.id);
  await sayTripRecorded(depsFor(redis, sockets), ride.id);
  assert.equal(sockets.filter((s) => s.event === 'ride:recorded').length, 1);
});

test('a trip that just completed gives its "after" tips for 15 minutes; a cancelled one does not', async () => {
  const r = await person('RIDER');
  const d = await driverRow();
  const now = Date.now();
  await rideFor(r.id, d.id, { status: 'CANCELLED', cancelledAt: new Date(now - 60_000) });
  assert.equal(await justFinishedFor(r.id, now), null);
  const done = await rideFor(r.id, d.id, { status: 'COMPLETED', completedAt: new Date(now - 5 * 60_000) });
  const got = await justFinishedFor(r.id, now);
  assert.equal(got.rideId, done.id);
  assert.deepEqual(got.tips, safetyTipsFor(done.id, 'after'));
  assert.equal(await justFinishedFor(r.id, now + 16 * 60_000), null, 'after 15 minutes, gone');
});
