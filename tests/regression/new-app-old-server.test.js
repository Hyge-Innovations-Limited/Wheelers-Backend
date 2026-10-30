// Regression (plan 2026-10-28, Phase 2 + 3): the NEW rider app against the OLD server (production today), and against
// the new server with both flags off. The app's REAL parsers (lib/route-quote.ts, lib/driver-photo.ts, bundled
// from the app repo) read the server's REAL answers, and every answer must degrade to today's behaviour:
//   - a route quote and a priced route update at the quoted price: done, nothing new needed in the reply;
//   - a priced update at a stale price: "price changed" with the server's quote, not a hang;
//   - the new "back out of a waiting change" message does not exist on the old server: the app ends in a clear
//     failure, never a crash or a false success;
//   - a driver/offer payload with no photo or ride-count fields: initials, and the rating reads "4.8 ★".
//
//   node scripts/run-with-env.cjs node --test --test-force-exit --test-concurrency=1 tests/regression/new-app-old-server.test.js
//   REGRESSION_ROOT=<built checkout of production HEAD> ... the same file against production's server.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const REPO = path.resolve(__dirname, '../..');
const ROOT = process.env.REGRESSION_ROOT || REPO;
const APP = process.env.WHEELERS_APP_DIR || '/Users/olowutimilehin/Documents/Wheelersapp';
const at = (p) => require(path.join(ROOT, p));
const { PrismaClient } = require(path.join(REPO, 'node_modules/@prisma/client'));
const { calculateRideFees } = at('packages/config/dist/index.js');
const { walletClient } = at('packages/db/dist/index.js');
const { handleRideMessage } = at('apps/api-gateway/dist/websocket/handlers/ride.handler.js');

// The app's own code, bundled the way the app's tests do it.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wheelers-newapp-'));
fs.writeFileSync(path.join(tmp, 'entry.ts'), `
export * from '${APP}/lib/route-quote.ts';
export * from '${APP}/lib/driver-photo.ts';
`);
execFileSync('npx', ['esbuild', path.join(tmp, 'entry.ts'), '--bundle', '--platform=node', '--format=cjs', `--outfile=${path.join(tmp, 'bundle.cjs')}`], { cwd: APP, stdio: 'pipe' });
const app = require(path.join(tmp, 'bundle.cjs'));

const prisma = new PrismaClient();
const made = { users: [], rides: [], drivers: [] };
const real = { log: console.log, info: console.info, warn: console.warn };
console.info = () => {}; console.log = () => {}; console.warn = () => {};

const YABA = { lat: 6.5095, lng: 3.3711, address: '12 Herbert Macaulay Way, Yaba, Lagos' };
const VI = { lat: 6.4281, lng: 3.4219, address: 'Adeola Odeku Street, Victoria Island, Lagos' };
const IKEJA = { lat: 6.6018, lng: 3.3515, address: 'Ikeja City Mall, Obafemi Awolowo Way, Ikeja' };
const LINE = [{ lat: YABA.lat, lng: YABA.lng }, { lat: VI.lat, lng: VI.lng }];
const AGREED = 5200;
const HOLD = calculateRideFees(AGREED).totalNgn;

function memoryRedis() {
  const store = new Map();
  return {
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async set(k, v) { store.set(k, v); },
    async del(k) { store.delete(k); },
    async setIfNotExists(k, v) { if (store.has(k)) return false; store.set(k, v); return true; },
    async send(cmd, key) {
      if (cmd === 'INCR') { const n = Number(store.get(`n:${key}`) ?? 0) + 1; store.set(`n:${key}`, String(n)); return n; }
      if (cmd === 'TTL') return -1;
      if (cmd === 'GETDEL') { const v = store.has(key) ? store.get(key) : null; store.delete(key); return v; }
      return null;
    },
  };
}
const planner = (fareNgn) => ({ planRoute: async () => ({ distanceKm: 2, durationSeconds: 300, suggestedFareNgn: fareNgn, fareEstimateNgn: fareNgn, minOfferNgn: 1000, ratePerKmNgn: 420, priceReason: null, geometry: { coordinates: LINE, bounds: { northEast: VI, southWest: YABA } } }) });
async function makeUser(role, balanceNgn = 0) {
  const id = randomUUID();
  await prisma.user.create({ data: { id, privyDid: `local:${id}`, role, name: 'Reg Test', phone: `+23480${Math.floor(1e8 + Math.random() * 9e8)}` } });
  await prisma.wallet.create({ data: { userId: id, balanceNgn } });
  made.users.push(id);
  return id;
}
async function trip(spareNgn) {
  const rider = await makeUser('RIDER', HOLD + spareNgn);
  const du = await makeUser('DRIVER');
  const driver = await prisma.driver.create({ data: { userId: du, status: 'ON_RIDE', kycStatus: 'APPROVED', lat: 6.5, lng: 3.37, lastSeenAt: new Date(), vehicleModel: 'Toyota Corolla', vehiclePlate: `LND-${Math.floor(100 + Math.random() * 900)}XA` } });
  made.drivers.push(driver.id);
  const ride = await prisma.ride.create({ data: { riderId: rider, driverId: driver.id, status: 'IN_PROGRESS', paymentMethod: 'WALLET', pickupLat: YABA.lat, pickupLng: YABA.lng, pickupAddress: YABA.address, destLat: VI.lat, destLng: VI.lng, destAddress: VI.address, agreedFareNgn: AGREED, fareEstimateNgn: AGREED, distanceKm: 11.4, durationSeconds: 1680 } });
  made.rides.push(ride.id);
  await prisma.rideStop.create({ data: { rideId: ride.id, stopOrder: 0, type: 'FINAL', status: 'PENDING', lat: VI.lat, lng: VI.lng, address: VI.address } });
  const wallet = await walletClient.findByUserId(rider);
  await walletClient.createRideHold({ rideId: ride.id, walletId: wallet.id, riderId: rider, driverUserId: du, amountNgn: HOLD });
  return { rider, ride };
}
const gateway = () => { const events = []; return { events, publisher: { publishRideEvent: async (e) => { events.push(e); } }, redis: memoryRedis() }; };
// What server.ts sends when a handler throws: type 'error' with the request's type.
const wsError = (requestType, e) => ({ type: 'error', payload: { message: e.message, requestType } });

test.after(async () => {
  Object.assign(console, real);
  const wallets = (await prisma.wallet.findMany({ where: { userId: { in: made.users } }, select: { id: true } })).map((w) => w.id);
  await prisma.rideHold.deleteMany({ where: { rideId: { in: made.rides } } }).catch(() => {});
  await prisma.rideStop.deleteMany({ where: { rideId: { in: made.rides } } }).catch(() => {});
  await prisma.transaction.deleteMany({ where: { OR: [{ walletId: { in: wallets } }, { referenceId: { in: made.rides } }] } }).catch(() => {});
  await prisma.ride.deleteMany({ where: { id: { in: made.rides } } }).catch(() => {});
  await prisma.wallet.deleteMany({ where: { id: { in: wallets } } }).catch(() => {});
  await prisma.driver.deleteMany({ where: { id: { in: made.drivers } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: made.users } } }).catch(() => {});
  await prisma.$disconnect();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('NEW app, quote then priced route update at the quoted price: the app reads "quote", then "done"', async () => {
  const t = await trip(3000);
  const w = gateway();
  const auth = { userId: t.rider, role: 'RIDER' };
  const plan = planner(6000);
  const q = await handleRideMessage('ride:route:quote', { rideId: t.ride.id, destination: IKEJA, stops: [] }, auth, w.publisher, plan, w.redis);
  const quoted = app.routeQuoteAnswerFrom(q.type, q.payload, t.ride.id);
  assert.equal(quoted.kind, 'quote');
  assert.equal(typeof quoted.quote.fareNgn, 'number');
  const u = await handleRideMessage('ride:route:update', { rideId: t.ride.id, destination: IKEJA, stops: [], acceptedFareNgn: quoted.quote.fareNgn }, auth, w.publisher, plan, w.redis);
  const answer = app.routeUpdateAnswerFrom(u);
  assert.equal(answer.kind, 'done');
  assert.equal(answer.inProgress, false, 'an older reply never says in-progress; the app does not wait for a second message');
  assert.equal(app.routeOutcomeFrom(u.type, u.payload, t.ride.id), null, 'a plain accepted is not read as "applied after a deposit"');
});

test('NEW app, priced update at a stale price: "price changed" with the server\'s quote (no hang, no false success)', async () => {
  const t = await trip(3000);
  const w = gateway();
  const auth = { userId: t.rider, role: 'RIDER' };
  const u = await handleRideMessage('ride:route:update', { rideId: t.ride.id, destination: IKEJA, stops: [], acceptedFareNgn: 4000 }, auth, w.publisher, planner(6000), w.redis);
  const answer = app.routeUpdateAnswerFrom(u);
  assert.equal(answer.kind, 'price_changed');
  assert.equal(typeof answer.quote.fareNgn, 'number');
  assert.equal(w.events.length, 0, 'nothing was published');
});

test('NEW app, an update the server refuses with a thrown error: shown to the rider, not read as success', async () => {
  const t = await trip(0);
  const stranger = await makeUser('RIDER', 0);
  const w = gateway();
  let err;
  try { await handleRideMessage('ride:route:update', { rideId: t.ride.id, destination: IKEJA, stops: [], acceptedFareNgn: 6000 }, { userId: stranger, role: 'RIDER' }, w.publisher, planner(6000), w.redis); } catch (e) { err = e; }
  assert.ok(err, 'a stranger is refused');
  const reply = wsError('ride:route:update', err);
  assert.equal(app.routeUpdateWaitMatches(reply.type, reply.payload), true, 'the app is waiting for this error');
  const answer = app.routeUpdateAnswerFrom(reply);
  assert.equal(answer.kind, 'refused');
  assert.ok(answer.message.length > 0);
});

test('NEW app, "back out of a waiting change" on a server that does not know it: a clear failure, never a success', () => {
  // production server.ts: "Unknown event type", no requestType.
  const reply = { type: 'error', payload: { message: 'Unknown event type: ride:route:pending:cancel' } };
  assert.equal(app.pendingCancelWaitMatches(reply.type, reply.payload), false, 'not matched: the app times out');
  const afterTimeout = app.pendingCancelAnswerFrom(null);
  assert.equal(afterTimeout.kind, 'failed');
  assert.equal(afterTimeout.message, app.PENDING_CANCEL_FAILED);
  // And if the error does carry the request type, it is a failure with the server's words.
  assert.equal(app.pendingCancelAnswerFrom({ type: 'error', payload: { requestType: 'ride:route:pending:cancel', message: 'Nope' } }).kind, 'failed');
});

test('NEW app, no answer at all to a priced update: a failure message, never "done"', () => {
  assert.deepEqual(app.routeUpdateAnswerFrom(null), { kind: 'refused', message: app.ROUTE_UPDATE_FAILED });
});

test('NEW app, a route update broadcast from an older server (no fareNgn, no stops echo): the fare line is left alone', () => {
  assert.equal(app.routeUpdatedFareFrom({ rideId: 'r', destination: IKEJA, stops: [] }), null);
});

test('NEW app, a driver / offer / matched payload with no photo or ride-count fields (production today): initials, and the rating alone', () => {
  const offer = { bidId: 'b', driverId: 'd', driverName: 'Ade', rating: 4.8, totalRides: 120, vehicleModel: 'Corolla', amountNgn: 5200, etaSeconds: 300 };
  assert.deepEqual(app.profileFrom(offer), {});
  assert.deepEqual(app.carryProfile(offer, undefined), {});
  assert.equal(app.avatarLook(app.photoFrom(offer).driverPhotoUrl, null), 'initials');
  assert.equal(app.reputationLine(offer.rating, undefined), '4.8 ★');
  assert.equal(app.reputationLine(undefined, undefined), null);
  // A later photo-less message keeps nothing it never had, and keeps what it had.
  const known = { driverPhotoUrl: 'https://img.example/a.jpg', driverPhotoKey: 'k1', driverRidesCompleted: 7 };
  assert.deepEqual(app.carryProfile(offer, known), known);
  // Junk is no photo.
  assert.deepEqual(app.photoFrom({ driverPhotoUrl: 'http://insecure/x.jpg', driverPhotoKey: 'k' }), {});
  assert.deepEqual(app.photoFrom({ driverPhotoUrl: null }), {});
});
