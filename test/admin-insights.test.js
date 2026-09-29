// The admin Home analytics and Fees page (task A-08): seed a week of known rides,
// fees and money in an isolated past period, then check every endpoint, the
// reconciliation and the Excel workbook against numbers worked out by hand.
// Needs the local Postgres (docker) with migrations applied, and a built tree.

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const ExcelJS = require('exceljs');
const { PrismaClient } = require('@prisma/client');
const { zoneFor, splitPlatformTotal } = require('../packages/config/dist/index.js');
const { handleAdminInsightsRoute } = require('../apps/api-gateway/dist/http/admin-insights.route.js');

const prisma = new PrismaClient();
const PLATFORM_USER_ID = '00000000-0000-0000-0000-000000000001';
const DEPS = { adminApiKey: 'test-admin-key', jwtSecret: 'test-secret' };

// A week nobody else writes to: 4 to 10 March 2024 (Lagos days). The week before
// (26 Feb to 3 Mar) holds one completed ride, for the previous-period numbers.
const FROM = '2024-03-04';
const TO = '2024-03-10';
const lagos = (day, hh = 12, mm = 0) => new Date(`${day}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00+01:00`);

const YABA = { lat: 6.5158, lng: 3.3898 };        // Unilag, Akoka
const ISLAND = { lat: 6.4520, lng: 3.4380 };      // Ikoyi
const IKORODU = { lat: 6.5443, lng: 3.4896 };     // outside every zone

const seeded = { users: [], rides: [], wallets: [], transactions: [], withdrawals: [], reservations: [] };
let rider, rider2, driverUser, driver, otherDriver, idleDriver, platformWalletId;

async function user(name, role) {
  const u = await prisma.user.create({ data: { privyDid: `test:insights:${randomUUID()}`, name, role, phone: `+23480${Math.floor(Math.random() * 1e8)}` } });
  seeded.users.push(u.id);
  const w = await prisma.wallet.create({ data: { userId: u.id, balanceNgn: 0 } });
  seeded.wallets.push(w.id);
  return { ...u, walletId: w.id };
}

async function ride(data) {
  const id = randomUUID();
  const fare = data.fare ?? null;
  const settled = data.status === 'COMPLETED' && fare != null;
  const total = settled ? Math.min(fare, Math.round((fare * 0.04 + 405) * 100) / 100) : null;
  const split = settled ? splitPlatformTotal(total) : null;
  const r = await prisma.ride.create({
    data: {
      id,
      riderId: data.riderId ?? rider.id,
      driverId: data.driverId ?? (data.status === 'COMPLETED' ? driver.id : null),
      status: data.status,
      pickupLat: data.pickup.lat, pickupLng: data.pickup.lng, pickupAddress: data.pickupAddress ?? 'Pickup street',
      destLat: data.dest.lat, destLng: data.dest.lng, destAddress: 'Destination street',
      pickupZone: zoneFor(data.pickup.lat, data.pickup.lng), destZone: zoneFor(data.dest.lat, data.dest.lng),
      channel: data.channel,
      fareEstimateNgn: fare ?? 1000, riderOfferNgn: fare ?? 1000, agreedFareNgn: fare, fareFinalNgn: fare,
      platformFeeNgn: total, ...(split ?? {}),
      distanceKm: data.distanceKm ?? 5,
      cancelStage: data.cancelStage ?? null, cancelReason: data.cancelReason ?? null,
      createdAt: data.createdAt, completedAt: data.completedAt ?? null, cancelledAt: data.cancelledAt ?? null,
    },
  });
  seeded.rides.push(r.id);
  if (settled) {
    // What settlement writes: the rider pays the fare, the driver gets fare minus fees, the platform the fees.
    const at = data.completedAt;
    const rows = [
      { walletId: (data.riderId === rider2?.id ? rider2 : rider).walletId, type: 'RIDE_PAYMENT', direction: 'DEBIT', amountNgn: fare },
      { walletId: driverUser.walletId, type: 'DRIVER_PAYOUT', direction: 'CREDIT', amountNgn: fare - total },
      { walletId: platformWalletId, type: 'PLATFORM_FEE', direction: 'CREDIT', amountNgn: total, metadata: { kind: 'ride_fee', ...split } },
    ];
    for (const row of rows) {
      const t = await prisma.transaction.create({ data: { ...row, balanceAfterNgn: 0, referenceId: id, createdAt: at } });
      seeded.transactions.push(t.id);
    }
  }
  return r;
}

async function ledger(walletId, type, direction, amountNgn, createdAt, metadata) {
  const t = await prisma.transaction.create({ data: { walletId, type, direction, amountNgn, balanceAfterNgn: 0, referenceId: randomUUID(), createdAt, metadata } });
  seeded.transactions.push(t.id);
  return t;
}

/** Call the route the way the gateway does and return { status, body, headers }. */
async function get(path, { key = DEPS.adminApiKey, raw = false } = {}) {
  const url = new URL(path, 'http://localhost');
  const req = { method: 'GET', headers: key ? { 'x-admin-key': key } : {} };
  const headers = {};
  let body;
  const res = {
    statusCode: 0,
    setHeader(k, v) { headers[k.toLowerCase()] = v; },
    end(chunk) { body = chunk; },
  };
  const handled = await handleAdminInsightsRoute(req, res, DEPS, url);
  assert.equal(handled, true, `${path} was not handled`);
  return { status: res.statusCode, headers, body: raw ? body : JSON.parse(body) };
}
const q = (params) => new URLSearchParams({ from: FROM, to: TO, ...params }).toString();

test.before(async () => {
  console.log = console.info = console.warn = () => {};
  const platform = await prisma.wallet.findUnique({ where: { userId: PLATFORM_USER_ID } });
  if (!platform) {
    await prisma.user.upsert({ where: { id: PLATFORM_USER_ID }, update: {}, create: { id: PLATFORM_USER_ID, privyDid: 'platform:wheelers', name: 'Wheelers' } });
    platformWalletId = (await prisma.wallet.create({ data: { userId: PLATFORM_USER_ID } })).id;
  } else platformWalletId = platform.id;

  rider = await user('Insights Rider', 'RIDER');
  rider2 = await user('Second Rider', 'RIDER');
  driverUser = await user('Insights Driver', 'DRIVER');
  driver = await prisma.driver.create({ data: { userId: driverUser.id, kycStatus: 'APPROVED' } });
  // Users are dated into the week so "new users" is exact.
  await prisma.user.updateMany({ where: { id: { in: seeded.users } }, data: { createdAt: lagos('2024-03-04', 9) } });

  // In the week: three completed trips, one no-driver timeout, one rider cancel after a driver,
  // one superseded search (never counts), one still searching.
  const a = await ride({ status: 'COMPLETED', channel: 'WHATSAPP', pickup: YABA, dest: ISLAND, fare: 2500, createdAt: lagos('2024-03-04', 8), completedAt: lagos('2024-03-04', 9), distanceKm: 10 });
  await ride({ status: 'COMPLETED', channel: 'APP', pickup: ISLAND, dest: YABA, fare: 5000, createdAt: lagos('2024-03-05', 18), completedAt: lagos('2024-03-05', 19), distanceKm: 12 });
  // Completed at 00:30 Lagos on 7 March = 23:30 UTC on 6 March: must count on the 7th.
  await ride({ status: 'COMPLETED', channel: 'MCP', riderId: rider2.id, pickup: IKORODU, dest: YABA, fare: 300, createdAt: lagos('2024-03-06', 23, 50), completedAt: lagos('2024-03-07', 0, 30), distanceKm: 3 });
  await ride({ status: 'CANCELLED', channel: 'WHATSAPP', pickup: YABA, dest: IKORODU, cancelStage: 'BEFORE_MATCH', cancelReason: 'No driver accepted in time', createdAt: lagos('2024-03-08', 10), cancelledAt: lagos('2024-03-08', 10, 30) });
  await ride({ status: 'CANCELLED', channel: 'APP', pickup: ISLAND, dest: ISLAND, cancelStage: 'DRIVER_EN_ROUTE', cancelReason: 'Changed my mind', createdAt: lagos('2024-03-09', 7), cancelledAt: lagos('2024-03-09', 7, 10) });
  await ride({ status: 'CANCELLED', channel: 'WHATSAPP', pickup: YABA, dest: ISLAND, cancelStage: 'BEFORE_MATCH', cancelReason: 'Replaced by a newer request', createdAt: lagos('2024-03-09', 8), cancelledAt: lagos('2024-03-09', 8, 1) });
  await ride({ status: 'MATCHING', channel: 'WHATSAPP', pickup: YABA, dest: YABA, createdAt: lagos('2024-03-10', 20) });
  // The week before: one completed trip.
  await ride({ status: 'COMPLETED', channel: 'APP', pickup: YABA, dest: YABA, fare: 1000, createdAt: lagos('2024-03-01', 8), completedAt: lagos('2024-03-01', 9) });

  // Bids on ride A: two drivers bid, one won.
  const otherDriverUser = await user('Other Driver', 'DRIVER');
  otherDriver = await prisma.driver.create({ data: { userId: otherDriverUser.id } });

  // Shifts, in Lagos time. The main driver: 9.5 hours inside the week.
  const shift = (driverId, startedAt, endedAt, endReason = 'manual') =>
    prisma.driverShift.create({ data: { driverId, startedAt, endedAt, endReason: endedAt ? endReason : null } });
  await shift(driver.id, lagos('2024-03-03', 22), lagos('2024-03-04', 1));        // began before the week: only 00:00 to 01:00 counts
  await shift(driver.id, lagos('2024-03-04', 7), lagos('2024-03-04', 11));        // 4 h
  await shift(driver.id, lagos('2024-03-05', 17, 30), lagos('2024-03-05', 20));   // 2.5 h
  await shift(driver.id, lagos('2024-03-06', 23), lagos('2024-03-07', 1));        // 2 h, across midnight
  // The other driver's shift was never closed (a dead phone). They were last heard from
  // at 11:57, so it runs to 12:00 and no further: 2 h, not until today.
  await prisma.driver.update({ where: { id: otherDriver.id }, data: { status: 'ONLINE', lastSeenAt: lagos('2024-03-09', 11, 57) } });
  await shift(otherDriver.id, lagos('2024-03-09', 10), null);
  // A driver who was on for an hour and got nothing: no trip, no bid.
  const idleUser = await user('Idle Driver', 'DRIVER');
  idleDriver = await prisma.driver.create({ data: { userId: idleUser.id, kycStatus: 'APPROVED' } });
  await shift(idleDriver.id, lagos('2024-03-04', 8), lagos('2024-03-04', 9));     // 1 h
  await prisma.driverBid.create({ data: { rideId: a.id, driverId: driver.id, driverUserId: driverUser.id, riderId: rider.id, amountNgn: 2500, etaSeconds: 300, distanceKm: 1, status: 'ACCEPTED', createdAt: lagos('2024-03-04', 8, 1) } });
  await prisma.driverBid.create({ data: { rideId: a.id, driverId: otherDriver.id, driverUserId: otherDriverUser.id, riderId: rider.id, amountNgn: 2700, etaSeconds: 400, distanceKm: 2, status: 'LOST', createdAt: lagos('2024-03-04', 8, 3) } });

  // Money outside rides: two deposits (₦30 fee each, Paystack's fee absorbed on one), one withdrawal with its transfer fee.
  await ledger(rider.walletId, 'DEPOSIT', 'CREDIT', 4970, lagos('2024-03-05', 10), { grossAmountNgn: 5000 });
  await ledger(platformWalletId, 'PLATFORM_FEE', 'CREDIT', 30, lagos('2024-03-05', 10), { kind: 'deposit_fee' });
  await ledger(rider2.walletId, 'DEPOSIT', 'CREDIT', 1970, lagos('2024-03-06', 10), { grossAmountNgn: 2000 });
  await ledger(platformWalletId, 'PLATFORM_FEE', 'CREDIT', 30, lagos('2024-03-06', 10), { kind: 'deposit_fee' });
  await ledger(platformWalletId, 'PROVIDER_FEE', 'DEBIT', 20, lagos('2024-03-06', 10), { kind: 'deposit_provider_fee' });
  const withdrawalId = randomUUID();
  const reservation = await prisma.walletReservation.create({
    data: { walletId: driverUser.walletId, userId: driverUser.id, kind: 'WITHDRAWAL', status: 'CONSUMED', amountNgn: 3000, referenceId: withdrawalId },
  });
  seeded.reservations.push(reservation.id);
  const w = await prisma.withdrawalRequest.create({
    data: { id: withdrawalId, userId: driverUser.id, walletId: driverUser.walletId, reservationId: reservation.id, status: 'SETTLED',
      requestedAmountNgn: 3000, reservedAmountNgn: 3000, providerFeeNgn: 10, bankAccountNumber: '0000000000',
      bankAccountName: 'Insights Driver', bankNetworkId: 'test', createdAt: lagos('2024-03-08', 11), settledAt: lagos('2024-03-08', 11, 5) },
  });
  seeded.withdrawals.push(w.id);
  const wt = await prisma.transaction.create({ data: { walletId: driverUser.walletId, type: 'WITHDRAWAL', direction: 'DEBIT', amountNgn: 3000, balanceAfterNgn: 0, referenceId: w.id, createdAt: lagos('2024-03-08', 11, 5) } });
  seeded.transactions.push(wt.id);
  await ledger(platformWalletId, 'PROVIDER_FEE', 'DEBIT', 10, lagos('2024-03-08', 11, 5), { kind: 'transfer_fee' });
});

test.after(async () => {
  await prisma.transaction.deleteMany({ where: { id: { in: seeded.transactions } } });
  await prisma.withdrawalRequest.deleteMany({ where: { id: { in: seeded.withdrawals } } }).catch(() => undefined);
  await prisma.walletReservation.deleteMany({ where: { id: { in: seeded.reservations } } }).catch(() => undefined);
  await prisma.driverBid.deleteMany({ where: { rideId: { in: seeded.rides } } });
  await prisma.driverShift.deleteMany({ where: { driver: { userId: { in: seeded.users } } } });
  await prisma.rideStop.deleteMany({ where: { rideId: { in: seeded.rides } } }).catch(() => undefined);
  await prisma.ride.deleteMany({ where: { id: { in: seeded.rides } } });
  await prisma.driver.deleteMany({ where: { userId: { in: seeded.users } } });
  await prisma.wallet.deleteMany({ where: { id: { in: seeded.wallets } } });
  await prisma.user.deleteMany({ where: { id: { in: seeded.users } } });
  await prisma.$disconnect();
});

// Fees by hand: 2500 → 100 + 375 + 30 = 505; 5000 → 200 + 375 + 30 = 605; 300 is too small to carry them, so
// the platform takes the whole 300: 30 levy, 270 service, 0 commission.
const COMMISSION = 100 + 200 + 0;
const SERVICE = 375 + 375 + 270;
const LEVY = 30 + 30 + 30;

test('SUMMARY · a week counted by hand: requests, trips, cancels by kind, GMV, fees, bids, money, people', async () => {
  const { status, body } = await get(`/admin/insights/summary?${q({})}`);
  assert.equal(status, 200);
  const k = body.current;
  assert.equal(k.requests, 6, 'the superseded search never counts');
  assert.equal(k.completed, 3, 'the 00:30 completion counts on its Lagos day, inside the week');
  assert.deepEqual([k.cancelled, k.cancelledNoDriver, k.cancelledBeforeMatch, k.cancelledAfterMatch], [2, 1, 0, 1]);
  assert.equal(k.matchRate, 0.5);
  assert.equal(k.gmvNgn, 7800);
  assert.equal(k.medianFareNgn, 2500);
  assert.deepEqual([k.commissionNgn, k.serviceFeeNgn, k.stateLevyNgn], [COMMISSION, SERVICE, LEVY]);
  assert.equal(k.depositFeesNgn, 60);
  assert.equal(k.platformRevenueNgn, COMMISSION + SERVICE + 60, 'the levy is owed to Lagos, not revenue');
  assert.equal(k.driverPayoutsNgn, 7800 - (COMMISSION + SERVICE + LEVY));
  assert.deepEqual([k.activeDrivers, k.activeRiders], [1, 2]);
  assert.deepEqual([k.ridesWithBids, k.ridesWithAcceptedBid, k.bidAcceptanceRate, k.avgBidsPerRide, k.medianSecondsToFirstBid], [1, 1, 1, 2, 60]);
  assert.deepEqual([k.depositsNgn, k.depositCount, k.withdrawalsNgn, k.withdrawalCount], [6940, 2, 3000, 1]);
  assert.equal(k.newUsers, 3, "the three people dated into the week; the other driver joined today");
  assert.deepEqual(body.previous, { from: '2024-02-26', to: '2024-03-03' });
  assert.equal(body.previousKpis.completed, 1);
  assert.equal(body.previousKpis.gmvNgn, 1000);
});

test('FILTERS · zone matches rides that start or end there; channel and ride type narrow; bad input is refused', async () => {
  const yaba = (await get(`/admin/insights/summary?${q({ zone: 'Yaba' })}`)).body.current;
  assert.equal(yaba.requests, 5, 'every ride but the Ikoyi-to-Ikoyi cancel touches Yaba');
  const island = (await get(`/admin/insights/summary?${q({ zone: 'Lagos Island' })}`)).body.current;
  assert.equal(island.completed, 2);
  const outside = (await get(`/admin/insights/summary?${q({ zone: 'outside' })}`)).body.current;
  assert.equal(outside.requests, 0, 'no ride in the week both starts and ends outside the zones');
  const mcp = (await get(`/admin/insights/summary?${q({ channel: 'MCP' })}`)).body.current;
  assert.deepEqual([mcp.completed, mcp.gmvNgn], [1, 300]);
  assert.equal((await get(`/admin/insights/summary?${q({ rideType: 'group' })}`)).body.current.requests, 0);
  assert.equal((await get(`/admin/insights/summary?${q({ riderId: rider2.id })}`)).body.current.completed, 1);
  assert.equal((await get(`/admin/insights/summary?${q({ zone: 'Lekki' })}`)).status, 400);
  assert.equal((await get(`/admin/insights/summary?from=2024-03-10&to=2024-03-01`)).status, 400);
  assert.equal((await get(`/admin/insights/summary?${q({})}`, { key: 'wrong' })).status, 401);
});

test('TIMESERIES · Lagos days, with week and month buckets that add up to the days', async () => {
  const days = (await get(`/admin/insights/timeseries?${q({ bucket: 'day' })}`)).body.points;
  assert.equal(days.length, 7);
  assert.deepEqual(days.map((p) => p.completed), [1, 1, 0, 1, 0, 0, 0]);
  assert.equal(days.find((p) => p.bucket === '2024-03-07').gmvNgn, 300);
  const weeks = (await get(`/admin/insights/timeseries?${q({ bucket: 'week' })}`)).body.points;
  assert.equal(weeks.length, 1, '4 March 2024 is a Monday');
  assert.equal(weeks[0].completed, 3);
  assert.equal(weeks[0].commissionNgn, COMMISSION);
});

test('BREAKDOWN · by channel, zone, ride type and cancellation', async () => {
  const byChannel = Object.fromEntries((await get(`/admin/insights/breakdown?${q({ by: 'channel' })}`)).body.rows.map((r) => [r.key, r]));
  assert.deepEqual([byChannel.WHATSAPP.requests, byChannel.APP.requests, byChannel.MCP.requests], [3, 2, 1]);
  assert.equal(byChannel.APP.label, 'App');
  const byZone = Object.fromEntries((await get(`/admin/insights/breakdown?${q({ by: 'zone' })}`)).body.rows.map((r) => [r.key, r]));
  assert.equal(byZone.outside.label, 'Outside launch zones');
  assert.equal(byZone.outside.completed, 1);
  const cancels = (await get(`/admin/insights/breakdown?${q({ by: 'cancelReason' })}`)).body.rows;
  assert.deepEqual(cancels.map((r) => [r.key, r.cancelled]).sort(), [['after_match', 1], ['no_driver', 1]]);
});

test('TABLES · trips sort, search and page; drivers and riders roll up the week', async () => {
  const completed = (await get(`/admin/insights/trips?${q({ status: 'completed', sort: 'fare', dir: 'desc' })}`)).body;
  assert.equal(completed.total, 3);
  assert.deepEqual(completed.items.map((t) => t.fareNgn), [5000, 2500, 300]);
  const small = completed.items[2];
  assert.deepEqual([small.commissionNgn, small.serviceFeeNgn, small.stateLevyNgn, small.driverPayoutNgn], [0, 270, 30, 0]);
  assert.equal(completed.items[1].bids, 2);
  const paged = (await get(`/admin/insights/trips?${q({ limit: '2', offset: '2' })}`)).body;
  assert.deepEqual([paged.total, paged.items.length, paged.hasMore], [6, 2, true]);
  assert.equal((await get(`/admin/insights/trips?${q({ q: 'Second Rider' })}`)).body.total, 1);
  assert.equal((await get(`/admin/insights/trips?${q({ status: 'no_driver' })}`)).body.total, 1);

  const drivers = (await get(`/admin/insights/drivers?${q({})}`)).body.items;
  const mine = drivers.find((d) => d.driverId === driver.id);
  assert.deepEqual([mine.trips, mine.gmvNgn, mine.bids, mine.bidsWon, mine.bidWinRate], [3, 7800, 1, 1, 1]);
  assert.ok(drivers.some((d) => d.name === 'Other Driver' && d.trips === 0 && d.bids === 1), 'a driver who only bid still shows');
  assert.deepEqual([mine.onlineHours, mine.shifts, mine.tripsPerOnlineHour], [9.5, 4, 0.32], '3 trips in 9.5 hours on shift');
  assert.equal(mine.lastOnlineAt, lagos('2024-03-07', 1).toISOString());

  const riders = (await get(`/admin/insights/riders?${q({ sort: 'spend' })}`)).body.items;
  const first = riders.find((r) => r.riderId === rider.id);
  assert.deepEqual([first.requests, first.trips, first.cancelled, first.spendNgn], [5, 2, 2, 7500]);
});

test('FEES · income, the levy as a pass-through, Paystack costs, net; the ledger lists every fee row', async () => {
  const fees = (await get(`/admin/fees/summary?${q({ bucket: 'day' })}`)).body;
  const t = fees.totals;
  assert.deepEqual([t.commissionNgn, t.serviceFeeNgn, t.depositFeesNgn, t.incomeNgn], [COMMISSION, SERVICE, 60, COMMISSION + SERVICE + 60]);
  assert.equal(t.stateLevyNgn, LEVY);
  assert.deepEqual([t.depositProviderCostNgn, t.transferCostNgn, t.costsNgn], [20, 10, 30]);
  assert.equal(t.netNgn, COMMISSION + SERVICE + 60 - 30);
  assert.deepEqual([t.feeRides, t.deposits, t.transfers], [3, 2, 1]);
  assert.equal(fees.points.length, 7);
  const ledgerRows = (await get(`/admin/fees/ledger?${q({})}`)).body;
  assert.equal(ledgerRows.total, 3 + 2 + 2, 'three ride fees, two deposit fees, two Paystack costs');
  const transfer = (await get(`/admin/fees/ledger?${q({ kind: 'transfer_fee' })}`)).body.items;
  assert.deepEqual(transfer.map((r) => [r.label, r.amountNgn, r.direction]), [['Platform withdrawal cost', 10, 'DEBIT']]);
});

test('DEPOSITS AND WITHDRAWALS · the money people moved, with the fee and the platform\'s cost on each', async () => {
  const dep = (await get(`/admin/fees/deposits?${q({ sort: 'amount', dir: 'desc' })}`)).body;
  const mine = dep.items.filter((d) => [rider.id, rider2.id].includes(d.userId));
  assert.deepEqual(mine.map((d) => [d.name, d.grossNgn, d.creditedNgn]), [['Insights Rider', 5000, 4970], ['Second Rider', 2000, 1970]]);
  assert.equal((await get(`/admin/fees/deposits?${q({ q: 'Second Rider' })}`)).body.total, 1);
  const wd = (await get(`/admin/fees/withdrawals?${q({})}`)).body.items.filter((w) => w.userId === driverUser.id);
  assert.deepEqual(wd.map((w) => [w.status, w.amountNgn, w.transferFeeNgn, w.accountEnding]), [['SETTLED', 3000, 10, '0000']]);
});

test('RECONCILE · every headline total agrees with the ledger when the money is right, and flags it when it is not', async () => {
  let checks = (await get(`/admin/insights/reconcile?${q({})}`)).body.checks;
  for (const c of checks) assert.equal(c.ok, true, `${c.label}: ${c.left.value} vs ${c.right.value}`);
  // Break one ledger row: the fee check must catch it.
  const fee = await prisma.transaction.findFirst({ where: { id: { in: seeded.transactions }, type: 'PLATFORM_FEE', metadata: { path: ['kind'], equals: 'ride_fee' } } });
  await prisma.transaction.update({ where: { id: fee.id }, data: { amountNgn: Number(fee.amountNgn) + 1 } });
  checks = (await get(`/admin/insights/reconcile?${q({})}`)).body.checks;
  assert.equal(checks.find((c) => c.key === 'fees').ok, false);
  assert.equal(checks.find((c) => c.key === 'fees').diff, -1);
  await prisma.transaction.update({ where: { id: fee.id }, data: { amountNgn: fee.amountNgn } });
});

test('RIDE FILTERS · deposits and Paystack costs belong to no ride, so a channel view shows only its own rides\' fees', async () => {
  // Claude had one trip in the week: ₦300, too small for the flat fees, so ₦270 service fee and ₦30 levy.
  const k = (await get(`/admin/insights/summary?${q({ channel: 'MCP' })}`)).body.current;
  assert.equal(k.platformRevenueNgn, 270, 'no deposit fees in a channel\'s revenue');
  const fees = (await get(`/admin/fees/summary?${q({ channel: 'MCP', bucket: 'day' })}`)).body;
  assert.equal(fees.rideFiltersApplied, true);
  const t = fees.totals;
  assert.deepEqual([t.depositFeesNgn, t.depositProviderCostNgn, t.transferCostNgn, t.costsNgn], [0, 0, 0, 0]);
  assert.deepEqual([t.incomeNgn, t.netNgn, t.stateLevyNgn], [270, 270, 30]);
  const ledgerRows = (await get(`/admin/fees/ledger?${q({ channel: 'MCP' })}`)).body.items;
  assert.deepEqual(ledgerRows.map((r) => [r.kind, r.amountNgn]), [['ride_fee', 300]]);
  // With no ride filter, the deposit fees are back.
  assert.equal((await get(`/admin/fees/summary?${q({ bucket: 'day' })}`)).body.rideFiltersApplied, false);
});

test('EXCEL · the overview workbook has every sheet, formatted, with the filtered rows; phones only when asked; the fees workbook too', async () => {
  const res = await get(`/admin/insights/export?${q({ scope: 'overview' })}`, { raw: true });
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /spreadsheetml/);
  assert.match(res.headers['content-disposition'], /wheelers-overview-2024-03-04-to-2024-03-10\.xlsx/);
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(res.body);
  assert.deepEqual(book.worksheets.map((s) => s.name), ['Summary', 'Daily', 'Hours', 'Weekdays', 'Hours by weekday', 'Trips', 'Calls', 'Drivers', 'Riders', 'Fees', 'Fee ledger', 'Deposits', 'Withdrawals', 'Breakdown']);
  const trips = book.getWorksheet('Trips');
  assert.equal(trips.rowCount - 1, 6, 'one row per ride in the week');
  assert.equal(trips.getRow(1).font.bold, true);
  const headers = trips.getRow(1).values.filter(Boolean);
  assert.ok(!headers.includes('Rider phone'), 'no phone numbers unless asked');
  const summary = book.getWorksheet('Summary');
  const gmvRow = summary.getSheetValues().find((row) => row && row[1] === 'GMV (fares of completed trips)');
  assert.equal(gmvRow[2], 7800);
  const hoursRow = summary.getSheetValues().find((row) => row && row[1] === 'Driver hours online');
  assert.equal(hoursRow[2], 12.5);
  const hoursSheet = book.getWorksheet('Hours');
  assert.equal(hoursSheet.getRow(1).values.filter(Boolean)[0], 'Hour (Lagos)');
  const eight = hoursSheet.getSheetValues().find((row) => row && row[1] === '08:00 to 08:59');
  assert.deepEqual([eight[2], eight[3], eight[8]], [1, 1, 2], 'one request at 8, completed, and two driver hours');
  assert.ok(book.getWorksheet('Drivers').getRow(1).values.includes('Hours online'));
  assert.equal(book.getWorksheet('Hours by weekday').rowCount - 1, 7);

  const withPhones = await get(`/admin/insights/export?${q({ scope: 'overview', contacts: '1' })}`, { raw: true });
  const book2 = new ExcelJS.Workbook();
  await book2.xlsx.load(withPhones.body);
  assert.ok(book2.getWorksheet('Trips').getRow(1).values.includes('Rider phone'));

  const fees = await get(`/admin/insights/export?${q({ scope: 'fees' })}`, { raw: true });
  const book3 = new ExcelJS.Workbook();
  await book3.xlsx.load(fees.body);
  assert.deepEqual(book3.worksheets.map((s) => s.name), ['Summary', 'Fees', 'Fee ledger', 'Deposits', 'Withdrawals', 'Trips with fees']);
  assert.equal(book3.getWorksheet('Trips with fees').rowCount - 1, 3);
});

test('HOURS ONLINE · shifts clipped to the week, an open shift ending when its driver was last heard from', async () => {
  const k = (await get(`/admin/insights/summary?${q({})}`)).body;
  // 1 + 4 + 2.5 + 2 for the main driver, 2 for the open shift, 1 for the idle driver.
  assert.deepEqual([k.current.driverOnlineHours, k.current.driversOnShift, k.current.avgOnlineHoursPerDriver], [12.5, 3, 4.17]);
  assert.equal(k.current.tripsPerOnlineHour, 0.24, '3 trips in 12.5 hours');
  assert.equal(k.previousKpis.driverOnlineHours, 2, 'the week before holds the two hours before midnight of the first shift');
  assert.equal(k.snapshot.shiftsRecordedFrom, lagos('2024-03-03', 22).toISOString());

  const one = (await get(`/admin/insights/summary?${q({ driverId: driver.id })}`)).body.current;
  assert.deepEqual([one.driverOnlineHours, one.driversOnShift], [9.5, 1], 'a driver filter narrows the hours');

  // A shift belongs to no ride: a channel cannot narrow it, so it is not set beside that channel's trips.
  const whatsapp = (await get(`/admin/insights/summary?${q({ channel: 'WHATSAPP' })}`)).body.current;
  assert.equal(whatsapp.driverOnlineHours, 12.5);
  assert.equal(whatsapp.tripsPerOnlineHour, null);

  const drivers = (await get(`/admin/insights/drivers?${q({ sort: 'onlineHours', dir: 'desc' })}`)).body.items;
  assert.deepEqual(drivers.slice(0, 3).map((d) => [d.name, d.onlineHours]), [['Insights Driver', 9.5], ['Other Driver', 2], ['Idle Driver', 1]]);
  const idle = drivers.find((d) => d.driverId === idleDriver.id);
  assert.deepEqual([idle.trips, idle.bids, idle.tripsPerOnlineHour], [0, 0, 0], 'on shift and got nothing: the driver to look at');
  const inZone = (await get(`/admin/insights/drivers?${q({ zone: 'Yaba' })}`)).body.items;
  assert.ok(!inZone.some((d) => d.driverId === idleDriver.id), 'under a zone filter only drivers with rides or bids there are listed');
});

test('BUSIEST HOURS · requests by Lagos hour and weekday, beside the drivers who were on', async () => {
  const { status, body } = await get(`/admin/insights/hours?${q({})}`);
  assert.equal(status, 200);
  assert.equal(body.hours.length, 24);
  assert.equal(body.weekdays.length, 7);
  const at = (hour) => body.hours[hour];
  assert.equal(body.hours.reduce((n, h) => n + h.requests, 0), 6, 'every request once; the superseded search never');
  assert.deepEqual([at(8).requests, at(8).completed, at(8).matchRate, at(8).gmvNgn], [1, 1, 1, 2500]);
  assert.deepEqual([at(10).requests, at(10).noDriver], [1, 1]);
  assert.deepEqual([at(23).requests, at(23).completed], [1, 1], '23:50 Lagos is hour 23, though it is 22:50 UTC');
  assert.equal(at(3).requests, 0);

  // Driver hours inside each hour of the day, over the week.
  assert.equal(at(8).driverHours, 2, 'the main driver and the idle one, Monday 8 to 9');
  assert.equal(at(0).driverHours, 2, 'Monday and Thursday, midnight to 1');
  assert.equal(at(17).driverHours, 0.5, 'a shift that began at 17:30');
  assert.equal(at(11).driverHours, 1, 'the open shift, which ends at 12:00');
  assert.equal(at(12).driverHours, 0);
  assert.equal(Math.round(body.hours.reduce((n, h) => n + h.driverHours, 0) * 100) / 100, 12.5, 'the hours add up to the total');
  // Seven days in the week, so seven "8 o'clock"s: 2 driver hours over 7.
  assert.equal(at(8).avgDriversOnline, 0.29);
  assert.equal(at(8).requestsPerDriver, 0.5, 'one request for two drivers');
  assert.equal(at(20).requestsPerDriver, null, 'a request at 20:00 with nobody on shift has no ratio');

  const monday = body.weekdays[0];
  assert.deepEqual([monday.label, monday.requests, monday.driverHours, monday.avgDriversOnline], ['Monday', 1, 6, 0.25]);
  assert.equal(body.grid[0][8], 1, 'Monday, 8');
  assert.equal(body.grid[5][7], 1, 'Saturday, 7');
  assert.equal(body.grid[5][8], 0, 'the superseded Saturday search is not there');
  assert.equal(body.peakWeekday, 1);
  assert.deepEqual(body.supply, { shown: true, recordedFrom: lagos('2024-03-03', 22).toISOString() });

  const app = (await get(`/admin/insights/hours?${q({ channel: 'APP' })}`)).body;
  assert.equal(app.hours.reduce((n, h) => n + h.requests, 0), 2);
  assert.equal(app.supply.shown, false);
  assert.ok(app.hours.every((h) => h.avgDriversOnline === null && h.requestsPerDriver === null));

  const mine = (await get(`/admin/insights/hours?${q({ driverId: driver.id })}`)).body;
  assert.equal(mine.hours[8].driverHours, 1, 'a driver filter narrows the shifts too');
});

test('EXCEL TRIPS · the team\'s layout: trip ID, clean names, plain status, times, amounts, negotiation, messages to book', async () => {
  // A week of its own, so the counts above are untouched: 6 to 12 May 2024.
  const WEEK = { from: '2024-05-06', to: '2024-05-12' };
  const at = (day, hh, mm = 0) => lagos(day, hh, mm);
  const king = await prisma.user.create({ data: { privyDid: 'whatsapp:+2348031235678', name: '𝐾𝐼𝑁𝐺🌸', role: 'RIDER', phone: '+2348031235678' } });
  seeded.users.push(king.id);
  const kingWallet = await prisma.wallet.create({ data: { userId: king.id } });
  seeded.wallets.push(kingWallet.id);
  const events = [];
  const say = async (when) => {
    const e = await prisma.userActivityEvent.create({ data: { userId: king.id, eventType: 'whatsapp_message_in', source: 'whatsapp', dedupKey: `t:${randomUUID()}`, occurredAt: when, createdAt: when } });
    events.push(e.id);
  };

  // Messages are logged from before any of these trips: the counts are real, not "not logged yet".
  await say(at('2024-05-06', 5, 50));
  // An earlier trip that ended at 07:00; the messages before it ended do not count toward the next.
  const earlier = await ride({ status: 'COMPLETED', channel: 'WHATSAPP', riderId: king.id, pickup: YABA, dest: ISLAND, fare: 3000, createdAt: at('2024-05-06', 6), completedAt: at('2024-05-06', 7) });
  await say(at('2024-05-06', 6, 10));
  await say(at('2024-05-06', 6, 20));
  // The trip: three messages to book it, one more after the driver was booked (not counted).
  await say(at('2024-05-06', 7, 55));
  await say(at('2024-05-06', 7, 58));
  await say(at('2024-05-06', 8, 2));
  const trip = await ride({ status: 'COMPLETED', channel: 'WHATSAPP', riderId: king.id, pickup: YABA, dest: ISLAND, fare: 4000, createdAt: at('2024-05-06', 8), completedAt: at('2024-05-06', 8, 40) });
  await prisma.ride.update({ where: { id: trip.id }, data: { matchedAt: at('2024-05-06', 8, 5), startedAt: at('2024-05-06', 8, 10), fareEstimateNgn: 4500, riderOfferNgn: 3800, agreedFareNgn: 4000 } });
  await say(at('2024-05-06', 8, 20));
  // One that found nobody, after midnight Lagos time.
  await say(at('2024-05-07', 23, 50));
  const lonely = await ride({ status: 'CANCELLED', channel: 'WHATSAPP', riderId: king.id, pickup: YABA, dest: IKORODU, cancelStage: 'BEFORE_MATCH', cancelReason: 'No driver accepted in time', createdAt: at('2024-05-07', 23, 55), cancelledAt: at('2024-05-08', 0, 5) });
  // An App booking has no message count.
  const app = await ride({ status: 'CANCELLED', channel: 'APP', riderId: king.id, pickup: ISLAND, dest: ISLAND, cancelStage: 'BEFORE_MATCH', cancelReason: 'Changed my mind  🙃', createdAt: at('2024-05-09', 12), cancelledAt: at('2024-05-09', 12, 3) });
  seeded.events = events;

  try {
    const res = await get(`/admin/insights/export?${new URLSearchParams({ ...WEEK, scope: 'overview' })}`, { raw: true });
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(res.body);
    const sheet = book.getWorksheet('Trips');
    const headers = sheet.getRow(1).values.filter(Boolean);
    assert.deepEqual(headers.slice(0, 19), [
      'Trip ID', 'Rider', 'Date', 'Status', 'Rider ID', 'Platform ID', 'From', 'Platform', 'To', 'Book time', 'Start trip time',
      'End trip time', 'Suggested amount', 'Rider offered', 'Amount agreed', 'Time to negotiate', 'Messages to book', 'Driver', 'Driver ID',
    ]);
    const col = (name) => headers.indexOf(name) + 1;
    const rowFor = (rideId) => {
      for (let i = 2; i <= sheet.rowCount; i += 1) if (sheet.getRow(i).getCell(col('Ride ID')).value === rideId) return sheet.getRow(i);
      return null;
    };
    const cell = (row, name) => row.getCell(col(name)).value;

    const r = rowFor(trip.id);
    const tripNumber = (await prisma.ride.findUnique({ where: { id: trip.id } })).tripNumber;
    assert.equal(cell(r, 'Trip ID'), `WH-${String(tripNumber).padStart(5, '0')}`);
    assert.equal(cell(r, 'Rider'), 'King', 'styled letters and the flower are cleaned');
    assert.deepEqual([cell(r, 'Date'), cell(r, 'Status'), cell(r, 'Rider ID'), cell(r, 'Platform ID'), cell(r, 'Platform')],
      ['2024-05-06', 'Completed', king.id, '••••5678', 'WhatsApp'], 'the number is masked without "include phone numbers"');
    assert.deepEqual([cell(r, 'Book time'), cell(r, 'Start trip time'), cell(r, 'End trip time')], ['08:00', '08:10', '08:40']);
    assert.deepEqual([cell(r, 'Suggested amount'), cell(r, 'Rider offered'), cell(r, 'Amount agreed')], [4500, 3800, 4000]);
    // A duration is a fraction of a day; read back, Excel's epoch (30 Dec 1899) turns it into a date.
    const asSeconds = (v) => (v instanceof Date ? (v.getTime() - Date.UTC(1899, 11, 30)) / 1000 : v * 86_400);
    assert.equal(Math.round(asSeconds(cell(r, 'Time to negotiate'))), 300, 'five minutes, request to driver');
    assert.match(sheet.getRow(1).getCell(col('Messages to book')).note?.texts?.[0]?.text ?? String(sheet.getRow(1).getCell(col('Messages to book')).note), /previous trip ended/, 'the header explains it');
    assert.equal(r.getCell(col('Time to negotiate')).numFmt, '[m]:ss');
    assert.equal(cell(r, 'Messages to book'), 3, 'after the previous trip ended, before this one got a driver');

    const e = rowFor(earlier.id);
    assert.equal(cell(e, 'Messages to book'), 3, 'the first trip counts from the rider\'s first message');

    const l = rowFor(lonely.id);
    assert.deepEqual([cell(l, 'Status'), cell(l, 'Date'), cell(l, 'End trip time')], ['No driver found', '2024-05-07', '2024-05-08 00:05'], 'an end on another day carries its date');
    assert.equal(cell(l, 'Messages to book'), 1, 'up to the moment it ended without a driver');
    assert.equal(cell(l, 'Time to negotiate'), null);

    const a = rowFor(app.id);
    assert.deepEqual([cell(a, 'Platform'), cell(a, 'Platform ID'), cell(a, 'Messages to book'), cell(a, 'Cancel reason')], ['App', '', null, 'Changed my mind'], 'no message count for an App booking');

    const withPhones = await get(`/admin/insights/export?${new URLSearchParams({ ...WEEK, scope: 'overview', contacts: '1' })}`, { raw: true });
    const book2 = new ExcelJS.Workbook();
    await book2.xlsx.load(withPhones.body);
    const s2 = book2.getWorksheet('Trips');
    const h2 = s2.getRow(1).values.filter(Boolean);
    const rows2 = s2.getSheetValues().filter(Boolean).slice(1);
    const found = rows2.find((row) => row[h2.indexOf('Ride ID') + 1] === trip.id);
    assert.equal(found[h2.indexOf('Platform ID') + 1], '+2348031235678', 'the whole number when phones are asked for');

    const riders = book.getWorksheet('Riders');
    const rh = riders.getRow(1).values.filter(Boolean);
    const kingRow = riders.getSheetValues().filter(Boolean).find((row) => row[rh.indexOf('Rider ID') + 1] === king.id);
    assert.equal(kingRow[rh.indexOf('Name') + 1], 'King');
    assert.equal(kingRow[rh.indexOf('WhatsApp messages') + 1], 8);
    assert.equal(kingRow[rh.indexOf('Messages per trip') + 1], 4, 'eight messages, two trips');

    const search = (await get(`/admin/insights/trips?${new URLSearchParams({ ...WEEK, q: `wh-${tripNumber}` })}`)).body;
    assert.deepEqual(search.items.map((t) => t.id), [trip.id], 'the trips table finds a trip by its ID');
  } finally {
    await prisma.userActivityEvent.deleteMany({ where: { id: { in: events } } });
  }
});

test('EXCEL TRIP ACTIVITY · chat, calls, the trip code and Stellar per trip; a Calls sheet and a Stellar sheet with explorer links', async () => {
  // A week of its own: 13 to 19 May 2024.
  const WEEK = { from: '2024-05-13', to: '2024-05-19' };
  const at = (day, hh, mm = 0) => lagos(day, hh, mm);
  const long = await ride({ status: 'COMPLETED', channel: 'WHATSAPP', pickup: YABA, dest: ISLAND, fare: 20000, createdAt: at('2024-05-14', 9), completedAt: at('2024-05-14', 14, 5) });
  await prisma.ride.update({ where: { id: long.id }, data: {
    startedAt: at('2024-05-14', 10), tripCode: '4821', tripCodeWrongTries: 2, tripCodeUnlockedBy: 'Support Ada', tripCodeUnlockedAt: at('2024-05-14', 9, 58),
  } });
  const short = await ride({ status: 'COMPLETED', channel: 'APP', pickup: YABA, dest: ISLAND, fare: 3000, createdAt: at('2024-05-15', 9), completedAt: at('2024-05-15', 9, 40) });
  await prisma.ride.update({ where: { id: short.id }, data: { startedAt: at('2024-05-15', 9, 10), tripCode: '1111', tripCodeVerifiedAt: at('2024-05-15', 9, 10) } });

  const rows = { chat: [], calls: [], stellar: [] };
  const chat = async (senderId, senderRole, kind = 'text') => rows.chat.push((await prisma.chatMessage.create({ data: { rideId: long.id, senderId, senderRole, content: 'hi', kind, createdAt: at('2024-05-14', 9, 30) } })).id);
  await chat(rider.id, 'RIDER');
  await chat(rider.id, 'RIDER');
  await chat(driver.userId, 'DRIVER');
  await chat(driver.userId, 'DRIVER', 'call');   // a call line is not a message
  const call = async (data) => rows.calls.push((await prisma.tripCall.create({ data: { rideId: long.id, callerId: driver.userId, callerRole: 'DRIVER', calleeId: rider.id, ...data } })).id);
  await call({ calleeChannel: 'whatsapp', status: 'MISSED', endReason: 'no_answer', createdAt: at('2024-05-14', 9, 40), endedAt: at('2024-05-14', 9, 41) });
  await call({ calleeChannel: 'whatsapp', status: 'COMPLETED', endReason: 'hung_up', createdAt: at('2024-05-14', 9, 45), answeredAt: at('2024-05-14', 9, 45), endedAt: at('2024-05-14', 9, 46, 35), durationSeconds: 95 });
  const hash = (c) => c.repeat(64);
  const transfer = async (data) => rows.stellar.push((await prisma.stellarTransfer.create({ data: { fromPublicKey: `G${'A'.repeat(55)}`, toPublicKey: `G${'B'.repeat(55)}`, status: 'CONFIRMED', createdAt: at('2024-05-14', 14, 6), ...data } })).id);
  await transfer({ kind: 'FARE', reference: `fare:${long.id}`, rideId: long.id, amountXlm: 20, amountNgn: 20000, memo: 'WH-TEST', txHash: hash('a') });
  await transfer({ kind: 'COMMISSION', reference: `commission:${long.id}`, rideId: long.id, amountXlm: 1.205, amountNgn: 1205, memo: 'WH-TEST', txHash: hash('b') });
  await transfer({ kind: 'TOPUP', reference: `topup:excel-${long.id}`, amountXlm: 5, amountNgn: 5000, txHash: hash('c'), createdAt: at('2024-05-13', 8) });

  try {
    const res = await get(`/admin/insights/export?${new URLSearchParams({ ...WEEK, scope: 'overview' })}`, { raw: true });
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(res.body);
    const sheet = book.getWorksheet('Trips');
    const headers = sheet.getRow(1).values.filter(Boolean);
    const col = (name) => headers.indexOf(name) + 1;
    const rowFor = (rideId) => {
      for (let i = 2; i <= sheet.rowCount; i += 1) if (sheet.getRow(i).getCell(col('Ride ID')).value === rideId) return sheet.getRow(i);
      return null;
    };
    const cell = (row, name) => row.getCell(col(name)).value;

    const l = rowFor(long.id);
    assert.equal(cell(l, 'Long trip (3h+)'), 'yes', 'four hours from start to end');
    assert.deepEqual([cell(l, 'Chat: rider messages'), cell(l, 'Chat: driver messages')], [2, 1], 'call lines are not messages');
    assert.deepEqual([cell(l, 'Calls'), cell(l, 'Calls answered'), cell(l, 'Calls missed'), cell(l, 'Call minutes')], [2, 1, 1, 1.6]);
    assert.deepEqual([cell(l, 'Trip code'), cell(l, 'Wrong codes'), cell(l, 'Unlocked by')], ['Unlocked by support', 2, 'Support Ada']);
    assert.deepEqual(cell(l, 'Stellar fare tx'), { text: `${hash('a').slice(0, 10)}…`, hyperlink: `https://stellar.expert/explorer/testnet/tx/${hash('a')}` });
    assert.equal(cell(l, 'Stellar commission tx').hyperlink, `https://stellar.expert/explorer/testnet/tx/${hash('b')}`);

    const s = rowFor(short.id);
    assert.deepEqual([cell(s, 'Long trip (3h+)'), cell(s, 'Trip code'), cell(s, 'Calls'), cell(s, 'Stellar fare tx')], ['', 'Entered', 0, '']);

    const calls = book.getWorksheet('Calls');
    const ch = calls.getRow(1).values.filter(Boolean);
    const callRows = calls.getSheetValues().filter(Boolean).slice(1).filter((r) => r[ch.indexOf('Caller') + 1]);
    assert.equal(callRows.length, 2);
    assert.deepEqual(callRows.map((r) => [r[ch.indexOf('Caller') + 1], r[ch.indexOf('Rung on') + 1], r[ch.indexOf('Outcome') + 1]]),
      [['Driver', 'WhatsApp', 'Missed'], ['Driver', 'WhatsApp', 'Talked']]);

    const stellar = book.getWorksheet('Stellar');
    const sh = stellar.getRow(1).values.filter(Boolean);
    const stellarRows = stellar.getSheetValues().filter(Boolean).slice(1).filter((r) => r[sh.indexOf('Kind') + 1]);
    assert.deepEqual(stellarRows.map((r) => r[sh.indexOf('Kind') + 1]), ['Top-up', 'Trip fare', 'Commission'], 'every transfer in the week, oldest first');
    assert.ok(stellarRows.every((r) => r[sh.indexOf('Transaction') + 1]?.hyperlink?.startsWith('https://stellar.expert/explorer/testnet/tx/')));
  } finally {
    await prisma.stellarTransfer.deleteMany({ where: { id: { in: rows.stellar } } });
    await prisma.tripCall.deleteMany({ where: { id: { in: rows.calls } } });
    await prisma.chatMessage.deleteMany({ where: { id: { in: rows.chat } } });
  }
});
