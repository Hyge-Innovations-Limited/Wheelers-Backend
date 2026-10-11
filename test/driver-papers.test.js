// A driver's papers: their name as on the licence, and the papers for the car
// (hackney permit, vehicle licence, roadworthiness or VIO, insurance, whose
// car it is). Each paper is sent one at a time as a photo or PDF; one that
// runs out carries its date and is refused when already expired. Any one of a
// few papers can meet a need. Nothing here touches verification itself.
// Against the local Postgres, with files kept in memory.
//
//   node scripts/run-with-env.cjs node --test --test-force-exit test/driver-papers.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { prisma } = require('@wheleers/db');
const local = require('../apps/api-gateway/dist/auth/local.js');
const { handleDriverPapersRoute, driverPapersView, parseDay, lagosToday } = require('../apps/api-gateway/dist/http/driver-papers.route.js');

const SECRET = 'test-secret-for-the-driver-papers-screens';
const stored = [];
const storage = { upload: async ({ driverId, type, imageBuffer, mimeType }) => { const key = `mem/${driverId}/${type}-${stored.length}`; stored.push({ key, bytes: imageBuffer.length, mimeType }); return key; } };
const made = { users: [] };
let server; let base;

const jpeg = (size = 2000) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(size, 7)]).toString('base64');
const pdf = () => Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(2000, 32)]).toString('base64');
const inDays = (n) => new Date(lagosToday().getTime() + n * 86_400_000).toISOString().slice(0, 10);

async function driver() {
  const user = await prisma.user.create({ data: { privyDid: `did:test:${randomUUID()}`, role: 'DRIVER', name: 'Papers Driver' } });
  made.users.push(user.id);
  const row = await prisma.driver.create({ data: { userId: user.id, kycStatus: 'APPROVED' } });
  return { id: row.id, token: local.createLocalAccessToken(user.id, SECRET, 3600) };
}

const call = async (token, method, path, body) => {
  const res = await fetch(base + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, body: await res.json() };
};
const need = (view, key) => view.needs.find((n) => n.key === key);
const paper = (view, type) => view.needs.flatMap((n) => n.papers).find((p) => p.type === type);

test.before(async () => {
  server = http.createServer((req, res) => {
    void handleDriverPapersRoute(req, res, { jwtSecret: SECRET, kycStorage: storage }, new URL(req.url, 'http://x')).then((handled) => {
      if (!handled) { res.statusCode = 404; res.end('{}'); }
    });
  });
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test('a driver with nothing sent sees every need, which are required, and six things to do', async () => {
  const d = await driver();
  assert.equal((await call(null, 'GET', '/drivers/papers')).status, 401);
  const { status, body } = await call(d.token, 'GET', '/drivers/papers');
  assert.equal(status, 200);
  assert.deepEqual(body.needs.map((n) => [n.key, n.required, n.state]), [
    ['hackney', true, 'missing'], ['vehicleLicence', true, 'missing'], ['roadworthy', true, 'missing'],
    ['insurance', true, 'missing'], ['ownership', true, 'missing'], ['lagos', false, 'missing'],
  ]);
  assert.deepEqual(need(body, 'ownership').papers.map((p) => p.type), ['proofOfOwnership', 'purchaseReceipt', 'ownerLetter'], 'three ways to show whose car it is');
  assert.deepEqual(need(body, 'roadworthy').papers.map((p) => p.type), ['roadworthiness', 'vioInspection']);
  assert.equal(body.details.complete, false);
  assert.equal(body.toDo, 6, 'five required papers and the details');
});

test('the name is taken as it is on the licence, with the licence number and a date that has not passed', async () => {
  const d = await driver();
  const put = (details) => call(d.token, 'PUT', '/drivers/papers/details', details);
  const good = { legalName: '  Adebayo   Tunde Okafor ', licenceNumber: 'abc 12345 de67', licenceExpiresOn: inDays(400) };

  assert.equal((await put({ ...good, legalName: 'Tunde' })).body.code, 'BAD_NAME', 'one name is not a full name');
  assert.equal((await put({ ...good, legalName: 'Tunde 08012345678' })).body.code, 'BAD_NAME');
  assert.equal((await put({ ...good, licenceNumber: 'AB1' })).body.code, 'BAD_LICENCE_NUMBER');
  assert.equal((await put({ ...good, licenceExpiresOn: '31/12/2027' })).body.code, 'BAD_DATE');
  assert.equal((await put({ ...good, licenceExpiresOn: '2027-02-30' })).body.code, 'BAD_DATE', 'not a real day');
  assert.equal((await put({ ...good, licenceExpiresOn: inDays(-1) })).body.code, 'EXPIRED');

  const saved = await put(good);
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.details, { legalName: 'Adebayo Tunde Okafor', licenceNumber: 'ABC12345DE67', licenceExpiresOn: inDays(400), licenceExpired: false, complete: true });
  assert.equal(saved.body.toDo, 5);
  const row = await prisma.driver.findUnique({ where: { id: d.id } });
  assert.equal(row.legalName, 'Adebayo Tunde Okafor');
  assert.equal(row.kycStatus, 'APPROVED', 'verification itself is untouched');
  assert.equal((await put({ ...good, legalName: "Chidinma O'Neil-Eze" })).status, 200, 'apostrophes and hyphens are names too');
});

test('a paper is a photo or a PDF; one that runs out needs its date, and an expired one is refused', async () => {
  const d = await driver();
  const send = (body) => call(d.token, 'POST', '/drivers/papers', body);

  assert.equal((await send({ type: 'spaceship', file: jpeg() })).body.code, 'UNKNOWN_PAPER');
  assert.equal((await send({ type: 'insurance', file: Buffer.from('hello').toString('base64'), expiresOn: inDays(200) })).body.code, 'BAD_FILE');
  assert.equal((await send({ type: 'insurance', file: Buffer.alloc(3000, 65).toString('base64'), expiresOn: inDays(200) })).body.code, 'BAD_FILE', 'not a photo or a PDF');
  assert.equal((await send({ type: 'insurance', file: jpeg() })).body.code, 'BAD_DATE', 'insurance runs out: the date is asked for');
  const expired = await send({ type: 'insurance', file: jpeg(), expiresOn: inDays(-3) });
  assert.equal(expired.body.code, 'EXPIRED');
  assert.match(expired.body.error, /insurance has expired/);
  assert.equal((await send({ type: 'insurance', file: jpeg(), expiresOn: '2099-01-01' })).body.code, 'BAD_DATE', 'a date too far away is a typing slip');

  const before = stored.length;
  const sent = await send({ type: 'insurance', file: pdf(), expiresOn: inDays(200), number: '  POL/2026/00123  ' });
  assert.equal(sent.status, 200);
  assert.equal(stored.length, before + 1);
  assert.equal(stored.at(-1).mimeType, 'application/pdf');
  const insurance = paper(sent.body, 'insurance');
  assert.deepEqual([insurance.document.state, insurance.document.number, insurance.document.expiresOn, insurance.document.expiringSoon], ['waiting', 'POL/2026/00123', inDays(200), false]);
  assert.equal(need(sent.body, 'insurance').state, 'waiting');
  assert.equal(sent.body.toDo, 5, 'four papers and the details left');

  // A paper that does not run out needs no date; a number is kept only where the paper has one.
  const owned = await send({ type: 'proofOfOwnership', file: jpeg(), number: 'ignored' });
  assert.equal(owned.status, 200);
  assert.equal(paper(owned.body, 'proofOfOwnership').document.number, null);
  assert.equal(paper(owned.body, 'proofOfOwnership').document.expiresOn, null);
});

test('any one of the papers for a need meets it: a driver who does not own the car sends the owner\'s letter', async () => {
  const d = await driver();
  const view = (await call(d.token, 'POST', '/drivers/papers', { type: 'ownerLetter', file: jpeg() })).body;
  assert.equal(need(view, 'ownership').state, 'waiting');
  assert.equal(paper(view, 'proofOfOwnership').document, null, 'the other two are not asked for');
  const vio = (await call(d.token, 'POST', '/drivers/papers', { type: 'vioInspection', file: jpeg(), expiresOn: inDays(90) })).body;
  assert.equal(need(vio, 'roadworthy').state, 'waiting', 'the VIO report stands in for the roadworthiness certificate');
  assert.equal(vio.toDo, 4);
});

test('how a paper stands: approved, sent back with the reason, running out soon, and expired; sending it again starts it over', async () => {
  const d = await driver();
  const today = lagosToday();
  const days = (n) => new Date(today.getTime() + n * 86_400_000);
  await prisma.driverDocument.createMany({ data: [
    { driverId: d.id, type: 'hackneyPermit', fileKey: 'k1', fileType: 'image/jpeg', expiresOn: days(200), status: 'APPROVED', reviewedAt: new Date(), reviewedBy: 'Ada' },
    { driverId: d.id, type: 'vehicleLicence', fileKey: 'k2', fileType: 'image/jpeg', expiresOn: days(12), status: 'APPROVED' },
    { driverId: d.id, type: 'insurance', fileKey: 'k3', fileType: 'image/jpeg', expiresOn: days(-2), status: 'APPROVED' },
    { driverId: d.id, type: 'roadworthiness', fileKey: 'k4', fileType: 'image/jpeg', expiresOn: days(100), status: 'REJECTED', rejectionReason: 'The photo is cut off at the top.' },
    { driverId: d.id, type: 'vioInspection', fileKey: 'k5', fileType: 'image/jpeg', expiresOn: days(100), status: 'APPROVED' },
  ] });
  const view = await driverPapersView(d.id);
  assert.equal(need(view, 'hackney').state, 'approved');
  assert.deepEqual([paper(view, 'vehicleLicence').document.state, paper(view, 'vehicleLicence').document.expiringSoon, paper(view, 'vehicleLicence').document.daysLeft], ['approved', true, 12]);
  assert.deepEqual(view.expiringSoon, ['Vehicle licence']);
  assert.equal(need(view, 'insurance').state, 'expired', 'approved once, but past its date: a new one is needed');
  assert.equal(paper(view, 'roadworthiness').document.rejectionReason, 'The photo is cut off at the top.');
  assert.equal(need(view, 'roadworthy').state, 'approved', 'the approved VIO report carries the need although the certificate was sent back');
  assert.equal(view.toDo, 3, 'insurance, whose car it is, and the details');

  // The new insurance replaces the expired one and waits for review again.
  const again = (await call(d.token, 'POST', '/drivers/papers', { type: 'insurance', file: jpeg(), expiresOn: inDays(365) })).body;
  assert.equal(paper(again, 'insurance').document.state, 'waiting');
  const rows = await prisma.driverDocument.findMany({ where: { driverId: d.id, type: 'insurance' } });
  assert.equal(rows.length, 1, 'one row for each kind of paper');
  assert.equal(rows[0].status, 'PENDING');
  assert.notEqual(rows[0].fileKey, 'k3');
  // Sending the rejected certificate again clears the reason.
  const fixed = (await call(d.token, 'POST', '/drivers/papers', { type: 'roadworthiness', file: jpeg(), expiresOn: inDays(100) })).body;
  assert.equal(paper(fixed, 'roadworthiness').document.rejectionReason, null);
});

test('dates: only a real YYYY-MM-DD is a day, and today is Lagos\'s today', () => {
  assert.equal(parseDay('2027-03-31').toISOString(), '2027-03-31T00:00:00.000Z');
  assert.equal(parseDay('2027-3-31'), null);
  assert.equal(parseDay('2027-13-01'), null);
  assert.equal(parseDay(20270331), null);
  assert.equal(lagosToday(new Date('2026-10-13T23:30:00Z')).toISOString(), '2026-10-14T00:00:00.000Z', 'half past midnight in Lagos is already tomorrow');
});

test('with storage switched off papers can be read, not sent', async () => {
  const d = await driver();
  const off = http.createServer((req, res) => { void handleDriverPapersRoute(req, res, { jwtSecret: SECRET, kycStorage: null }, new URL(req.url, 'http://x')); });
  await new Promise((resolve) => off.listen(0, resolve));
  const at = `http://127.0.0.1:${off.address().port}/drivers/papers`;
  const headers = { authorization: `Bearer ${d.token}`, 'content-type': 'application/json' };
  assert.equal((await fetch(at, { headers })).status, 200);
  const sent = await fetch(at, { method: 'POST', headers, body: JSON.stringify({ type: 'proofOfOwnership', file: jpeg() }) });
  assert.equal(sent.status, 503);
  await new Promise((resolve) => off.close(resolve));
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  const drivers = await prisma.driver.findMany({ where: { userId: { in: made.users } }, select: { id: true } });
  await prisma.driverDocument.deleteMany({ where: { driverId: { in: drivers.map((d) => d.id) } } });
  await prisma.userActivityEvent.deleteMany({ where: { userId: { in: made.users } } }).catch(() => {});
  await prisma.driver.deleteMany({ where: { userId: { in: made.users } } });
  await prisma.user.deleteMany({ where: { id: { in: made.users } } });
  await prisma.$disconnect();
});
