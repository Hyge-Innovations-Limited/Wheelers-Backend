// Verification after a rejection: the admin sends back only what needs
// fixing, the driver resends only that, and an approved driver is never
// touched. Real Postgres (local), fresh accounts per test, storage and the
// notification publisher faked.
//
//   npm -w @wheleers/db run build && npm -w @wheleers/api-gateway run build
//   node scripts/run-with-env.cjs node --test --test-force-exit test/driver-kyc-review.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');

const kycRoute = require('../apps/api-gateway/dist/http/driver-kyc.route.js');
const adminRoute = require('../apps/api-gateway/dist/http/admin.route.js');
const fields = require('../apps/api-gateway/dist/drivers/kyc-fields.js');
const local = require('../apps/api-gateway/dist/auth/local.js');

const JWT_SECRET = 'test-secret-that-is-at-least-32-characters-long';
const ADMIN_KEY = 'test-admin-key';
const prisma = new PrismaClient();
const made = [];
const published = [];
const uploads = [];
const legacyPdfKeys = new Set();
let base;
let httpServer;

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]).toString('base64');
const PDF = Buffer.from('%PDF-1.4 a licence').toString('base64');

const storage = {
  async upload({ driverId, type, mimeType }) {
    const ext = mimeType === 'application/pdf' ? 'pdf' : mimeType === 'image/png' ? 'png' : 'jpg';
    const key = `test/${driverId}/${type}-${uploads.length}.${ext}`;
    uploads.push({ key, mimeType });
    return key;
  },
  async getSignedUrl(key, _expires, contentType) {
    return `https://signed.test/${key}?type=${contentType ?? ''}`;
  },
  async fileTypeOf(key) {
    if (key.endsWith('.pdf') || legacyPdfKeys.has(key)) return 'application/pdf';
    return 'image/jpeg';
  },
};

test.before(async () => {
  console.info = () => {};
  console.warn = () => {};
  const deps = {
    jwtSecret: JWT_SECRET, kycStorage: storage, adminApiKey: ADMIN_KEY,
    publisher: { publishNotificationEvent: async (e) => { published.push(e); } },
  };
  const server = http.createServer(async (req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    const admin = path.match(/^\/admin\/drivers\/([^/]+)(?:\/(approve|reject|field-review))?$/);
    if (path === '/drivers/kyc/submit') return kycRoute.handleDriverKycSubmitRoute(req, res, deps);
    if (path === '/drivers/kyc/resubmit') return kycRoute.handleDriverKycResubmitRoute(req, res, deps);
    if (path === '/drivers/kyc/status') return kycRoute.handleDriverKycStatusRoute(req, res, deps);
    if (path === '/admin/drivers') return adminRoute.handleAdminListDriversRoute(req, res, deps);
    if (admin && admin[2] === 'approve') return adminRoute.handleAdminApproveDriverRoute(req, res, deps, admin[1]);
    if (admin && admin[2] === 'reject') return adminRoute.handleAdminRejectDriverRoute(req, res, deps, admin[1]);
    if (admin && admin[2] === 'field-review') return adminRoute.handleAdminFieldReviewRoute(req, res, deps, admin[1]);
    if (admin) return adminRoute.handleAdminGetDriverRoute(req, res, deps, admin[1]);
    res.statusCode = 404; res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  httpServer = server;
});

test.after(async () => {
  httpServer?.close();
  const userIds = made.map((d) => d.userId);
  const driverIds = made.map((d) => d.driverId);
  await prisma.driverKycReview.deleteMany({ where: { driverId: { in: driverIds } } });
  await prisma.driverKycSubmission.deleteMany({ where: { driverId: { in: driverIds } } });
  await prisma.driver.deleteMany({ where: { id: { in: driverIds } } });
  await prisma.userActivityEvent.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

async function newDriver(kycStatus = 'PENDING') {
  const userId = randomUUID();
  await prisma.user.create({ data: { id: userId, privyDid: `test:kyc-review:${userId}`, role: 'DRIVER', name: 'Test Driver' } });
  const driver = await prisma.driver.create({ data: { userId, kycStatus } });
  const d = { userId, driverId: driver.id, token: local.createLocalAccessToken(userId, JWT_SECRET) };
  made.push(d);
  return d;
}

async function call(method, path, { token, admin, body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (admin) headers['x-admin-key'] = ADMIN_KEY;
  const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
}

function fullApplication() {
  return {
    ninImage: JPEG, licenceImage: PDF, selfieImage: JPEG,
    vehicleImages: Array.from({ length: 7 }, () => JPEG),
    vehicleMake: 'Toyota', vehicleModel: 'Camry', vehiclePlate: 'LAG23469', vehicleYear: 2019,
  };
}

const submission = (driverId) => prisma.driverKycSubmission.findUnique({ where: { driverId } });
const kycOf = async (driverId) => (await prisma.driver.findUnique({ where: { id: driverId } })).kycStatus;

/** Submitted, reviewed item by item, then rejected for these items. */
async function rejectedFor(rejected, reasons = {}) {
  const d = await newDriver();
  assert.equal((await call('POST', '/drivers/kyc/submit', { token: d.token, body: fullApplication() })).status, 200);
  for (const field of fields.KYC_FIELDS) {
    const no = rejected.includes(field);
    const r = await call('POST', `/admin/drivers/${d.driverId}/field-review`, {
      admin: true, body: { field, status: no ? 'rejected' : 'approved', reason: no ? reasons[field] ?? 'not clear' : '' },
    });
    assert.equal(r.status, 200);
  }
  const r = await call('POST', `/admin/drivers/${d.driverId}/reject`, { admin: true, body: { rejectedFields: rejected, reason: 'raw: summary' } });
  assert.equal(r.status, 200);
  return d;
}

test('an approved driver cannot send documents again, and nothing about them changes', async () => {
  const d = await newDriver('APPROVED');
  await prisma.driverKycSubmission.create({ data: {
    driverId: d.driverId, status: 'APPROVED', ninImageKey: 'kept/nin.jpg', licenceImageKey: 'kept/licence.jpg',
    selfieKey: 'kept/selfie.jpg', vehicleImageKeys: ['kept/v0.jpg'], submittedAt: new Date(), reviewedAt: new Date(), reviewedBy: 'someone',
  } });
  const before = await submission(d.driverId);

  const full = await call('POST', '/drivers/kyc/submit', { token: d.token, body: fullApplication() });
  assert.equal(full.status, 409);
  assert.equal(full.body.code, 'ALREADY_APPROVED');
  const fix = await call('POST', '/drivers/kyc/resubmit', { token: d.token, body: { licenceImage: JPEG } });
  assert.equal(fix.status, 409);

  assert.equal(await kycOf(d.driverId), 'APPROVED');
  assert.deepEqual(await submission(d.driverId), before);
});

test("a new driver's application goes under review, and a PDF licence is stored as a PDF", async () => {
  const d = await newDriver();
  const r = await call('POST', '/drivers/kyc/submit', { token: d.token, body: fullApplication() });
  assert.equal(r.status, 200);
  assert.equal(await kycOf(d.driverId), 'SUBMITTED');
  const s = await submission(d.driverId);
  assert.equal(s.status, 'SUBMITTED');
  assert.match(s.licenceImageKey, /\.pdf$/);
  assert.match(s.ninImageKey, /\.jpg$/);
  assert.equal(s.vehicleImageKeys.length, 7);
});

test('a rejection names only what to fix, in words a driver reads, and tells the driver', async () => {
  published.length = 0;
  const d = await rejectedFor(['licence'], { licence: 'photo is blurry' });

  assert.equal(await kycOf(d.driverId), 'REJECTED');
  const status = await call('GET', '/drivers/kyc/status', { token: d.token });
  assert.equal(status.body.kycStatus, 'REJECTED');
  assert.deepEqual(status.body.submission.rejectedFields, ['licence']);
  assert.deepEqual(status.body.submission.fieldReasons, { licence: 'photo is blurry' });
  assert.equal(status.body.submission.rejectionReason, "Driver's licence: photo is blurry.");

  const push = published.find((e) => e.eventType === 'PUSH_SEND' && e.userId === d.userId);
  assert.equal(push?.data?.type, 'kyc_rejected');
  assert.ok(published.find((e) => e.eventType === 'IN_APP_SEND' && e.userId === d.userId && e.category === 'kyc'));

  const history = await prisma.driverKycReview.findMany({ where: { driverId: d.driverId } });
  assert.equal(history.length, 1);
  assert.equal(history[0].outcome, 'REJECTED');
});

test('the driver resends only the licence; everything approved is kept and the reviewer sees what changed', async () => {
  const d = await rejectedFor(['licence'], { licence: 'photo is blurry' });
  const before = await submission(d.driverId);

  const r = await call('POST', '/drivers/kyc/resubmit', { token: d.token, body: { licenceImage: JPEG } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.resubmitted, ['licence']);

  const after = await submission(d.driverId);
  assert.equal(await kycOf(d.driverId), 'SUBMITTED');
  assert.equal(after.status, 'SUBMITTED');
  assert.notEqual(after.licenceImageKey, before.licenceImageKey);
  assert.equal(after.ninImageKey, before.ninImageKey);
  assert.equal(after.selfieKey, before.selfieKey);
  assert.deepEqual(after.vehicleImageKeys, before.vehicleImageKeys);
  assert.equal(after.fieldStatuses.licence, undefined);
  assert.equal(after.fieldStatuses.nin.status, 'approved');

  // The driver sees nothing to fix; the reviewer sees what was resent.
  const status = await call('GET', '/drivers/kyc/status', { token: d.token });
  assert.deepEqual(status.body.submission.rejectedFields, []);
  const detail = await call('GET', `/admin/drivers/${d.driverId}`, { admin: true });
  assert.deepEqual(detail.body.submission.resubmittedFields, ['licence']);
  assert.equal(detail.body.submission.previousRejectionReason, "Driver's licence: photo is blurry.");
  const queue = await call('GET', '/admin/drivers', { admin: true });
  assert.deepEqual(queue.body.drivers.find((row) => row.driverId === d.driverId)?.resubmittedFields, ['licence']);

  // Sending again does nothing: it is under review now.
  const again = await call('POST', '/drivers/kyc/resubmit', { token: d.token, body: { licenceImage: JPEG } });
  assert.equal(again.status, 409);
  assert.equal(again.body.code, 'NOT_REJECTED');
});

test('a resubmission missing a rejected item changes nothing', async () => {
  const d = await rejectedFor(['licence', 'vehiclePhotos']);
  const before = await submission(d.driverId);
  const r = await call('POST', '/drivers/kyc/resubmit', { token: d.token, body: { licenceImage: JPEG } });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'MISSING_FIELDS');
  assert.deepEqual(r.body.missing, ['vehiclePhotos']);
  assert.equal(await kycOf(d.driverId), 'REJECTED');
  assert.deepEqual(await submission(d.driverId), before);
});

test('only a rejected driver can resubmit', async () => {
  const pending = await newDriver();
  assert.equal((await call('POST', '/drivers/kyc/resubmit', { token: pending.token, body: { licenceImage: JPEG } })).status, 409);
  const submitted = await newDriver();
  await call('POST', '/drivers/kyc/submit', { token: submitted.token, body: fullApplication() });
  const r = await call('POST', '/drivers/kyc/resubmit', { token: submitted.token, body: { licenceImage: JPEG } });
  assert.equal(r.status, 409);
  assert.equal(await kycOf(submitted.driverId), 'SUBMITTED');
});

test('an older admin page rejecting the car as one item sends the photos back too', async () => {
  const d = await newDriver();
  await call('POST', '/drivers/kyc/submit', { token: d.token, body: fullApplication() });
  for (const field of ['nin', 'licence', 'selfie']) {
    await call('POST', `/admin/drivers/${d.driverId}/field-review`, { admin: true, body: { field, status: 'approved' } });
  }
  await call('POST', `/admin/drivers/${d.driverId}/field-review`, { admin: true, body: { field: 'vehicle', status: 'rejected', reason: 'plate unreadable' } });
  const r = await call('POST', `/admin/drivers/${d.driverId}/reject`, { admin: true, body: { rejectedFields: ['vehicle'] } });
  assert.deepEqual(r.body.rejectedFields, ['vehicle', 'vehiclePhotos']);
});

test('approving decides once, records it and tells the driver', async () => {
  published.length = 0;
  const d = await newDriver();
  await call('POST', '/drivers/kyc/submit', { token: d.token, body: fullApplication() });
  assert.equal((await call('POST', `/admin/drivers/${d.driverId}/approve`, { admin: true })).status, 200);
  assert.equal((await call('POST', `/admin/drivers/${d.driverId}/approve`, { admin: true })).status, 400);
  assert.equal((await call('POST', `/admin/drivers/${d.driverId}/reject`, { admin: true, body: {} })).status, 400);
  assert.equal(await kycOf(d.driverId), 'APPROVED');
  assert.equal((await prisma.driverKycReview.findMany({ where: { driverId: d.driverId } })).length, 1);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(published.find((e) => e.eventType === 'PUSH_SEND' && e.userId === d.userId)?.data?.type, 'kyc_approved');
});

test('a rejected driver whose app resends everything starts a clean review', async () => {
  const d = await rejectedFor(['nin']);
  const r = await call('POST', '/drivers/kyc/submit', { token: d.token, body: fullApplication() });
  assert.equal(r.status, 200);
  const s = await submission(d.driverId);
  assert.equal(s.status, 'SUBMITTED');
  assert.deepEqual(s.rejectedFields, []);
  assert.equal(s.fieldStatuses, null);
  assert.equal(s.rejectionReason, null);
});

test('an older PDF licence stored as .jpg opens as a PDF for the admin', async () => {
  const d = await newDriver('SUBMITTED');
  await prisma.driverKycSubmission.create({ data: {
    driverId: d.driverId, status: 'SUBMITTED', licenceImageKey: `legacy/${d.driverId}/licence.jpg`, submittedAt: new Date(),
  } });
  legacyPdfKeys.add(`legacy/${d.driverId}/licence.jpg`);
  const r = await call('GET', `/admin/drivers/${d.driverId}`, { admin: true });
  assert.equal(r.body.submission.licenceFileType, 'application/pdf');
  assert.match(r.body.submission.licenceImageUrl, /type=application\/pdf$/);
});

test('the queue lists drivers waiting to fix something', async () => {
  const d = await rejectedFor(['selfie']);
  const r = await call('GET', '/admin/drivers?status=REJECTED', { admin: true });
  const row = r.body.drivers.find((x) => x.driverId === d.driverId);
  assert.deepEqual(row?.rejectedFields, ['selfie']);
  const pending = await call('GET', '/admin/drivers', { admin: true });
  assert.equal(pending.body.drivers.some((x) => x.driverId === d.driverId), false);
});

test('reasons read as sentences, never internal keys', () => {
  assert.equal(
    fields.readableRejection(['licence', 'vehiclePhotos'], { licence: 'expired.', vehiclePhotos: 'plate not visible' }, 'licence: expired'),
    "Driver's licence: expired. Vehicle photos: plate not visible.",
  );
  assert.equal(fields.readableRejection(['nin'], {}, null), 'Your documents did not pass review.');
  assert.deepEqual(fields.rejectedFieldsFrom([], null), [...fields.KYC_FIELDS]);
});
