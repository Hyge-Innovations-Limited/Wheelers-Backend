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
let rider, rider2, driverUser, driver, platformWalletId;

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
  const otherDriver = await prisma.driver.create({ data: { userId: otherDriverUser.id } });
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
  assert.deepEqual(transfer.map((r) => [r.label, r.amountNgn, r.direction]), [['Paystack transfer fee', 10, 'DEBIT']]);
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

test('EXCEL · the overview workbook has every sheet, formatted, with the filtered rows; phones only when asked; the fees workbook too', async () => {
  const res = await get(`/admin/insights/export?${q({ scope: 'overview' })}`, { raw: true });
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /spreadsheetml/);
  assert.match(res.headers['content-disposition'], /wheelers-overview-2024-03-04-to-2024-03-10\.xlsx/);
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(res.body);
  assert.deepEqual(book.worksheets.map((s) => s.name), ['Summary', 'Daily', 'Trips', 'Drivers', 'Riders', 'Fees', 'Fee ledger', 'Breakdown']);
  const trips = book.getWorksheet('Trips');
  assert.equal(trips.rowCount - 1, 6, 'one row per ride in the week');
  assert.equal(trips.getRow(1).font.bold, true);
  const headers = trips.getRow(1).values.filter(Boolean);
  assert.ok(!headers.includes('Rider phone'), 'no phone numbers unless asked');
  const summary = book.getWorksheet('Summary');
  const gmvRow = summary.getSheetValues().find((row) => row && row[1] === 'GMV (fares of completed trips)');
  assert.equal(gmvRow[2], 7800);

  const withPhones = await get(`/admin/insights/export?${q({ scope: 'overview', contacts: '1' })}`, { raw: true });
  const book2 = new ExcelJS.Workbook();
  await book2.xlsx.load(withPhones.body);
  assert.ok(book2.getWorksheet('Trips').getRow(1).values.includes('Rider phone'));

  const fees = await get(`/admin/insights/export?${q({ scope: 'fees' })}`, { raw: true });
  const book3 = new ExcelJS.Workbook();
  await book3.xlsx.load(fees.body);
  assert.deepEqual(book3.worksheets.map((s) => s.name), ['Summary', 'Fees', 'Fee ledger', 'Trips with fees']);
  assert.equal(book3.getWorksheet('Trips with fees').rowCount - 1, 3);
});
