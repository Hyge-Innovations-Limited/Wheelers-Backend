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
const { handleAdminDriverPapersRoute } = require('../apps/api-gateway/dist/http/admin-driver-papers.route.js');
const { handleDriverKycSubmitRoute } = require('../apps/api-gateway/dist/http/driver-kyc.route.js');
const { reminderDue, sendPaperReminders } = require('../apps/api-gateway/dist/drivers/paper-notify.js');
const { assertDriverApproved } = require('../apps/api-gateway/dist/rides/driver-kyc-gate.js');

const SECRET = 'test-secret-for-the-driver-papers-screens';
const stored = [];
const told = [];
const publisher = { publishNotificationEvent: async (event) => { told.push(event); } };
const storage = { getSignedUrl: async (key) => `https://files.test/${key}`, upload: async ({ driverId, type, imageBuffer, mimeType }) => { const key = `mem/${driverId}/${type}-${stored.length}`; stored.push({ key, bytes: imageBuffer.length, mimeType }); return key; } };
const made = { users: [], admins: [] };
let server; let base;

const jpeg = (size = 2000) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(size, 7)]).toString('base64');
const pdf = () => Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(2000, 32)]).toString('base64');
const inDays = (n) => new Date(lagosToday().getTime() + n * 86_400_000).toISOString().slice(0, 10);

async function driver() {
  const user = await prisma.user.create({ data: { privyDid: `did:test:${randomUUID()}`, role: 'DRIVER', name: 'Papers Driver' } });
  made.users.push(user.id);
  const row = await prisma.driver.create({ data: { userId: user.id, kycStatus: 'APPROVED' } });
  return { id: row.id, userId: user.id, token: local.createLocalAccessToken(user.id, SECRET, 3600) };
}

async function admin(role = 'STAFF') {
  const row = await prisma.adminUser.create({ data: { username: `papers-${randomUUID().slice(0, 8)}`, passwordHash: 'x', name: 'Ada Reviewer', role } });
  made.admins.push(row.id);
  return local.createLocalAccessToken(row.id, SECRET, 3600);
}

const call = async (token, method, path, body) => {
  const res = await fetch(base + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, body: await res.json() };
};
const need = (view, key) => view.needs.find((n) => n.key === key);
const paper = (view, type) => view.needs.flatMap((n) => n.papers).find((p) => p.type === type);

test.before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    void (async () => {
      if (url.pathname === '/drivers/kyc/submit') return handleDriverKycSubmitRoute(req, res, { jwtSecret: SECRET, kycStorage: storage });
      if (await handleDriverPapersRoute(req, res, { jwtSecret: SECRET, kycStorage: storage }, url)) return;
      if (await handleAdminDriverPapersRoute(req, res, { adminApiKey: 'unused-key', jwtSecret: SECRET, kycStorage: storage, publisher }, url)) return;
      res.statusCode = 404; res.end('{}');
    })();
  });
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test('a driver with nothing sent sees every need, all of them required, and seven things to do', async () => {
  const d = await driver();
  assert.equal((await call(null, 'GET', '/drivers/papers')).status, 401);
  const { status, body } = await call(d.token, 'GET', '/drivers/papers');
  assert.equal(status, 200);
  assert.deepEqual(body.needs.map((n) => [n.key, n.required, n.state]), [
    ['hackney', true, 'missing'], ['vehicleLicence', true, 'missing'], ['roadworthy', true, 'missing'],
    ['insurance', true, 'missing'], ['ownership', true, 'missing'], ['lagos', true, 'missing'],
  ]);
  assert.deepEqual(need(body, 'ownership').papers.map((p) => p.type), ['proofOfOwnership', 'purchaseReceipt', 'ownerLetter'], 'three ways to show whose car it is');
  assert.deepEqual(need(body, 'roadworthy').papers.map((p) => p.type), ['roadworthiness', 'vioInspection']);
  assert.equal(body.details.complete, false);
  assert.equal(body.toDo, 7, 'six required papers and the details');
  assert.equal(body.requiredFrom, null, 'no day is set from which papers are needed');
  assert.equal(body.blocked, false);
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
  delete saved.body.requiredFrom; delete saved.body.blocked;
  assert.deepEqual(saved.body.details, { legalName: 'Adebayo Tunde Okafor', licenceNumber: 'ABC12345DE67', licenceExpiresOn: inDays(400), licenceExpired: false, complete: true });
  assert.equal(saved.body.toDo, 6);
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
  assert.equal(sent.body.toDo, 6, 'five papers and the details left');

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
  assert.equal(vio.toDo, 5);
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
  assert.equal(view.toDo, 4, 'insurance, whose car it is, the Lagos State paper, and the details');

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

// ── the admin ───────────────────────────────────────────────────────────────

test('the admin opens a driver\'s papers, approves one and sends one back with a reason; the driver is told each time', async () => {
  const d = await driver();
  const staff = await admin();
  await call(d.token, 'PUT', '/drivers/papers/details', { legalName: 'Bola Ahmed Musa', licenceNumber: 'LAG1234567', licenceExpiresOn: inDays(500) });
  await call(d.token, 'POST', '/drivers/papers', { type: 'insurance', file: pdf(), expiresOn: inDays(200), number: 'POL-9' });
  await call(d.token, 'POST', '/drivers/papers', { type: 'hackneyPermit', file: jpeg(), expiresOn: inDays(300) });

  assert.equal((await call(null, 'GET', `/admin/drivers/${d.id}/papers`)).status, 401);
  assert.equal((await call(d.token, 'GET', `/admin/drivers/${d.id}/papers`)).status, 401, 'a driver\'s login is not an admin\'s');
  const opened = await call(staff, 'GET', `/admin/drivers/${d.id}/papers`);
  assert.equal(opened.status, 200);
  assert.equal(opened.body.details.legalName, 'Bola Ahmed Musa');
  const insurance = paper(opened.body, 'insurance').document;
  assert.match(insurance.url, /^https:\/\/files\.test\/mem\//, 'a link to open the file');
  assert.deepEqual([insurance.status, insurance.fileType, insurance.number], ['PENDING', 'application/pdf', 'POL-9']);
  assert.equal(paper(opened.body, 'vehicleLicence').document, null, 'not sent: nothing to open');

  const review = (type, body) => call(staff, 'POST', `/admin/drivers/${d.id}/papers/${type}/review`, body);
  assert.equal((await review('vehicleLicence', { decision: 'approve' })).status, 404, 'a paper not sent cannot be reviewed');
  assert.equal((await review('insurance', { decision: 'maybe' })).status, 400);
  assert.equal((await review('hackneyPermit', { decision: 'reject' })).body.code, 'REASON_NEEDED');
  assert.equal((await review('hackneyPermit', { decision: 'reject', reason: 'no' })).body.code, 'REASON_NEEDED');

  told.length = 0;
  const approved = await review('insurance', { decision: 'approve' });
  assert.deepEqual([approved.status, approved.body.status], [200, 'APPROVED']);
  const back = await review('hackneyPermit', { decision: 'reject', reason: 'The stamp is not visible.' });
  assert.equal(back.body.status, 'REJECTED');
  await new Promise((resolve) => setTimeout(resolve, 80));
  const pushes = told.filter((e) => e.eventType === 'PUSH_SEND' && e.userId === d.userId);
  assert.deepEqual(pushes.map((e) => e.title), ['Insurance approved', 'Hackney permit: please send it again']);
  assert.match(pushes[1].body, /The stamp is not visible\. Open Your papers/);
  assert.equal(told.filter((e) => e.eventType === 'IN_APP_SEND').length, 2);

  // The driver sees both answers, and the reviewer's name stays with the admin.
  const mine = (await call(d.token, 'GET', '/drivers/papers')).body;
  assert.equal(paper(mine, 'insurance').document.state, 'approved');
  assert.deepEqual([paper(mine, 'hackneyPermit').document.state, paper(mine, 'hackneyPermit').document.rejectionReason], ['rejected', 'The stamp is not visible.']);
  assert.equal(paper(mine, 'insurance').document.reviewedBy, undefined);
  const row = await prisma.driverDocument.findFirst({ where: { driverId: d.id, type: 'insurance' } });
  assert.equal(row.reviewedBy, 'Ada Reviewer');
  const log = await prisma.adminActivity.findMany({ where: { adminId: made.admins.at(-1) } });
  assert.deepEqual(log.map((l) => l.detail.what).sort(), ['approved a paper', 'sent a paper back']);

  // An expired paper cannot be approved.
  await prisma.driverDocument.update({ where: { driverId_type: { driverId: d.id, type: 'hackneyPermit' } }, data: { expiresOn: new Date(lagosToday().getTime() - 86_400_000) } });
  assert.equal((await review('hackneyPermit', { decision: 'approve' })).body.code, 'EXPIRED');
});

test('the admin\'s lists: waiting to be checked (oldest first), expiring soon, expired, and sent back', async () => {
  const d = await driver();
  const staff = await admin();
  const days = (n) => new Date(lagosToday().getTime() + n * 86_400_000);
  await prisma.driver.update({ where: { id: d.id }, data: { legalName: 'Queue Test Driver' } });
  await prisma.driverDocument.createMany({ data: [
    { driverId: d.id, type: 'insurance', fileKey: 'q1', fileType: 'image/jpeg', expiresOn: days(200), status: 'PENDING', uploadedAt: new Date(Date.now() - 3_600_000) },
    { driverId: d.id, type: 'vehicleLicence', fileKey: 'q2', fileType: 'image/jpeg', expiresOn: days(9), status: 'APPROVED' },
    { driverId: d.id, type: 'roadworthiness', fileKey: 'q3', fileType: 'image/jpeg', expiresOn: days(-4), status: 'APPROVED' },
    { driverId: d.id, type: 'hackneyPermit', fileKey: 'q4', fileType: 'image/jpeg', expiresOn: days(100), status: 'REJECTED', rejectionReason: 'Blurry.', reviewedAt: new Date() },
  ] });
  const list = async (filter) => (await call(staff, 'GET', `/admin/driver-papers?filter=${filter}`)).body;
  const mine = (body) => body.items.filter((i) => i.driverId === d.id);

  const waiting = await list('waiting');
  assert.deepEqual(mine(waiting).map((i) => [i.label, i.driverName, i.status]), [['Insurance', 'Queue Test Driver', 'PENDING']]);
  assert.ok(waiting.counts.waiting >= 1 && waiting.counts.expiring >= 1 && waiting.counts.expired >= 1 && waiting.counts.sentBack >= 1);
  assert.deepEqual(mine(await list('expiring')).map((i) => [i.label, i.daysLeft]), [['Vehicle licence', 9]]);
  assert.deepEqual(mine(await list('expired')).map((i) => [i.label, i.expired]), [['Roadworthiness certificate', true]]);
  assert.deepEqual(mine(await list('sentBack')).map((i) => [i.label, i.rejectionReason]), [['Hackney permit', 'Blurry.']]);
  assert.equal((await list('nonsense')).filter, 'waiting', 'an unknown list is the waiting one');
});

// ── reminders ───────────────────────────────────────────────────────────────

test('a paper running out is reminded at 30, 14 and 3 days and once it has expired, each once', async () => {
  const today = lagosToday();
  const days = (n) => new Date(today.getTime() + n * 86_400_000);
  assert.equal(reminderDue(days(45), null, today), null, 'too far off');
  assert.equal(reminderDue(days(30), null, today), 30);
  assert.equal(reminderDue(days(22), 30, today), null, 'already reminded for this stretch');
  assert.equal(reminderDue(days(14), 30, today), 14);
  assert.equal(reminderDue(days(10), null, today), 14, 'first heard of at ten days: the 14-day one');
  assert.equal(reminderDue(days(3), 14, today), 3);
  assert.equal(reminderDue(days(0), 3, today), null, 'the last day is inside the 3-day stretch');
  assert.equal(reminderDue(days(-1), 3, today), 0, 'expired');
  assert.equal(reminderDue(days(-20), 0, today), null, 'and not again');

  const d = await driver();
  await prisma.driver.update({ where: { id: d.id }, data: { licenceExpiresOn: days(2) } });
  await prisma.driverDocument.createMany({ data: [
    { driverId: d.id, type: 'insurance', fileKey: 'r1', fileType: 'image/jpeg', expiresOn: days(12), status: 'APPROVED' },
    { driverId: d.id, type: 'hackneyPermit', fileKey: 'r2', fileType: 'image/jpeg', expiresOn: days(200), status: 'APPROVED' },
    { driverId: d.id, type: 'vehicleLicence', fileKey: 'r3', fileType: 'image/jpeg', expiresOn: days(-2), status: 'APPROVED' },
  ] });
  told.length = 0;
  await sendPaperReminders({ publisher }, today);
  const mine = () => told.filter((e) => e.eventType === 'PUSH_SEND' && e.userId === d.userId).map((e) => e.title).sort();
  assert.deepEqual(mine(), ["Driver's licence expires in 2 days", 'Insurance expires in 12 days', 'Vehicle licence has expired']);
  await sendPaperReminders({ publisher }, today);
  assert.equal(mine().length, 3, 'a second pass the same day sends nothing new');

  // Sending the renewed paper clears its reminder, so the next one starts from the new date.
  await call(d.token, 'POST', '/drivers/papers', { type: 'insurance', file: jpeg(), expiresOn: inDays(20) });
  assert.equal((await prisma.driverDocument.findFirst({ where: { driverId: d.id, type: 'insurance' } })).remindedAt, null);
});

// ── the deadline ────────────────────────────────────────────────────────────

test('with no day set papers stop nobody; from the day they are required, a driver with papers missing cannot go online', async () => {
  const d = await driver();
  delete process.env.DRIVER_PAPERS_REQUIRED_FROM;
  await assertDriverApproved(d.userId);

  const late = await driver();
  process.env.DRIVER_PAPERS_REQUIRED_FROM = inDays(5);
  try {
    await assertDriverApproved(late.userId);
    const soon = (await call(late.token, 'GET', '/drivers/papers')).body;
    assert.deepEqual([soon.requiredFrom, soon.blocked], [inDays(5), false], 'the day is shown, and has not come');

    process.env.DRIVER_PAPERS_REQUIRED_FROM = inDays(-1);
    const stopped = await driver();
    await assert.rejects(assertDriverApproved(stopped.userId), (error) => error.code === 'PAPERS_REQUIRED' && /7 of your papers are missing/.test(error.message));
    assert.equal((await call(stopped.token, 'GET', '/drivers/papers')).body.blocked, true);

    // Everything sent (still waiting to be checked) is enough: they have done their part.
    await call(stopped.token, 'PUT', '/drivers/papers/details', { legalName: 'Kemi Ade Bello', licenceNumber: 'KJA7654321', licenceExpiresOn: inDays(300) });
    for (const type of ['hackneyPermit', 'vehicleLicence', 'roadworthiness', 'insurance']) {
      await call(stopped.token, 'POST', '/drivers/papers', { type, file: jpeg(), expiresOn: inDays(120) });
    }
    await call(stopped.token, 'POST', '/drivers/papers', { type: 'lagosVehicle', file: jpeg() });
    await assert.rejects(assertDriverApproved(stopped.userId), (error) => /One of your papers/.test(error.message));
    await call(stopped.token, 'POST', '/drivers/papers', { type: 'ownerLetter', file: jpeg() });
    await assertDriverApproved(stopped.userId);
    assert.equal((await call(stopped.token, 'GET', '/drivers/papers')).body.blocked, false);
  } finally {
    delete process.env.DRIVER_PAPERS_REQUIRED_FROM;
  }
});

// ── sign-up ─────────────────────────────────────────────────────────────────

test('a new driver\'s name and licence details go in with the application; an older app that sends none is still taken', async () => {
  const application = { ninImage: jpeg(), licenceImage: jpeg(), selfieImage: jpeg(), vehicleImages: Array.from({ length: 7 }, () => jpeg(600)), vehicleMake: 'Toyota', vehicleModel: 'Corolla', vehiclePlate: 'LAG-123-XY', vehicleYear: 2015 };
  const fresh = async () => {
    const d = await driver();
    await prisma.driver.update({ where: { id: d.id }, data: { kycStatus: 'PENDING' } });
    return d;
  };

  const a = await fresh();
  const bad = await call(a.token, 'POST', '/drivers/kyc/submit', { ...application, legalName: 'Sola', licenceNumber: 'ABC1234567', licenceExpiresOn: inDays(100) });
  assert.deepEqual([bad.status, bad.body.code], [400, 'BAD_NAME']);
  assert.equal((await prisma.driver.findUnique({ where: { id: a.id } })).kycStatus, 'PENDING', 'nothing was sent');
  const good = await call(a.token, 'POST', '/drivers/kyc/submit', { ...application, legalName: 'Sola Grace Adeyemi', licenceNumber: 'abc1234567', licenceExpiresOn: inDays(100) });
  assert.equal(good.status, 200);
  const row = await prisma.driver.findUnique({ where: { id: a.id } });
  assert.deepEqual([row.kycStatus, row.legalName, row.licenceNumber], ['SUBMITTED', 'Sola Grace Adeyemi', 'ABC1234567']);

  const b = await fresh();
  assert.equal((await call(b.token, 'POST', '/drivers/kyc/submit', application)).status, 200, 'no details sent: the application still goes in');
  assert.equal((await prisma.driver.findUnique({ where: { id: b.id } })).legalName, null);
});

test('dates: only a real YYYY-MM-DD is a day, and today is Lagos\'s today', () => {
  assert.equal(parseDay('2027-03-31').toISOString(), '2027-03-31T00:00:00.000Z');
  assert.equal(parseDay('2027-3-31'), null);
  assert.equal(parseDay('2027-13-01'), null);
  assert.equal(parseDay(20270331), null);
  assert.equal(lagosToday(new Date('2026-10-13T23:30:00Z')).toISOString(), '2026-10-14T00:00:00.000Z', 'half past midnight in Lagos is already tomorrow');
});

test('what a driver is told when something goes wrong is something they can act on, with a code the app can read', async () => {
  const d = await driver();
  const raw = (body) => fetch(base + '/drivers/papers', { method: 'POST', headers: { authorization: `Bearer ${d.token}`, 'content-type': 'application/json' }, body });
  const broken = await raw('{"type": "insurance", "file": "abc');
  assert.equal(broken.status, 400);
  assert.deepEqual(await broken.json(), { error: 'That did not arrive in one piece. Check your connection and send it again.', code: 'BAD_UPLOAD' });
  const list = await raw('[1, 2, 3]');
  assert.equal((await list.json()).code, 'BAD_UPLOAD');

  // Every refusal is a full sentence, not a status word, and names what to do.
  const refusals = [
    await call(d.token, 'POST', '/drivers/papers', { type: 'nope', file: jpeg() }),
    await call(d.token, 'POST', '/drivers/papers', { type: 'insurance', file: 'x' }),
    await call(d.token, 'POST', '/drivers/papers', { type: 'insurance', file: jpeg() }),
    await call(d.token, 'POST', '/drivers/papers', { type: 'insurance', file: jpeg(), expiresOn: inDays(-1) }),
    await call(d.token, 'PUT', '/drivers/papers/details', { legalName: 'X', licenceNumber: 'ABC1234567', licenceExpiresOn: inDays(10) }),
    await call(d.token, 'PUT', '/drivers/papers/details', { legalName: 'Good Name Here', licenceNumber: '!!', licenceExpiresOn: inDays(10) }),
  ];
  for (const r of refusals) {
    assert.equal(r.status, 400);
    assert.ok(typeof r.body.code === 'string' && r.body.code.length > 2, 'a code');
    assert.ok(r.body.error.length > 20 && /[.]$/.test(r.body.error), `a sentence: "${r.body.error}"`);
    assert.doesNotMatch(r.body.error, /json|payload|invalid|required field|undefined|null/i, 'no developer words');
  }
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
  await prisma.driverKycSubmission.deleteMany({ where: { driverId: { in: drivers.map((d) => d.id) } } });
  await prisma.driverKycReview.deleteMany({ where: { driverId: { in: drivers.map((d) => d.id) } } });
  await prisma.adminActivity.deleteMany({ where: { adminId: { in: made.admins } } });
  await prisma.adminUser.deleteMany({ where: { id: { in: made.admins } } });
  await prisma.userActivityEvent.deleteMany({ where: { userId: { in: made.users } } }).catch(() => {});
  await prisma.driver.deleteMany({ where: { userId: { in: made.users } } });
  await prisma.user.deleteMany({ where: { id: { in: made.users } } });
  await prisma.$disconnect();
});

test('a driver with no name on their account takes the name on their licence; one who has a name keeps it', async () => {
  const { prisma, driverPaperClient } = require('@wheleers/db');
  const { randomUUID } = require('node:crypto');
  const make = async (name) => {
    const user = await prisma.user.create({ data: { privyDid: `did:test:${randomUUID()}`, role: 'DRIVER', name, username: `t${randomUUID().slice(0, 8)}` } });
    const driver = await prisma.driver.create({ data: { userId: user.id } });
    return { user, driver };
  };
  const nameless = await make(null);
  const named = await make('Tunde A');
  const details = { licenceNumber: 'ABC12345DE67', licenceExpiresOn: new Date('2030-01-01') };
  try {
    const saved = await driverPaperClient.saveDetails(nameless.driver.id, { ...details, legalName: 'Michael Okoro' });
    assert.equal(saved.legalName, 'Michael Okoro');
    assert.equal((await prisma.user.findUnique({ where: { id: nameless.user.id } })).name, 'Michael Okoro');
    await driverPaperClient.saveDetails(named.driver.id, { ...details, legalName: 'Babatunde Adeyemi' });
    assert.equal((await prisma.user.findUnique({ where: { id: named.user.id } })).name, 'Tunde A', 'a name they chose is not replaced');
  } finally {
    await prisma.driver.deleteMany({ where: { id: { in: [nameless.driver.id, named.driver.id] } } });
    await prisma.user.deleteMany({ where: { id: { in: [nameless.user.id, named.user.id] } } });
  }
});
