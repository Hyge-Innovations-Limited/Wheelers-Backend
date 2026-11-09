// The analytics download as a zip: the workbook and the analyst's Power BI pack, from our own data,
// with exactly their 30 files and columns; no names or phones.
//
//   node scripts/run-with-env.cjs node --test --test-force-exit test/analytics-pack.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const { buildAnalyticsPack } = require('../apps/api-gateway/dist/analytics/pack.js');
const { zipFiles, crc32 } = require('../apps/api-gateway/dist/analytics/zip.js');

const prisma = new PrismaClient();
const headers = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'apps', 'api-gateway', 'analytics-pack', 'headers.json'), 'utf8'));
const DAY = '2021-03-03'; // a quiet day in the local database, far from other tests' rows
const made = { users: [], rides: [] };

test.after(async () => {
  await prisma.feedback.deleteMany({ where: { rideId: { in: made.rides } } });
  await prisma.driverBid.deleteMany({ where: { rideId: { in: made.rides } } });
  await prisma.ride.deleteMany({ where: { id: { in: made.rides } } });
  await prisma.driver.deleteMany({ where: { userId: { in: made.users } } });
  await prisma.wallet.deleteMany({ where: { userId: { in: made.users } } });
  await prisma.user.deleteMany({ where: { id: { in: made.users } } });
  await prisma.$disconnect();
});

async function person(role, name, phone) {
  const id = randomUUID();
  made.users.push(id);
  await prisma.user.create({ data: { id, privyDid: `local:${id}`, role, name, phone, createdAt: new Date(`${DAY}T06:00:00Z`) } });
  await prisma.wallet.create({ data: { userId: id, balanceNgn: 0 } });
  return id;
}

test('the pack: the analyst\'s 30 files with their exact columns, our rows in them, no names or phones', async () => {
  const rider = await person('RIDER', 'Adaeze Pack-Test', '+2348099990001');
  const driverUser = await person('DRIVER', 'Bayo Pack-Test', '+2348099990002');
  const driver = await prisma.driver.create({ data: { userId: driverUser, status: 'ONLINE', kycStatus: 'APPROVED', vehicleMake: 'Toyota', vehicleModel: 'Camry', vehiclePlate: 'PCK-123TT', vehicleYear: 2016 } });
  const at = (hhmm) => new Date(`${DAY}T${hhmm}:00+01:00`);
  const ride = await prisma.ride.create({ data: {
    riderId: rider, driverId: driver.id, status: 'COMPLETED', paymentMethod: 'CASH', channel: 'WHATSAPP',
    pickupLat: 6.5158, pickupLng: 3.3898, pickupAddress: 'Unilag', destLat: 6.5539, destLng: 3.388, destAddress: 'Onike',
    fareEstimateNgn: 3300, bookingSuggestedFareNgn: 3300, firstRiderOfferNgn: 3300, riderOfferNgn: 3500, riderOfferChanges: 1,
    agreedFareNgn: 3900, fareFinalNgn: 3900, distanceKm: 6.1, plannedDistanceKm: 6.1, durationSeconds: 1080,
    createdAt: at('08:00'), matchedAt: at('08:03'), arrivedAt: at('08:10'), startedAt: at('08:12'), completedAt: at('08:30'),
  } });
  made.rides.push(ride.id);
  const bid = await prisma.driverBid.create({ data: { rideId: ride.id, driverId: driver.id, driverUserId: driverUser, riderId: rider, amountNgn: 3900, etaSeconds: 300, status: 'ACCEPTED', createdAt: at('08:02'), resolvedAt: at('08:03') } });
  await prisma.feedback.create({ data: { rideId: ride.id, reviewerId: rider, reviewerRole: 'RIDER', revieweeId: driverUser, rating: 5 } });

  const pack = await buildAnalyticsPack({ from: DAY, to: DAY });
  const names = pack.files.map((f) => f.name);
  for (const file of Object.keys(headers)) {
    assert.ok(names.includes(`${file}.csv`), `${file}.csv is in the pack`);
    const text = pack.files.find((f) => f.name === `${file}.csv`).data;
    assert.equal(text.split('\n')[0], headers[file].join(','), `${file}: the analyst's columns, in order`);
  }
  assert.ok(names.includes('_relationships.csv') && names.includes('README_POWERBI.md') && names.includes('NOTES.md'));

  const read = (file) => {
    const [head, ...lines] = pack.files.find((f) => f.name === `${file}.csv`).data.trim().split('\n');
    const cols = head.split(',');
    return lines.map((l) => Object.fromEntries(l.split(',').map((v, i) => [cols[i], v])));
  };
  const trip = read('fact_trips').find((t) => t.trip_id === ride.id);
  assert.equal(trip.driver_id, driver.id);
  assert.equal(trip.offer_id, bid.id);
  assert.equal(trip.assigned_at, `${DAY} 08:03:00`, 'Lagos time');
  assert.equal(trip.quoted_eta_min, '5');
  assert.equal(trip.pickup_delay_min, '2', '7 minutes to arrive against a 5-minute ETA');
  assert.equal(trip.rider_wait_at_pickup_sec, '120');
  assert.equal(trip.actual_duration_min, '18');
  assert.equal(trip.agreed_vs_suggested_pct, '18.2');
  assert.equal(trip.final_payment_method_key, 'cash');
  assert.equal(trip.rider_rating_of_driver, '5');
  const session = read('fact_ride_sessions').find((s) => s.session_id === ride.id);
  assert.equal(session.session_outcome_key, 'completed');
  assert.equal(session.date_key, DAY.replace(/-/g, ''));
  assert.equal(session.hour_key, '8');
  assert.equal(session.time_to_first_offer_sec, '120');
  assert.equal(session.total_price_change_ngn, '200');
  assert.equal(read('fact_ride_intents').find((i) => i.intent_id === ride.id).channel_key, 'whatsapp');
  assert.equal(read('fact_ride_intents').find((i) => i.intent_id === ride.id).pickup_area_key, require('@wheleers/config').pricingAreaOf(6.5158, 3.3898).key, 'the pricing area of the pickup');
  assert.equal(read('fact_driver_offers').find((o) => o.offer_id === bid.id).offer_status_key, 'accepted');
  assert.equal(read('fact_payments').find((p) => p.trip_id === ride.id).payment_method_key, 'cash');
  assert.equal(read('dim_vehicle').find((v) => v.vehicle_id === driver.id).vehicle_age_years, String(new Date().getUTCFullYear() - 2016));
  assert.equal(read('dim_date').length, 1);
  assert.equal(read('dim_date')[0].weekday_name, 'Wednesday');

  const all = pack.files.map((f) => f.data).join('\n');
  for (const secret of ['Adaeze', 'Bayo', '2348099990001', '8099990002']) assert.equal(all.includes(secret), false, `${secret} is not in the pack`);
});

test('the zip opens: every file comes back byte for byte', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-zip-'));
  const files = [{ name: 'a.xlsx', data: Buffer.from([0, 1, 2, 255, 254]) }, { name: 'powerbi/dim_date.csv', data: 'date_key,date\n20210303,2021-03-03\n' }, { name: 'powerbi/NOTES.md', data: 'naira ₦ — ok\n' }];
  const zipPath = path.join(dir, 'x.zip');
  fs.writeFileSync(zipPath, zipFiles(files));
  const out = execFileSync('python3', ['-I', '-c', 'import sys,zipfile,json;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;print(json.dumps({n:z.read(n).hex() for n in z.namelist()}))', zipPath]).toString();
  const got = JSON.parse(out);
  for (const f of files) assert.equal(got[f.name], Buffer.from(f.data).toString('hex'), f.name);
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926, 'the standard CRC-32 check value');
});

test('the workbook holds the pack too: one sheet per table, named like its file, with its columns', async () => {
  const ExcelJS = require('exceljs');
  const { buildWorkbook } = require('../apps/api-gateway/dist/analytics/workbook.js');
  const f = { from: DAY, to: DAY, zone: null, channel: null, rideType: null, driverId: null, riderId: null };
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(await buildWorkbook('overview', f, 'day', false, true));
  for (const [file, columns] of Object.entries(headers)) {
    const sheet = book.getWorksheet(file);
    assert.ok(sheet, `sheet ${file}`);
    assert.deepEqual(sheet.getRow(1).values.slice(1), columns, `${file}: its columns`);
  }
  const trips = book.getWorksheet('fact_trips');
  const tripIds = [];
  trips.eachRow((row, n) => { if (n > 1) tripIds.push(row.getCell(1).value); });
  assert.ok(tripIds.includes(made.rides[0]), 'the test trip is a row');
  // Without raw sheets (raw=0), the pack is not added either.
  const lean = new ExcelJS.Workbook();
  await lean.xlsx.load(await buildWorkbook('overview', f, 'day', false, false));
  assert.equal(lean.getWorksheet('fact_trips'), undefined);
});

test('the Studio\'s numbers come from the same rows as the download', async () => {
  const { buildStudio } = require('../apps/api-gateway/dist/analytics/studio.js');
  const pack = await buildAnalyticsPack({ from: DAY, to: DAY });
  const studio = buildStudio(pack);
  const sessions = pack.tables.find((t) => t.name === 'fact_ride_sessions').rows;
  assert.equal(studio.totals.searches, sessions.length);
  assert.ok(studio.totals.completed >= 1);
  const funnel = Object.fromEntries(studio.demand.funnel.map((x) => [x.step, x.count]));
  assert.ok(funnel['Got an offer'] >= 1 && funnel.Matched >= 1 && funnel.Completed >= 1);
  assert.ok(funnel.Searched >= funnel['Got an offer'] && funnel['Got an offer'] >= funnel.Completed, 'a funnel only narrows');
  assert.ok((studio.offers.statusMix.accepted ?? 0) >= 1);
  assert.equal(studio.demand.byHour.length, 24);
  assert.equal(studio.demand.byDay.length, 1);
  assert.ok(studio.money.byDay[0].faresNgn >= 3900);
  assert.ok(studio.table.some((r) => r.session_id === made.rides[0] && r.agreed_ngn === 3900));
  assert.equal(JSON.stringify(studio).includes('Adaeze'), false, 'no names');
});
