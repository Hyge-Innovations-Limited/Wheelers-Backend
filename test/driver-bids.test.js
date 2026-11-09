/**
 * Driver bid history and active-ride resync, against a real Postgres.
 *
 *   DATABASE_URL=postgresql://postgres:postgres@localhost:55432/wheelers_test \
 *     node --test --test-force-exit test/driver-bids.test.js
 *
 * Needs the migrations applied (`prisma migrate deploy`) and both
 * `@wheleers/db` and `@wheleers/api-gateway` built. Seeds its own rows and
 * removes them afterwards.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { randomUUID } = require('node:crypto');

const { prisma, driverBidClient, rideClient, driverClient, SEARCH_TIMED_OUT_REASON } = require('@wheleers/db');
const {
  handleGetDriverBidsRoute,
  handleGetDriverActiveRideRoute,
} = require('../apps/api-gateway/dist/http/driver.route.js');
const {
  loadDriverActiveRideSnapshot,
  resyncDriverActiveRide,
} = require('../apps/api-gateway/dist/websocket/driver-ride-sync.js');
const { createLocalAccessToken } = require('../apps/api-gateway/dist/auth/local.js');

const JWT_SECRET = 'test-secret-that-is-long-enough-for-hmac-signing-0123456789';
const stamp = Date.now();

const seeded = { users: [], drivers: [], rides: [] };

async function seedUser(role, phone) {
  const user = await prisma.user.create({
    data: { privyDid: `did:test:${randomUUID()}`, role, name: `${role} ${stamp}`, phone },
  });
  seeded.users.push(user.id);
  return user;
}

async function seedDriver(user) {
  const driver = await prisma.driver.create({
    data: { userId: user.id, status: 'ONLINE', vehicleModel: 'Camry', vehiclePlate: 'LAGUNA2367' },
  });
  seeded.drivers.push(driver.id);
  return driver;
}

async function seedRide(riderId, extra = {}) {
  const ride = await prisma.ride.create({
    data: {
      riderId,
      status: 'MATCHING',
      pickupLat: 6.6018, pickupLng: 3.3515, pickupAddress: '102 Opebi Rd, Ikeja',
      destLat: 6.4969, destLng: 3.3556, destAddress: '15 Aiyetoro St, Surulere',
      fareEstimateNgn: 5200,
      riderOfferNgn: 6000,
      ...extra,
    },
  });
  seeded.rides.push(ride.id);
  return ride;
}

/** Run one of the gateway's raw-http route handlers through a real socket. */
async function callRoute(handler, path, token) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    void handler(req, res, { jwtSecret: JWT_SECRET }, url);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

let rider; let driverUser; let driver; let rivalUser; let rival;

test.before(async () => {
  await prisma.$connect();
  rider = await seedUser('RIDER', '+2348011111111');
  driverUser = await seedUser('DRIVER', '+2348022222222');
  driver = await seedDriver(driverUser);
  rivalUser = await seedUser('DRIVER', '+2348033333333');
  rival = await seedDriver(rivalUser);
});

test.after(async () => {
  await prisma.driverBid.deleteMany({ where: { rideId: { in: seeded.rides } } });
  await prisma.ride.deleteMany({ where: { id: { in: seeded.rides } } });
  await prisma.driver.deleteMany({ where: { id: { in: seeded.drivers } } });
  await prisma.user.deleteMany({ where: { id: { in: seeded.users } } });
  await prisma.$disconnect();
});

test('a re-bid on the same ride replaces the amount instead of adding a row', async () => {
  const ride = await seedRide(rider.id);
  const base = { rideId: ride.id, driverId: driver.id, driverUserId: driverUser.id, riderId: rider.id, etaSeconds: 120 };

  await driverBidClient.record({ ...base, amountNgn: 6500, distanceKm: 0.6 });
  await driverBidClient.record({ ...base, amountNgn: 6000, distanceKm: 0.6 });

  const rows = await driverBidClient.findByRide(ride.id);
  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0].amountNgn), 6000);
  assert.equal(rows[0].status, 'PENDING');
});

test('the rider picking a driver marks that bid won and every other open bid lost', async () => {
  const ride = await seedRide(rider.id);
  const common = { rideId: ride.id, riderId: rider.id, etaSeconds: 120 };
  await driverBidClient.record({ ...common, driverId: driver.id, driverUserId: driverUser.id, amountNgn: 6000 });
  await driverBidClient.record({ ...common, driverId: rival.id, driverUserId: rivalUser.id, amountNgn: 5500 });

  await driverBidClient.markAccepted(ride.id, driver.id);

  const byDriver = Object.fromEntries((await driverBidClient.findByRide(ride.id)).map((b) => [b.driverId, b]));
  assert.equal(byDriver[driver.id].status, 'ACCEPTED');
  assert.ok(byDriver[driver.id].resolvedAt, 'resolution is timestamped');
  assert.equal(byDriver[rival.id].status, 'LOST');
});

test('timeout, cancellation and withdrawal only touch bids still pending', async () => {
  const expired = await seedRide(rider.id);
  await driverBidClient.record({ rideId: expired.id, driverId: driver.id, driverUserId: driverUser.id, riderId: rider.id, amountNgn: 6000, etaSeconds: 60 });
  await driverBidClient.resolvePending(expired.id, 'EXPIRED');
  assert.equal((await driverBidClient.findByRide(expired.id))[0].status, 'EXPIRED');

  const cancelled = await seedRide(rider.id);
  await driverBidClient.record({ rideId: cancelled.id, driverId: driver.id, driverUserId: driverUser.id, riderId: rider.id, amountNgn: 6000, etaSeconds: 60 });
  await driverBidClient.resolvePending(cancelled.id, 'CANCELLED');
  assert.equal((await driverBidClient.findByRide(cancelled.id))[0].status, 'CANCELLED');

  const withdrawn = await seedRide(rider.id);
  await driverBidClient.record({ rideId: withdrawn.id, driverId: driver.id, driverUserId: driverUser.id, riderId: rider.id, amountNgn: 6000, etaSeconds: 60 });
  await driverBidClient.markWithdrawn(withdrawn.id, driver.id);
  assert.equal((await driverBidClient.findByRide(withdrawn.id))[0].status, 'WITHDRAWN');

  // A won bid cannot be withdrawn or expired after the fact.
  const won = await seedRide(rider.id);
  await driverBidClient.record({ rideId: won.id, driverId: driver.id, driverUserId: driverUser.id, riderId: rider.id, amountNgn: 6000, etaSeconds: 60 });
  await driverBidClient.markAccepted(won.id, driver.id);
  await driverBidClient.markWithdrawn(won.id, driver.id);
  await driverBidClient.resolvePending(won.id, 'EXPIRED');
  assert.equal((await driverBidClient.findByRide(won.id))[0].status, 'ACCEPTED');
});

test('a search that TIMED OUT can still be won — a rider still paying, or a late bid — but a ride the rider cancelled never can', async () => {
  const rider = await seedUser('RIDER', `+23480${stamp}31`);
  const driver = await seedDriver(await seedUser('DRIVER', `+23480${stamp}32`));

  const timedOut = await seedRide(rider.id);
  assert.equal((await rideClient.cancelIfUnmatched(timedOut.id)).count, 1);
  assert.equal((await rideClient.cancelIfUnmatched(timedOut.id)).count, 0, 'once');
  const revived = await rideClient.assignDriver(timedOut.id, driver.id, { agreedFareNgn: 6000, paymentMethod: 'WALLET' });
  assert.equal(revived.count, 1, 'the deposit landed after the search gave up: the driver is theirs');
  const row = await prisma.ride.findUniqueOrThrow({ where: { id: timedOut.id } });
  assert.deepEqual([row.status, row.driverId, row.cancelStage, row.cancelReason, row.cancelledAt, Number(row.agreedFareNgn)], ['DRIVER_ASSIGNED', driver.id, null, null, null, 6000]);

  const cancelledByRider = await seedRide(rider.id, { status: 'CANCELLED', cancelStage: 'BEFORE_MATCH', cancelReason: 'Accidental request', cancelledAt: new Date() });
  assert.equal((await rideClient.assignDriver(cancelledByRider.id, driver.id)).count, 0, 'the rider said no — that stands');
  assert.equal(SEARCH_TIMED_OUT_REASON, 'No driver accepted in time', 'the ride service writes this exact reason');
});

test('a driver carrying a passenger is offered nothing — until they are nearly at their drop-off and the new pickup is on their way', async () => {
  const IKEJA = { lat: 6.6018, lng: 3.3515 };          // where the current trip ends, and the new rider waits
  const rider = await seedUser('RIDER', `+23480${stamp}41`);
  const driver = await seedDriver(await seedUser('DRIVER', `+23480${stamp}42`));
  const trip = await seedRide(rider.id, { status: 'IN_PROGRESS', driverId: driver.id, destLat: IKEJA.lat, destLng: IKEJA.lng });
  await prisma.driver.update({ where: { id: driver.id }, data: { status: 'ON_RIDE', kycStatus: 'APPROVED' } });

  const free = () => driverClient.findNearby(IKEJA.lat, IKEJA.lng, 5, 5);
  const finishing = () => driverClient.findFinishingNearby(IKEJA.lat, IKEJA.lng, 5, 5, 2);
  const has = async (rows) => (await rows()).some((d) => d.id === driver.id);

  // Mid-trip, still 12 km out: busy. Not free, not finishing.
  await driverClient.updateLocation(driver.id, IKEJA.lat + 0.11, IKEJA.lng);
  assert.equal(await has(free), false, 'a driver with a passenger is never in the free pool');
  assert.equal(await has(finishing), false, 'and 12 km from their drop-off they are simply busy');

  // Now ~1 km from the drop-off, and the new pickup is right there: offer it.
  await driverClient.updateLocation(driver.id, IKEJA.lat + 0.009, IKEJA.lng);
  assert.equal(await has(free), false, 'still not free — they have someone in the car');
  const queued = (await finishing()).find((d) => d.id === driver.id);
  assert.ok(queued, 'nearly done, and the pickup is where they are heading');
  assert.ok(queued.distanceKm < 0.2, 'ranked from where they will BE, not where they are');

  // A pickup 40 km the other way is not "on their way", however close they are to dropping off.
  assert.equal((await driverClient.findFinishingNearby(IKEJA.lat + 0.36, IKEJA.lng, 5, 5, 2)).some((d) => d.id === driver.id), false);

  // The trip ends: they rejoin the free pool and leave the finishing one.
  await prisma.ride.update({ where: { id: trip.id }, data: { status: 'COMPLETED' } });
  await prisma.driver.update({ where: { id: driver.id }, data: { status: 'ONLINE' } });
  await driverClient.updateLocation(driver.id, IKEJA.lat, IKEJA.lng);
  assert.equal(await has(free), true);
  assert.equal(await has(finishing), false);
});

test('GET /drivers/me/bids lists the driver\'s bids newest first, with the trip and outcome', async () => {
  const token = createLocalAccessToken(driverUser.id, JWT_SECRET);
  const { status, body } = await callRoute(handleGetDriverBidsRoute, '/drivers/me/bids', token);

  assert.equal(status, 200);
  assert.ok(Array.isArray(body.items));
  assert.ok(body.items.length >= 5, 'every bid seeded above is listed');
  for (let i = 1; i < body.items.length; i += 1) {
    assert.ok(body.items[i - 1].createdAt >= body.items[i].createdAt, 'newest first');
  }
  const item = body.items[0];
  assert.equal(typeof item.amountNgn, 'number');
  assert.equal(item.ride.pickupAddress, '102 Opebi Rd, Ikeja');
  assert.equal(item.ride.destAddress, '15 Aiyetoro St, Surulere');
  assert.equal(item.ride.riderOfferNgn, 6000);
  assert.ok(['PENDING', 'ACCEPTED', 'LOST', 'WITHDRAWN', 'EXPIRED', 'CANCELLED'].includes(item.status));

  // The rival only ever placed one bid and lost it.
  const rivalToken = createLocalAccessToken(rivalUser.id, JWT_SECRET);
  const rivalView = await callRoute(handleGetDriverBidsRoute, '/drivers/me/bids', rivalToken);
  assert.equal(rivalView.body.items.length, 1);
  assert.equal(rivalView.body.items[0].status, 'LOST');
});

test('GET /drivers/me/bids paginates with a cursor', async () => {
  const token = createLocalAccessToken(driverUser.id, JWT_SECRET);
  const first = await callRoute(handleGetDriverBidsRoute, '/drivers/me/bids?limit=2', token);
  assert.equal(first.body.items.length, 2);
  assert.ok(first.body.nextCursor, 'more pages remain');

  const second = await callRoute(handleGetDriverBidsRoute, `/drivers/me/bids?limit=2&cursor=${first.body.nextCursor}`, token);
  assert.equal(second.body.items.length, 2);
  const firstIds = new Set(first.body.items.map((b) => b.id));
  assert.ok(second.body.items.every((b) => !firstIds.has(b.id)), 'no overlap between pages');
});

test('GET /drivers/me/bids rejects a missing or bad token', async () => {
  assert.equal((await callRoute(handleGetDriverBidsRoute, '/drivers/me/bids', undefined)).status, 401);
  assert.equal((await callRoute(handleGetDriverBidsRoute, '/drivers/me/bids', 'not-a-token')).status, 401);
});

test('GET /drivers/me/rides/active is null until a ride is assigned, then carries the whole trip', async () => {
  const token = createLocalAccessToken(driverUser.id, JWT_SECRET);
  const before = await callRoute(handleGetDriverActiveRideRoute, '/drivers/me/rides/active', token);
  assert.equal(before.status, 200);
  assert.equal(before.body.ride, null);

  // The rider paid and ride-service assigned this driver.
  const ride = await seedRide(rider.id, {
    status: 'DRIVER_ASSIGNED',
    driverId: driver.id,
    agreedFareNgn: 6000,
    matchedAt: new Date(),
    routeStops: {
      create: [
        { stopOrder: 1, type: 'INTERMEDIATE', lat: 6.55, lng: 3.35, address: 'Maryland Mall' },
        { stopOrder: 2, type: 'FINAL', lat: 6.4969, lng: 3.3556, address: '15 Aiyetoro St, Surulere' },
      ],
    },
  });

  const after = await callRoute(handleGetDriverActiveRideRoute, '/drivers/me/rides/active', token);
  assert.equal(after.status, 200);
  const active = after.body.ride;
  assert.equal(active.rideId, ride.id);
  assert.equal(active.rideStatus, 'DRIVER_ASSIGNED');
  assert.equal(active.pickup.address, '102 Opebi Rd, Ikeja');
  assert.equal(active.destination.address, '15 Aiyetoro St, Surulere');
  assert.deepEqual(active.stops.map((s) => s.address), ['Maryland Mall'], 'only intermediate stops — the destination is not repeated');
  assert.equal(active.agreedFareNgn, 6000);
  assert.equal(active.riderPaid, true, 'wallet rides are held before assignment');
  assert.equal(active.riderPhone, '+2348011111111');

  // Once the trip is over it is no longer "active".
  await prisma.ride.update({ where: { id: ride.id }, data: { status: 'COMPLETED', completedAt: new Date() } });
  const done = await callRoute(handleGetDriverActiveRideRoute, '/drivers/me/rides/active', token);
  assert.equal(done.body.ride, null);
});

test('a driver reconnecting mid-trip is sent ride:matched for their assigned ride', async () => {
  const ride = await seedRide(rider.id, {
    status: 'IN_PROGRESS', driverId: driver.id, agreedFareNgn: 4200, matchedAt: new Date(), startedAt: new Date(),
  });

  const sent = [];
  const registry = { sendToSocket: (socket, type, payload) => sent.push({ socket, type, payload }) };
  const socket = { id: 'fake-socket' };

  await resyncDriverActiveRide(registry, socket, driver.id);

  assert.equal(sent.length, 1);
  assert.equal(sent[0].socket, socket);
  assert.equal(sent[0].type, 'ride:matched');
  assert.equal(sent[0].payload.rideId, ride.id);
  assert.equal(sent[0].payload.rideStatus, 'IN_PROGRESS', 'the app reopens on the trip screen, not navigation');
  assert.equal(sent[0].payload.resync, true);
  assert.equal(sent[0].payload.agreedFareNgn, 4200);

  // And nothing is sent for a driver with no live trip.
  await prisma.ride.update({ where: { id: ride.id }, data: { status: 'COMPLETED' } });
  assert.equal(await loadDriverActiveRideSnapshot(driver.id), null);
  const quiet = [];
  await resyncDriverActiveRide({ sendToSocket: (...args) => quiet.push(args) }, socket, driver.id);
  assert.equal(quiet.length, 0);
});
