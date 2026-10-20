/**
 * The support desk: a SUPPORT login gets the inbox, the Activity page and the
 * people and trip look-ups, and nothing else; and what it sees has no money,
 * bank details or identity documents, with numbers and emails masked. A
 * number is shown in full only when asked for, and that is recorded.
 * Against the local Postgres.
 *
 *   node scripts/run-with-env.cjs node --test --test-force-exit test/support-desk.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { prisma, adminClient } = require('@wheleers/db');
const { createLocalAccessToken } = require('../apps/api-gateway/dist/auth/local.js');
const { supportDeskAllows, maskPhone, maskEmail } = require('../apps/api-gateway/dist/admin/support-desk.js');
const { supportDeskRefuses, verifyAdminAuth } = require('../apps/api-gateway/dist/http/admin-auth.route.js');
const { handleAdminDeskRoute } = require('../apps/api-gateway/dist/http/admin-desk.route.js');

const SECRET = 'support-desk-test-secret-long-enough-for-jwt';
const deps = { jwtSecret: SECRET, adminApiKey: 'test-key' };
const made = { admins: [], users: [], rides: [], drivers: [] };

test.after(async () => {
  await prisma.adminActivity.deleteMany({ where: { adminId: { in: made.admins } } }).catch(() => {});
  await prisma.ride.deleteMany({ where: { id: { in: made.rides } } }).catch(() => {});
  await prisma.driver.deleteMany({ where: { id: { in: made.drivers } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: made.users } } }).catch(() => {});
  await prisma.adminUser.deleteMany({ where: { id: { in: made.admins } } }).catch(() => {});
  await prisma.$disconnect();
});

async function admin(role) {
  const row = await adminClient.create({ username: `t${randomUUID().replace(/-/g, '').slice(0, 12)}`, passwordHash: 'x', name: `Test ${role}`, role });
  made.admins.push(row.id);
  return createLocalAccessToken(row.id, SECRET, 3600);
}
const req = (token, method, path) => ({ method, url: path, headers: { authorization: `Bearer ${token}` } });
function call(handler, request) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 0, headers: {},
      setHeader(k, v) { this.headers[k] = v; },
      end(body) { resolve({ status: this.statusCode, body: body ? JSON.parse(body) : null }); },
    };
    handler(request, res, deps, new URL(`http://x${request.url}`)).catch(reject);
  });
}

// Every admin path the gateway serves today, outside the desk: all closed to support.
const CLOSED = [
  ['GET', '/admin/alerts'], ['GET', '/admin/alerts/count'], ['GET', '/admin/analytics/activity'], ['GET', '/admin/analytics/activity-feed'],
  ['GET', '/admin/analytics/drivers'], ['GET', '/admin/analytics/platform'], ['GET', '/admin/analytics/recent-rides'], ['GET', '/admin/analytics/riders'],
  ['POST', '/admin/create-admin'], ['GET', '/admin/driver-papers'], ['GET', '/admin/drivers'], ['POST', '/admin/drivers/abc/approve'],
  ['GET', '/admin/fees/deposits'], ['GET', '/admin/fees/ledger'], ['GET', '/admin/fees/summary'], ['GET', '/admin/fees/withdrawals'],
  ['GET', '/admin/health'], ['GET', '/admin/insights/summary'], ['GET', '/admin/insights/export'], ['GET', '/admin/insights/riders'],
  ['GET', '/admin/live/drivers'], ['POST', '/admin/live/dispatch'], ['GET', '/admin/metrics/overview'], ['GET', '/admin/metrics/timeseries'],
  ['GET', '/admin/rides'], ['GET', '/admin/rides/abc'], ['GET', '/admin/stellar'], ['GET', '/admin/team'], ['GET', '/admin/team/activity'],
  ['PATCH', '/admin/team/abc'], ['GET', '/admin/usage/services'], ['GET', '/admin/users'], ['GET', '/admin/users/abc'],
  ['POST', '/admin/support/conversations/abc/delete'], ['DELETE', '/admin/support/conversations/abc'],
];
const OPEN = [
  ['GET', '/admin/me'], ['POST', '/admin/activity'], ['GET', '/admin/support/conversations'], ['GET', '/admin/support/conversations/abc'],
  ['POST', '/admin/support/conversations/abc/messages'], ['POST', '/admin/support/conversations/abc/resolve'], ['POST', '/admin/support/conversations/abc/assign'],
  ['GET', '/admin/analytics/app-activity'], ['GET', '/admin/desk/people'], ['GET', '/admin/desk/people/abc'], ['POST', '/admin/desk/people/abc/phone'],
  ['GET', '/admin/desk/trips/WH-00216'],
];

test('the desk is a short list: everything else is closed to support', () => {
  for (const [method, path] of CLOSED) assert.equal(supportDeskAllows(method, path), false, `${method} ${path}`);
  for (const [method, path] of OPEN) assert.equal(supportDeskAllows(method, path), true, `${method} ${path}`);
});

test('numbers and emails are masked', () => {
  assert.equal(maskPhone('+2347084266640'), '+234 708 *** 6640');
  assert.equal(maskPhone(null), null);
  assert.equal(maskPhone('+447700900123'), '+447 *** 0123');
  assert.equal(maskEmail('pheezzy27@gmail.com'), 'ph•••@gmail.com');
});

test('a support login is refused at the door with 403 outside the desk; staff and owners are not', async () => {
  const support = await admin('SUPPORT');
  const staff = await admin('STAFF');
  assert.equal(await supportDeskRefuses(req(support, 'GET', '/admin/fees/summary'), SECRET), true);
  assert.equal(await supportDeskRefuses(req(support, 'GET', '/admin/users/abc'), SECRET), true);
  assert.equal(await supportDeskRefuses(req(support, 'GET', '/admin/support/conversations'), SECRET), false);
  assert.equal(await supportDeskRefuses(req(staff, 'GET', '/admin/fees/summary'), SECRET), false);
  // And whichever route checks for itself, it is told no one is signed in.
  assert.equal(await verifyAdminAuth(req(support, 'GET', '/admin/insights/summary'), deps), null);
  assert.equal((await verifyAdminAuth(req(support, 'GET', '/admin/desk/people'), deps)).role, 'SUPPORT');
});

test('people and trips as support sees them: masked contact, no money; a full number is recorded', async () => {
  const support = await admin('SUPPORT');
  const supportId = made.admins[made.admins.length - 1];
  const phone = `+23470${Math.floor(10000000 + Math.random() * 89999999)}`;
  const rider = await prisma.user.create({ data: { privyDid: `did:test:${randomUUID()}`, role: 'RIDER', name: 'Desk Rider', phone, email: 'deskrider@example.com' } });
  const driverUser = await prisma.user.create({ data: { privyDid: `did:test:${randomUUID()}`, role: 'DRIVER', name: 'Desk Driver' } });
  made.users.push(rider.id, driverUser.id);
  const driver = await prisma.driver.create({ data: { userId: driverUser.id, kycStatus: 'APPROVED', vehicleMake: 'Toyota', vehicleModel: 'Corolla', vehiclePlate: 'LAG 123 XY' } });
  made.drivers.push(driver.id);
  const ride = await prisma.ride.create({ data: {
    riderId: rider.id, driverId: driver.id, status: 'COMPLETED', pickupLat: 6.5, pickupLng: 3.38, pickupAddress: 'Yaba', destLat: 6.45, destLng: 3.42, destAddress: 'Lekki',
    fareEstimateNgn: 9000, riderOfferNgn: 8800, agreedFareNgn: 8800, fareFinalNgn: 8800, platformFeeNgn: 1200, completedAt: new Date(),
  } });
  made.rides.push(ride.id);

  const found = await call(handleAdminDeskRoute, req(support, 'GET', `/admin/desk/people?q=${phone.slice(-7)}`));
  assert.equal(found.status, 200);
  const hit = found.body.people.find((p) => p.id === rider.id);
  assert.ok(hit, 'found by the last digits of their number');
  assert.notEqual(hit.phone, phone);
  assert.match(hit.phone, /\*\*\*/);

  const profile = await call(handleAdminDeskRoute, req(support, 'GET', `/admin/desk/people/${rider.id}`));
  assert.equal(profile.status, 200);
  assert.equal(profile.body.person.email, 'de•••@example.com');
  assert.equal(profile.body.trips[0].trip, `WH-${String(ride.tripNumber).padStart(5, '0')}`);
  assert.equal(profile.body.trips[0].driver.plate, 'LAG 123 XY');
  const text = JSON.stringify(profile.body);
  for (const money of ['8800', '9000', '1200', 'fare', 'Fare', 'wallet', 'balance', 'fee', 'bank', 'deposit']) {
    assert.ok(!text.includes(money), `no "${money}" in what support sees`);
  }
  assert.ok(!text.includes(phone), 'no full number');

  const trip = await call(handleAdminDeskRoute, req(support, 'GET', `/admin/desk/trips/WH-${ride.tripNumber}`));
  assert.equal(trip.status, 200);
  assert.equal(trip.body.trip.status, 'COMPLETED');
  assert.ok(!JSON.stringify(trip.body).includes('8800'));

  const shown = await call(handleAdminDeskRoute, req(support, 'POST', `/admin/desk/people/${rider.id}/phone`));
  assert.equal(shown.body.phone, phone);
  await new Promise((r) => setTimeout(r, 200));
  const recorded = await prisma.adminActivity.findFirst({ where: { adminId: supportId, kind: 'action' }, orderBy: { createdAt: 'desc' } });
  assert.equal(recorded?.detail?.what, 'showed a phone number');
  assert.equal(recorded?.detail?.userId, rider.id);
});
