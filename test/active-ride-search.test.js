// A rider who closed the app mid-search asks for their active ride and gets
// the search back: when it closes, and the offers drivers have made that are
// still open, cheapest first. A ride with a driver carries no search.
// Against the local Postgres.
//
//   node scripts/run-with-env.cjs node --test --test-force-exit test/active-ride-search.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { prisma } = require('@wheleers/db');
const local = require('../apps/api-gateway/dist/auth/local.js');
const { handleActiveRideRoute } = require('../apps/api-gateway/dist/http/ride.route.js');

const SECRET = 'test-secret-for-the-active-ride-search';
const made = { users: [], drivers: [], rides: [] };
let server; let base;

async function user(role, name) {
  const row = await prisma.user.create({ data: { privyDid: `did:test:${randomUUID()}`, role, name } });
  made.users.push(row.id);
  return row;
}
async function driver(name, car) {
  const u = await user('DRIVER', name);
  const d = await prisma.driver.create({ data: { userId: u.id, kycStatus: 'APPROVED', rating: 4.8, ...car } });
  made.drivers.push(d.id);
  return { ...d, userId: u.id };
}
async function ride(riderId, data) {
  const row = await prisma.ride.create({ data: {
    riderId, pickupLat: 6.51, pickupLng: 3.37, pickupAddress: '12 Herbert Macaulay Way, Yaba',
    destLat: 6.43, destLng: 3.42, destAddress: 'Adeola Odeku Street, Victoria Island', riderOfferNgn: 6000, ...data,
  } });
  made.rides.push(row.id);
  return row;
}
const active = async (token) => (await fetch(`${base}/rides/active`, { headers: { authorization: `Bearer ${token}` } })).json();

test.before(async () => {
  server = http.createServer((req, res) => { void handleActiveRideRoute(req, res, { jwtSecret: SECRET }); });
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await prisma.driverBid.deleteMany({ where: { rideId: { in: made.rides } } });
  await prisma.ride.deleteMany({ where: { id: { in: made.rides } } });
  await prisma.driver.deleteMany({ where: { id: { in: made.drivers } } });
  await prisma.user.deleteMany({ where: { id: { in: made.users } } });
  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
});

test('a search still open comes back with its closing time and the open offers, cheapest first', async () => {
  const rider = await user('RIDER', 'Timi Rider');
  const token = local.createLocalAccessToken(rider.id, SECRET, 3600);
  const search = await ride(rider.id, { status: 'MATCHING' });
  const tunde = await driver('Tunde Ade', { vehicleMake: 'Toyota', vehicleModel: 'Corolla', vehiclePlate: 'LAG-482-XY' });
  const aisha = await driver('Aisha Bello', { vehicleMake: 'Honda', vehicleModel: 'Accord', vehiclePlate: 'LAG-111-AB' });
  const gone = await driver('Left Early', {});
  await prisma.driverBid.create({ data: { rideId: search.id, driverId: aisha.id, driverUserId: aisha.userId, riderId: rider.id, amountNgn: 6300, etaSeconds: 360, distanceKm: 2.1 } });
  await prisma.driverBid.create({ data: { rideId: search.id, driverId: tunde.id, driverUserId: tunde.userId, riderId: rider.id, amountNgn: 6000, etaSeconds: 240 } });
  await prisma.driverBid.create({ data: { rideId: search.id, driverId: gone.id, driverUserId: gone.userId, riderId: rider.id, amountNgn: 5900, etaSeconds: 100, status: 'WITHDRAWN' } }).catch(async () => {
    // Whatever the closed statuses are called, a bid that is not PENDING must not come back.
    const anyClosed = (await prisma.$queryRaw`SELECT unnest(enum_range(NULL::"DriverBidStatus"))::text AS s`).map((r) => r.s).find((s) => s !== 'PENDING');
    await prisma.$executeRawUnsafe(`INSERT INTO "DriverBid" ("id","rideId","driverId","driverUserId","riderId","amountNgn","etaSeconds","status","updatedAt") VALUES ($1,$2,$3,$4,$5,5900,100,$6::"DriverBidStatus",now())`, randomUUID(), search.id, gone.id, gone.userId, rider.id, anyClosed);
  });

  const { ride: back } = await active(token);
  assert.equal(back.id, search.id);
  assert.equal(back.status, 'MATCHING');
  assert.equal(back.riderOfferNgn, 6000);
  assert.ok(back.search, 'it is a search');
  const closes = Date.parse(back.search.bidsCloseAt) - Date.now();
  assert.ok(closes > 25 * 60_000 && closes <= 30 * 60_000 + 5_000, 'about thirty minutes from the last price');
  assert.deepEqual(back.search.offers.map((o) => [o.driverName, o.counterOfferNgn, o.vehicleModel, o.vehiclePlate]), [
    ['Tunde Ade', 6000, 'Toyota Corolla', 'LAG-482-XY'],
    ['Aisha Bello', 6300, 'Honda Accord', 'LAG-111-AB'],
  ], 'open offers only, cheapest first');
  assert.equal(back.search.offers[0].driverUserId, tunde.userId);
  assert.equal(back.search.offers[0].etaSeconds, 240);
  assert.equal(back.search.offers[1].distanceKm, 2.1);
});

test('a ride with a driver carries no search, and no ride is null', async () => {
  const rider = await user('RIDER', 'Matched Rider');
  const token = local.createLocalAccessToken(rider.id, SECRET, 3600);
  assert.equal((await active(token)).ride, null);
  const tunde = await driver('Tunde Ade', { vehicleMake: 'Toyota', vehicleModel: 'Corolla', vehiclePlate: 'LAG-482-XY' });
  await ride(rider.id, { status: 'DRIVER_ASSIGNED', driverId: tunde.id, agreedFareNgn: 6000 });
  const { ride: back } = await active(token);
  assert.equal(back.status, 'DRIVER_ASSIGNED');
  assert.equal(back.search, null);
  assert.equal(back.driver.name, 'Tunde Ade');
});
