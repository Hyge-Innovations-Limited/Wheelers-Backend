// A5: raw one-row-per-item sheets in the owners' Excel (always; raw=0 leaves them out). Totals tie to Home.
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const ExcelJS = require('exceljs');
const { PrismaClient } = require('@prisma/client');
const { handleAdminInsightsRoute } = require('../apps/api-gateway/dist/http/admin-insights.route.js');

const prisma = new PrismaClient();
const DEPS = { adminApiKey: 'test-admin-key', jwtSecret: 'test-secret' };
const FROM = '2024-06-03';
const TO = '2024-06-09';
const lagos = (day, hh = 12, mm = 0) => new Date(`${day}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00+01:00`);
const made = { users: [], rides: [], wallets: [] };
let rider, driverUser, driver;

async function user(name, role) {
  const u = await prisma.user.create({ data: { privyDid: `test:raw:${randomUUID()}`, name, role, phone: `+23481${Math.floor(1e7 + Math.random() * 9e7)}` } });
  made.users.push(u.id);
  made.wallets.push((await prisma.wallet.create({ data: { userId: u.id, balanceNgn: 0 } })).id);
  return u;
}
async function ride(d) {
  const id = randomUUID();
  made.rides.push(id);
  return prisma.ride.create({ data: {
    id, riderId: rider.id, driverId: d.driverId ?? null, status: d.status, channel: d.channel ?? 'WHATSAPP',
    pickupLat: 6.5158, pickupLng: 3.3898, pickupAddress: 'A', destLat: 6.452, destLng: 3.438, destAddress: 'B',
    pickupZone: 'Yaba', destZone: 'Island', fareEstimateNgn: 3000, riderOfferNgn: d.offer ?? 3000, firstRiderOfferNgn: d.first ?? null,
    riderOfferChanges: d.changes ?? 0, agreedFareNgn: d.fare ?? null, fareFinalNgn: d.fare ?? null, distanceKm: 8,
    cancelStage: d.stage ?? null, cancelReason: d.reason ?? null, cancelledBy: d.by ?? null,
    createdAt: d.createdAt, completedAt: d.completedAt ?? null, cancelledAt: d.cancelledAt ?? null,
  } });
}
async function get(path, raw) {
  const url = new URL(path, 'http://localhost');
  const headers = {}; let body;
  const res = { statusCode: 0, setHeader(k, v) { headers[k.toLowerCase()] = v; }, end(c) { body = c; } };
  await handleAdminInsightsRoute({ method: 'GET', headers: { 'x-admin-key': DEPS.adminApiKey } }, res, DEPS, url);
  return { status: res.statusCode, body: raw ? body : JSON.parse(body) };
}
const q = (p = {}) => new URLSearchParams({ from: FROM, to: TO, ...p }).toString();
const rowsOf = (sheet) => sheet.getSheetValues().filter(Boolean).slice(1).filter((r) => r.length > 1 && r[1] !== undefined);

test.before(async () => {
  console.log = console.info = console.warn = () => {};
  rider = await user('Raw Rider', 'RIDER');
  driverUser = await user('Raw Driver', 'DRIVER');
  driver = await prisma.driver.create({ data: { userId: driverUser.id, kycStatus: 'APPROVED', vehicleMake: 'Toyota', vehicleModel: 'Corolla', vehicleYear: 2012 } });
  await prisma.driverShift.create({ data: { driverId: driver.id, startedAt: lagos('2024-06-03', 7), endedAt: lagos('2024-06-03', 12), endReason: 'manual' } });
  await ride({ status: 'COMPLETED', driverId: driver.id, fare: 2500, createdAt: lagos('2024-06-03', 8), completedAt: lagos('2024-06-03', 9) });
  await ride({ status: 'COMPLETED', driverId: driver.id, fare: 2000, createdAt: lagos('2024-06-05', 8), completedAt: lagos('2024-06-05', 9) });
  await ride({ status: 'CANCELLED', reason: 'No driver accepted in time', stage: 'BEFORE_MATCH', by: 'system', first: 2000, offer: 2500, changes: 2, createdAt: lagos('2024-06-03', 8, 30), cancelledAt: lagos('2024-06-03', 8, 40) });
  await ride({ status: 'CANCELLED', reason: 'Changed my mind', stage: 'DRIVER_EN_ROUTE', by: 'rider', driverId: driver.id, createdAt: lagos('2024-06-04', 10), cancelledAt: lagos('2024-06-04', 10, 12) });
  await ride({ status: 'CANCELLED', reason: 'Too long', stage: 'BEFORE_MATCH', createdAt: lagos('2024-06-06', 22), cancelledAt: lagos('2024-06-06', 22, 5) });
});
test.after(async () => {
  await prisma.ride.deleteMany({ where: { id: { in: made.rides } } });
  await prisma.driverShift.deleteMany({ where: { driverId: driver.id } });
  await prisma.driver.deleteMany({ where: { userId: { in: made.users } } });
  await prisma.wallet.deleteMany({ where: { id: { in: made.wallets } } });
  await prisma.user.deleteMany({ where: { id: { in: made.users } } });
  await prisma.$disconnect();
});

test('RAW SHEETS · in every export unless raw=0; rows tie to Home; names on every row; phones only with contacts=1', async () => {
  const plain = new ExcelJS.Workbook();
  await plain.xlsx.load((await get(`/admin/insights/export?${q({ scope: 'overview', raw: '0' })}`, true)).body);
  assert.ok(!plain.getWorksheet('Lost requests') && !plain.getWorksheet('Cancels') && !plain.getWorksheet('Prices'), 'left out with raw=0');
  const byDefault = new ExcelJS.Workbook();
  await byDefault.xlsx.load((await get(`/admin/insights/export?${q({ scope: 'overview' })}`, true)).body);
  assert.ok(byDefault.getWorksheet('Lost requests') && byDefault.getWorksheet('Cancels') && byDefault.getWorksheet('Prices'), 'the Download button gets them');

  const home = (await get(`/admin/insights/summary?${q()}`)).body.current;
  const book = new ExcelJS.Workbook();
  await book.xlsx.load((await get(`/admin/insights/export?${q({ scope: 'overview', raw: '1' })}`, true)).body);
  const head = (name) => book.getWorksheet(name).getRow(1).values.filter(Boolean);
  const cell = (name, row, h) => row[head(name).indexOf(h) + 1];

  const cancels = rowsOf(book.getWorksheet('Cancels')).filter((r) => typeof r[1] === 'string' && r[1].length === 36);
  assert.equal(cancels.length, home.cancelled, 'cancel rows = Home cancelled');
  assert.equal(cancels.length, 3);
  assert.deepEqual(cancels.map((r) => cell('Cancels', r, 'Who cancelled')).filter(Boolean).sort(), ['rider', 'system']);
  assert.ok(cancels.every((r) => cell('Cancels', r, 'Rider') === 'Raw Rider'));
  const enRoute = cancels.find((r) => cell('Cancels', r, 'Reason') === 'Changed my mind');
  assert.equal(cell('Cancels', enRoute, 'Driver'), 'Raw Driver');
  assert.equal(cell('Cancels', enRoute, 'Minutes since request'), 12);
  assert.ok(!head('Cancels').includes('Rider phone'));

  const lost = rowsOf(book.getWorksheet('Lost requests')).filter((r) => typeof r[1] === 'string' && r[1].length === 36);
  assert.equal(lost.length, home.cancelledNoDriver + home.cancelledBeforeMatch, 'lost rows = Home no-driver + before-match');
  const timeout = lost.find((r) => cell('Lost requests', r, 'How it ended') === 'No driver accepted in time');
  assert.equal(cell('Lost requests', timeout, 'Drivers on shift that hour'), 1, 'the driver was on shift 07:00 to 12:00 on the 3rd');
});

test('RAW SHEETS · prices, drivers and riders', async () => {
  const home = (await get(`/admin/insights/summary?${q()}`)).body.current;
  const book = new ExcelJS.Workbook();
  await book.xlsx.load((await get(`/admin/insights/export?${q({ scope: 'overview', raw: '1', contacts: '1' })}`, true)).body);
  const head = (name) => book.getWorksheet(name).getRow(1).values.filter(Boolean);
  const rows = (name) => rowsOf(book.getWorksheet(name)).filter((r) => typeof r[1] === 'string' && r[1].length === 36);
  const prices = rows('Prices');
  assert.equal(prices.length, home.requests, 'price rows = Home requests');
  const p = prices.find((r) => r[head('Prices').indexOf('Rider price changes') + 1] === 2);
  assert.equal(p[head('Prices').indexOf('First rider price') + 1], 2000);

  const dh = head('Drivers');
  const d = book.getWorksheet('Drivers').getSheetValues().filter(Boolean).find((r) => r[dh.indexOf('Driver ID') + 1] === driver.id);
  assert.equal(d[dh.indexOf('Car') + 1], 'Toyota Corolla 2012');
  assert.equal(d[dh.indexOf('Tank (litres)') + 1], 50);
  assert.equal(d[dh.indexOf('Cancels') + 1], 1);
  assert.equal(d[dh.indexOf('Earnings per online hour') + 1], 0, 'no fee split seeded, so no earnings; five hours online');
  assert.ok(dh.includes('Phone'));

  const rh = head('Riders');
  const r = book.getWorksheet('Riders').getSheetValues().filter(Boolean).find((x) => x[rh.indexOf('Rider ID') + 1] === rider.id);
  assert.equal(r[rh.indexOf('Came back') + 1], 'Yes');
  assert.ok(r[rh.indexOf('First ride (Lagos)') + 1].startsWith('2024-06-03'));
  assert.ok(r[rh.indexOf('Last ride (Lagos)') + 1].startsWith('2024-06-05'));
});
