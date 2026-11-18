// The Analytics Studio's real data (Timi, 18 Nov 2026): the capture beside the ride flow (who a search went to and
// what they did, every price change with what was on the table, free drivers at the start) and the dataset built from
// real rows in the Studio page's shape. Real Postgres.
//
//   npm -w @wheleers/db run build && npm -w @wheleers/api-gateway run build
//   node scripts/run-with-env.cjs node --test --test-force-exit test/studio-dataset.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const { studioCaptureClient } = require('../packages/db/dist/index.js');
const { buildStudioDataset, studioDatasetWorkbook } = require('../apps/api-gateway/dist/analytics/studio-dataset.js');

const prisma = new PrismaClient();
const made = { users: [], rides: [], drivers: [] };
test.beforeEach(() => { console.warn = () => {}; });
test.after(async () => {
  await prisma.searchPing.deleteMany({ where: { rideId: { in: made.rides } } });
  await prisma.ridePriceChange.deleteMany({ where: { rideId: { in: made.rides } } });
  await prisma.feedback.deleteMany({ where: { rideId: { in: made.rides } } });
  await prisma.driverBid.deleteMany({ where: { rideId: { in: made.rides } } });
  await prisma.ride.deleteMany({ where: { id: { in: made.rides } } });
  await prisma.driver.deleteMany({ where: { id: { in: made.drivers } } });
  await prisma.user.deleteMany({ where: { id: { in: made.users } } });
  await prisma.$disconnect();
});

async function user(role) {
  const id = randomUUID();
  await prisma.user.create({ data: { id, privyDid: `test:studio:${id}`, role, name: 'Studio Test' } });
  made.users.push(id);
  return id;
}
async function driver(rating = 4.7) {
  const userId = await user('DRIVER');
  const d = await prisma.driver.create({ data: { userId, kycStatus: 'APPROVED', status: 'ONLINE', rating } });
  made.drivers.push(d.id);
  return d;
}
const T0 = new Date('2026-11-10T08:00:00.000Z'); // 09:00 Lagos, a Tuesday
const at = (sec) => new Date(T0.getTime() + sec * 1000);

test('capture: pings once per driver per round, the answer on the latest round, drivers found written once, price change with the table', async () => {
  const riderId = await user('RIDER');
  const [a, b] = [await driver(), await driver()];
  const ride = await prisma.ride.create({ data: { riderId, status: 'MATCHING', pickupLat: 6.51, pickupLng: 3.37, pickupAddress: 'Yaba', destLat: 6.45, destLng: 3.4, destAddress: 'Island', riderOfferNgn: 3000, firstRiderOfferNgn: 3000 } });
  made.rides.push(ride.id);

  await studioCaptureClient.notePings(ride.id, [a.id, b.id, a.id], 1);
  await studioCaptureClient.notePings(ride.id, [a.id], 1); // a redelivery: nothing new
  assert.equal(await prisma.searchPing.count({ where: { rideId: ride.id } }), 2);
  assert.equal(await studioCaptureClient.lastRound(ride.id), 1);

  await studioCaptureClient.noteDriversFound(ride.id, 7);
  await studioCaptureClient.noteDriversFound(ride.id, 2);
  assert.equal((await prisma.ride.findUnique({ where: { id: ride.id } })).driversFoundAtSearch, 7, 'the first count stays');

  await prisma.driverBid.create({ data: { rideId: ride.id, driverId: b.id, driverUserId: b.userId, riderId, amountNgn: 3500, etaSeconds: 300, status: 'PENDING' } });
  await studioCaptureClient.notePriceChange(ride.id, 3000, 3500);
  await studioCaptureClient.notePriceChange(ride.id, 3500, 3500); // no change: nothing
  const changes = await prisma.ridePriceChange.findMany({ where: { rideId: ride.id } });
  assert.deepEqual(changes.map((c) => [c.fromNgn, c.toNgn, c.offersOpen, c.lowestOfferNgn]), [[3000, 3500, 1, 3500]]);

  await studioCaptureClient.notePings(ride.id, [a.id, b.id], 2);
  await studioCaptureClient.noteResponse(ride.id, b.id, 'bid');
  const pingsB = await prisma.searchPing.findMany({ where: { rideId: ride.id, driverId: b.id }, orderBy: { round: 'asc' } });
  assert.deepEqual(pingsB.map((p) => [p.round, p.response]), [[1, null], [2, 'bid']], 'the answer lands on the latest round');
});

test('dataset: a real search in the Studio shape (trip id, Lagos day/hour, rounds, offers on screen, price-change trigger, pings, trip)', async () => {
  const riderId = await user('RIDER');
  const [a, b, c] = [await driver(4.9), await driver(4.4), await driver(4.6)];
  const ride = await prisma.ride.create({ data: {
    riderId, status: 'COMPLETED', channel: 'WHATSAPP', paymentMethod: 'CASH', driverId: a.id, pickupZone: 'Yaba', destZone: 'outside',
    pickupLat: 6.51, pickupLng: 3.37, pickupAddress: 'Yaba', destLat: 6.6, destLng: 3.35, destAddress: 'Ikeja', plannedDistanceKm: 12.3,
    bookingSuggestedFareNgn: 5000, firstRiderOfferNgn: 4500, riderOfferNgn: 5000, agreedFareNgn: 5000, driversFoundAtSearch: 6,
    createdAt: T0, matchedAt: at(150), arrivedAt: at(150 + 7 * 60), startedAt: at(1200), completedAt: at(3000), commissionNgn: 225, serviceFeeNgn: 0, whatsappFeeNgn: 300,
  } });
  made.rides.push(ride.id);
  await prisma.ridePriceChange.create({ data: { rideId: ride.id, fromNgn: 4500, toNgn: 5000, offersOpen: 1, lowestOfferNgn: 5000, at: at(60) } });
  await prisma.driverBid.createMany({ data: [
    { rideId: ride.id, driverId: c.id, driverUserId: c.userId, riderId, amountNgn: 5000, etaSeconds: 400, status: 'LOST', createdAt: at(30), resolvedAt: at(150) },
    { rideId: ride.id, driverId: a.id, driverUserId: a.userId, riderId, amountNgn: 5000, etaSeconds: 300, distanceKm: 1.2, status: 'ACCEPTED', createdAt: at(90), resolvedAt: at(150) },
    { rideId: ride.id, driverId: b.id, driverUserId: b.userId, riderId, amountNgn: 5600, etaSeconds: 200, status: 'LOST', createdAt: at(100), resolvedAt: at(150) },
  ] });
  await prisma.searchPing.createMany({ data: [
    { rideId: ride.id, driverId: a.id, round: 1 }, { rideId: ride.id, driverId: b.id, round: 1, response: 'declined' },
    { rideId: ride.id, driverId: a.id, round: 2, response: 'bid' }, { rideId: ride.id, driverId: b.id, round: 2, response: 'bid' },
  ] });
  await prisma.feedback.create({ data: { rideId: ride.id, reviewerId: riderId, reviewerRole: 'RIDER', revieweeId: a.userId, rating: 5 } });

  const ds = await buildStudioDataset({ from: '2026-11-10', to: '2026-11-10' });
  const tripNumber = (await prisma.ride.findUnique({ where: { id: ride.id } })).tripNumber;
  const id = `WH-${String(tripNumber).padStart(5, '0')}`;
  const s = ds.sessions.find((x) => x.id === id);
  assert.ok(s, 'the session is there under its trip id');
  assert.deepEqual([s.date, s.hour, s.weekday, s.dayPart, s.channel, s.zone, s.destZone], ['2026-11-10', 9, 'Tue', 'Morning 06–09', 'WhatsApp', 'Yaba', 'Outside zones']);
  assert.deepEqual([s.openingNgn, s.finalNgn, s.agreedNgn, s.outcome, s.rounds, s.freeDrivers, s.pinged, s.offersReceived], [4500, 5000, 5000, 'Completed', 2, 6, 2, 3]);
  assert.deepEqual([s.matchSec, s.firstOfferSec, s.offersOnScreen, s.decisionSec], [150, 30, 3, 120]);
  assert.equal(s.minutesToRide, 20);
  assert.equal(s.wheelersNetNgn, 525, 'commission + WhatsApp fee (VAT and levy are not Wheelers\' money)');
  assert.deepEqual([s.trip.method, s.trip.rating, s.trip.pickupDelayMin], ['Cash', 5, 2]);
  assert.equal(s.riderType, null, 'not recorded yet: null, never a made-up value');
  assert.ok(ds.notRecorded.includes('riderType'));

  const mine = ds.offers.filter((o) => o.sessionId === id).sort((x, y) => x.priceNgn - y.priceNgn || x.round - y.round);
  assert.deepEqual(mine.map((o) => [o.priceNgn, o.riderPriceNgn, o.round, o.status]), [[5000, 4500, 1, 'Lost to other driver'], [5000, 5000, 2, 'Accepted'], [5600, 5000, 2, 'Lost to other driver']]);
  const won = mine.find((o) => o.status === 'Accepted');
  assert.deepEqual([won.listPos !== null, won.premiumNgn, won.latencySec, won.pickupKm, won.driverRating], [true, 0, 30, 1.2, 4.9]);

  assert.deepEqual(ds.priceChanges.filter((c) => c.sessionId === id), [{ sessionId: id, direction: 'Raise', fromNgn: 4500, toNgn: 5000, trigger: 'Matched lowest counter' }]);
  const pings = ds.pingRows.filter((p) => p[0] === id).map((p) => p[2]).sort();
  assert.deepEqual(pings, ['Countered', 'Declined', 'No answer', 'Took rider price']);
  assert.deepEqual(ds.payments.filter((p) => p.sessionId === id).map((p) => [p.method, p.amountNgn]), [['Cash', 5000]]);

  const xlsx = await studioDatasetWorkbook(ds);
  assert.equal(xlsx.subarray(0, 2).toString(), 'PK', 'an Excel file (zip)');
});

test('GET /admin/insights/studio-dataset: gzipped JSON in the Studio shape when asked; an Excel with format=xlsx', async () => {
  const zlib = require('node:zlib');
  const { handleAdminInsightsRoute } = require('../apps/api-gateway/dist/http/admin-insights.route.js');
  const DEPS = { adminApiKey: 'test-admin-key-studio', jwtSecret: 'test-secret-that-is-at-least-32-characters-long' };
  const call = async (path, headers = {}) => {
    const out = { headers: {}, body: null, statusCode: 0 };
    const res = { statusCode: 0, setHeader(k, v) { out.headers[k.toLowerCase()] = v; }, end(chunk) { out.body = chunk; out.statusCode = res.statusCode; } };
    await handleAdminInsightsRoute({ method: 'GET', headers: { 'x-admin-key': DEPS.adminApiKey, ...headers } }, res, DEPS, new URL(path, 'http://localhost'));
    return out;
  };
  const zipped = await call('/admin/insights/studio-dataset?from=2026-11-10&to=2026-11-10', { 'accept-encoding': 'gzip, br' });
  assert.equal(zipped.statusCode, 200);
  assert.equal(zipped.headers['content-encoding'], 'gzip');
  const ds = JSON.parse(zlib.gunzipSync(zipped.body).toString());
  assert.deepEqual([ds.source, ds.from, ds.to, Array.isArray(ds.pingRows), ds.zones.includes('Outside zones')], ['live', '2026-11-10', '2026-11-10', true, true]);
  const plain = await call('/admin/insights/studio-dataset?from=2026-11-10&to=2026-11-10');
  assert.equal(plain.headers['content-encoding'], undefined);
  assert.equal(JSON.parse(plain.body.toString()).source, 'live');
  const xlsx = await call('/admin/insights/studio-dataset?from=2026-11-10&to=2026-11-10&format=xlsx');
  assert.match(xlsx.headers['content-disposition'], /wheelers-studio-data-2026-11-10-to-2026-11-10\.xlsx/);
});
