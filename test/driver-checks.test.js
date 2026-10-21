// Checking drivers' papers from the admin: Prembly's licence, plate and
// insurance checks (owners only, never re-paid within 30 days, the licence
// photo never kept), checks done by hand on government sites, deciding all of
// a driver's papers in one go with ONE message to them, and approving many
// drivers' papers at once. Prembly is stubbed: nothing leaves this process.
// Against the local Postgres.
//
//   node scripts/run-with-env.cjs node --test --test-force-exit test/driver-checks.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { prisma } = require('@wheleers/db');
const local = require('../apps/api-gateway/dist/auth/local.js');
const { handleAdminDriverChecksRoute } = require('../apps/api-gateway/dist/http/admin-driver-checks.route.js');
const { handleAdminDriverPapersRoute } = require('../apps/api-gateway/dist/http/admin-driver-papers.route.js');
const { lagosToday } = require('../apps/api-gateway/dist/http/driver-papers.route.js');
const { readDay, namesAgree, makesAgree, plateKey, readLicence, readInsurance, readPlate } = require('../apps/api-gateway/dist/verification/driver-checks.js');
const { premblyPost } = require('../apps/api-gateway/dist/verification/prembly.js');
const { cleanReading } = require('../apps/api-gateway/dist/verification/licence-reader.js');

const SECRET = 'test-secret-for-the-driver-checks';
const told = [];
const publisher = { publishNotificationEvent: async (event) => { told.push(event); } };
const calls = [];
let answer = null;
const fetchImpl = async (url, init) => {
  calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
  return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } });
};
let llmCalls = 0;
let llmAnswer = null;
const llm = { configured: true, completeVisionJson: async (prompt, bytes, mime) => { llmCalls += 1; assert.equal(mime, 'image/jpeg'); assert.ok(Buffer.isBuffer(bytes)); return llmAnswer; } };
const storageStub = {
  getSignedUrl: async (key) => `https://files.test/${key}`,
  fileTypeOf: async () => 'image/jpeg',
  getImageAsBase64: async () => 'c2VsZmll',
  getFile: async () => ({ bytes: Buffer.from('a licence photo'), type: 'image/jpeg' }),
};
const config = { apiKey: 'test-key', appId: null, baseUrl: 'https://prembly.test', timeoutMs: 5000 };
const made = { users: [], admins: [] };
let server; let base;
const inDays = (n) => new Date(lagosToday().getTime() + n * 86_400_000);
const iso = (d) => d.toISOString().slice(0, 10);

async function driver() {
  const user = await prisma.user.create({ data: { privyDid: `did:test:${randomUUID()}`, role: 'DRIVER', name: 'Ajayi Checks' } });
  made.users.push(user.id);
  const row = await prisma.driver.create({
    data: { userId: user.id, kycStatus: 'APPROVED', legalName: 'Ajayi Oluwalere Samuel', licenceNumber: 'AAD23208212298', licenceExpiresOn: inDays(400), vehicleMake: 'Toyota', vehicleModel: 'Corolla', vehiclePlate: 'KJA 123 AB' },
  });
  return { id: row.id, userId: user.id };
}
async function paper(driverId, type, extra = {}) {
  return prisma.driverDocument.create({ data: { driverId, type, fileKey: `mem/${driverId}/${type}`, fileType: 'image/jpeg', ...extra } });
}
async function admin(role) {
  const row = await prisma.adminUser.create({ data: { username: `checks-${randomUUID().slice(0, 8)}`, passwordHash: 'x', name: role === 'OWNER' ? 'Timi Owner' : 'Ada Staff', role } });
  made.admins.push(row.id);
  return local.createLocalAccessToken(row.id, SECRET, 3600);
}
const call = async (token, method, path, body) => {
  const res = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, body: await res.json() };
};

test.before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    void (async () => {
      if (await handleAdminDriverChecksRoute(req, res, { adminApiKey: 'unused-key', jwtSecret: SECRET, kycStorage: storageStub, prembly: config, fetchImpl, llm }, url)) return;
      if (await handleAdminDriverPapersRoute(req, res, { adminApiKey: 'unused-key', jwtSecret: SECRET, kycStorage: null, publisher }, url)) return;
      res.statusCode = 404; res.end('{}');
    })();
  });
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  server.close();
  await prisma.driverCheck.deleteMany({ where: { driver: { userId: { in: made.users } } } });
  await prisma.driverDocument.deleteMany({ where: { driver: { userId: { in: made.users } } } });
  await prisma.driverKycSubmission.deleteMany({ where: { driver: { userId: { in: made.users } } } });
  await prisma.driver.deleteMany({ where: { userId: { in: made.users } } });
  await prisma.adminActivity.deleteMany({ where: { adminId: { in: made.admins } } }).catch(() => {});
  await prisma.adminUser.deleteMany({ where: { id: { in: made.admins } } });
  await prisma.user.deleteMany({ where: { id: { in: made.users } } });
  await prisma.$disconnect();
});

test('dates, names, makes and plates are read the way records write them', () => {
  assert.equal(readDay('2026-06-03'), '2026-06-03');
  assert.equal(readDay('2026-06-03T00:00:00Z'), '2026-06-03');
  assert.equal(readDay('03/06/2026'), '2026-06-03', 'day first, as in Nigeria');
  assert.equal(readDay('3 Jun 2026'), '2026-06-03');
  assert.equal(readDay('3-JUN-26'), '2026-06-03');
  assert.equal(readDay('2 FEBY 2000'), '2000-02-02');
  assert.equal(readDay('soon'), null);
  assert.equal(namesAgree('OLUWALERE AJAYI', 'Ajayi Oluwalere Samuel'), true, 'any order, a middle name extra');
  assert.equal(namesAgree('JOHN TEST', 'Ajayi Oluwalere'), false);
  assert.equal(namesAgree('AJAYI', 'Ajayi Oluwalere'), true, 'one word against two: that word');
  assert.equal(makesAgree('TOYOTA', 'Toyota Corolla'), true);
  assert.equal(makesAgree('MERCEDES BENZ', 'Mercedes'), true);
  assert.equal(makesAgree('HONDA', 'Toyota'), false);
  assert.equal(plateKey('kja-123 ab'), 'KJA123AB');
});

test('a licence, plate and policy are set against what the driver gave', () => {
  const today = new Date('2026-10-21T00:00:00Z');
  const licence = readLicence(
    { firstName: 'John', lastName: 'Test', expiryDate: '2026-06-03', photo: 'x'.repeat(500), birthDate: '1999-12-21' },
    { legalName: 'Ajayi Oluwalere', accountName: null, licenceExpiresOn: '2027-01-01' },
    { match: false, confidence: 0.31, message: 'Face does not match' },
    today,
  );
  assert.equal(licence.mismatches.length, 3, licence.mismatches.join(' | '));
  assert.match(licence.mismatches[0], /John Test; the driver gave Ajayi Oluwalere/);
  assert.match(licence.mismatches[1], /expired on 3 Jun 2026/);
  assert.match(licence.mismatches[2], /selfie does not match.*31%/);
  assert.equal(licence.found.photo, undefined, 'the photo is never kept');
  assert.equal(licence.found.birthDate, undefined);

  const plate = readPlate({ vehicle_number: 'KJA123AB', vehicle_name: 'Honda', vehicle_color: 'BLUE' }, { vehicleMake: 'Toyota', vehicleModel: 'Corolla' });
  assert.deepEqual(plate.mismatches, ["The plate's records say Honda; the driver registered Toyota Corolla."]);
  assert.equal(plate.found.colour, 'BLUE');

  const good = readInsurance(
    { policy_status: 'Active', reg_number: 'KJA123AB', vehicle_make: 'TOYOTA', vehicle_model: 'COROLLA', expiry_date: '2027-03-01' },
    { plate: 'KJA 123 AB', vehicleMake: 'Toyota', vehicleModel: 'Corolla', paperExpiresOn: '2027-03-01' }, today);
  assert.deepEqual(good.mismatches, []);
  const bad = readInsurance(
    { policy_status: 'Expired', reg_number: 'LND555XY', vehicle_make: 'HONDA', expiry_date: '2026-01-01' },
    { plate: 'KJA 123 AB', vehicleMake: 'Toyota', vehicleModel: 'Corolla', paperExpiresOn: '2027-03-01' }, today);
  assert.equal(bad.mismatches.length, 4, bad.mismatches.join(' | '));
});

test("Prembly's answers are read as found, not found, or trouble on our side", async () => {
  const reply = (body, status = 200) => async () => new Response(JSON.stringify(body), { status });
  const found = await premblyPost(config, '/x', {}, reply({ status: true, detail: 'ok', data: { a: 1 }, verification: { status: 'VERIFIED', reference: 'ref-1' } }));
  assert.equal(found.kind, 'found'); assert.equal(found.reference, 'ref-1');
  const missing = await premblyPost(config, '/x', {}, reply({ status: false, detail: 'Record not found', response_code: '01' }));
  assert.equal(missing.kind, 'not_found');
  const broke = await premblyPost(config, '/x', {}, reply({ status: false, detail: 'Insufficient wallet balance' }));
  assert.equal(broke.kind, 'error', 'our empty balance is not the driver having no licence');
  const key = await premblyPost(config, '/x', {}, reply({ detail: 'Invalid API key' }, 401));
  assert.equal(key.kind, 'error');
  const down = await premblyPost(config, '/x', {}, async () => { throw new TypeError('fetch failed'); });
  assert.equal(down.kind, 'error');
});

test('only an owner runs a Prembly check; it needs the date of birth; the same one is not paid for twice', async () => {
  const d = await driver();
  const owner = await admin('OWNER');
  const staff = await admin('STAFF');

  const seen = await call(staff, 'GET', `/admin/drivers/${d.id}/checks`);
  assert.equal(seen.status, 200);
  assert.equal(seen.body.prembly.on, true);
  assert.equal(seen.body.prembly.canRun, false);
  assert.equal(seen.body.inputs.licenceNumber, 'AAD23208212298');
  assert.equal(seen.body.inputs.plate, 'KJA 123 AB');
  assert.deepEqual(seen.body.documents, { licence: null, selfieUrl: null, papers: [] }, 'nothing sent yet');

  assert.equal((await call(staff, 'POST', `/admin/drivers/${d.id}/checks/prembly`, { kind: 'licence', dob: '1990-01-01' })).body.code, 'OWNERS_ONLY');
  assert.equal((await call(owner, 'POST', `/admin/drivers/${d.id}/checks/prembly`, { kind: 'licence' })).body.code, 'DOB_NEEDED');

  calls.length = 0;
  answer = { status: true, detail: 'ok', data: { firstName: 'Oluwalere', lastName: 'Ajayi', expiryDate: iso(inDays(400)), stateOfIssue: 'Lagos', photo: 'p'.repeat(300) }, verification: { status: 'VERIFIED', reference: 'ref-licence' } };
  const ran = await call(owner, 'POST', `/admin/drivers/${d.id}/checks/prembly`, { kind: 'licence', dob: '12/03/1990' });
  assert.equal(ran.status, 200, JSON.stringify(ran.body));
  assert.equal(ran.body.check.outcome, 'verified');
  assert.equal(ran.body.photo.length, 300, 'the photo is shown once');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://prembly.test/verification/drivers_license/advance');
  assert.deepEqual(calls[0].body, { number: 'AAD23208212298', dob: '1990-03-12', first_name: 'Ajayi', last_name: 'Samuel' });
  assert.equal(calls[0].headers['x-api-key'], 'test-key');
  const row = await prisma.driverCheck.findUnique({ where: { id: ran.body.check.id } });
  assert.equal(JSON.stringify(row.found).includes('ppp'), false, 'the photo is not saved');

  const again = await call(owner, 'POST', `/admin/drivers/${d.id}/checks/prembly`, { kind: 'licence', dob: '1990-03-12' });
  assert.equal(again.body.reused, true);
  assert.equal(calls.length, 1, 'not paid for again');
  const forced = await call(owner, 'POST', `/admin/drivers/${d.id}/checks/prembly`, { kind: 'licence', dob: '1990-03-12', force: true });
  assert.equal(forced.body.reused, false);
  assert.equal(calls.length, 2);

  answer = { status: true, detail: 'ok', data: { policy_status: 'Active', reg_number: 'LND555XY', vehicle_make: 'TOYOTA', expiry_date: iso(inDays(200)) }, verification: { status: 'VERIFIED', reference: 'ref-ins' } };
  assert.equal((await call(owner, 'POST', `/admin/drivers/${d.id}/checks/prembly`, { kind: 'insurance' })).status, 400, 'no policy number on file');
  await paper(d.id, 'insurance', { number: 'PM2607151199', expiresOn: inDays(200) });
  const ins = await call(owner, 'POST', `/admin/drivers/${d.id}/checks/prembly`, { kind: 'insurance' });
  assert.equal(ins.body.check.outcome, 'mismatch');
  assert.match(ins.body.check.mismatches[0], /plate LND555XY, not the driver's KJA 123 AB/);
  assert.deepEqual(calls.at(-1).body, { channel: 'Policy', number: 'PM2607151199' });

  answer = { status: false, detail: 'Insufficient wallet balance' };
  const broke = await call(owner, 'POST', `/admin/drivers/${d.id}/checks/prembly`, { kind: 'plate' });
  assert.equal(broke.status, 502);
  assert.equal(broke.body.check.outcome, 'error');
  answer = { status: true, detail: 'ok', data: { vehicle_number: 'KJA123AB', vehicle_name: 'Toyota', vehicle_color: 'Silver' }, verification: { status: 'VERIFIED', reference: 'ref-plate' } };
  const plate = await call(owner, 'POST', `/admin/drivers/${d.id}/checks/prembly`, { kind: 'plate' });
  assert.equal(plate.body.reused, false, 'a failed call is tried again, not reused');
  assert.equal(plate.body.check.outcome, 'verified');

  const list = await call(staff, 'GET', `/admin/drivers/${d.id}/checks`);
  assert.deepEqual(list.body.documents.papers.map((p) => [p.type, p.number, p.expiresOn, p.daysLeft]), [['insurance', 'PM2607151199', iso(inDays(200)), 200]], 'each paper with its number and dates');
  assert.deepEqual(list.body.checks.map((c) => c.outcome), ['verified', 'error', 'mismatch', 'verified', 'verified']);
  assert.ok(list.body.prembly.thisMonth >= 4, 'errors are not counted as spent');
});

test('a check by hand is recorded; failing one needs a note', async () => {
  const d = await driver();
  const staff = await admin('STAFF');
  assert.equal((await call(staff, 'POST', `/admin/drivers/${d.id}/checks/manual`, { paperType: 'roadworthiness', source: 'dvis', outcome: 'failed' })).body.code, 'NOTE_NEEDED');
  assert.equal((await call(staff, 'POST', `/admin/drivers/${d.id}/checks/manual`, { paperType: 'roadworthiness', source: 'nowhere', outcome: 'verified' })).status, 400);
  const ok = await call(staff, 'POST', `/admin/drivers/${d.id}/checks/manual`, { paperType: 'hackneyPermit', source: 'autoreg', outcome: 'verified', note: 'Plate shows a valid permit to Dec 2026' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.check.kind, 'manual');
  assert.equal(ok.body.check.input, 'KJA 123 AB', 'checked by plate');
  assert.equal(ok.body.check.by, 'Ada Staff');
});

test("deciding a driver's papers in one go: all checked first, then ONE message listing what to send again", async () => {
  const d = await driver();
  const staff = await admin('STAFF');
  await paper(d.id, 'insurance', { number: 'PM1', expiresOn: inDays(100) });
  await paper(d.id, 'hackneyPermit', { number: 'H1', expiresOn: inDays(100) });
  await paper(d.id, 'roadworthiness', { expiresOn: inDays(100) });
  await paper(d.id, 'vehicleLicence', { expiresOn: inDays(-2) });

  const refused = await call(staff, 'POST', `/admin/drivers/${d.id}/papers/decide`, { decisions: [
    { type: 'insurance', decision: 'approve' },
    { type: 'roadworthiness', decision: 'reject' },
    { type: 'vehicleLicence', decision: 'approve' },
  ] });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.errors.length, 2, 'no reason, and expired');
  assert.equal((await prisma.driverDocument.findFirst({ where: { driverId: d.id, type: 'insurance' } })).status, 'PENDING', 'nothing saved when any is wrong');

  told.length = 0;
  const done = await call(staff, 'POST', `/admin/drivers/${d.id}/papers/decide`, { decisions: [
    { type: 'insurance', decision: 'approve' },
    { type: 'hackneyPermit', decision: 'approve' },
    { type: 'roadworthiness', decision: 'reject', reason: 'Not found on DVIS.' },
    { type: 'vehicleLicence', decision: 'reject', reason: 'The date on it has passed.' },
  ] });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.deepEqual(done.body.approved, ['insurance', 'hackneyPermit']);
  assert.deepEqual(done.body.sentBack, ['roadworthiness', 'vehicleLicence']);
  await new Promise((r) => setTimeout(r, 50));
  const push = told.filter((e) => e.eventType === 'PUSH_SEND');
  assert.equal(push.length, 1, 'one message, not four');
  assert.equal(push[0].title, 'Please send 2 papers again');
  assert.match(push[0].body, /1\) Roadworthiness certificate: Not found on DVIS\.\n2\) Vehicle licence: The date on it has passed\.\n2 others are approved\./);
  const rows = await prisma.driverDocument.findMany({ where: { driverId: d.id }, orderBy: { type: 'asc' } });
  assert.deepEqual(rows.map((r) => [r.type, r.status, r.reviewedBy]), [
    ['hackneyPermit', 'APPROVED', 'Ada Staff'], ['insurance', 'APPROVED', 'Ada Staff'],
    ['roadworthiness', 'REJECTED', 'Ada Staff'], ['vehicleLicence', 'REJECTED', 'Ada Staff'],
  ]);
});

test("approving many drivers' papers at once: waiting and in date only, one message per driver", async () => {
  const a = await driver();
  const b = await driver();
  const staff = await admin('STAFF');
  await paper(a.id, 'insurance', { number: 'A1', expiresOn: inDays(100) });
  await paper(a.id, 'hackneyPermit', { number: 'A2', expiresOn: inDays(100) });
  await paper(b.id, 'insurance', { number: 'B1', expiresOn: inDays(-1) });
  await paper(b.id, 'proofOfOwnership', { status: 'APPROVED' });
  await paper(b.id, 'ownerLetter');

  const queue = await call(staff, 'GET', '/admin/driver-papers?filter=waiting');
  assert.ok(queue.body.items.every((i) => Array.isArray(i.checks)));

  told.length = 0;
  const done = await call(staff, 'POST', '/admin/driver-papers/approve', { items: [
    { driverId: a.id, type: 'insurance' }, { driverId: a.id, type: 'hackneyPermit' },
    { driverId: b.id, type: 'insurance' }, { driverId: b.id, type: 'proofOfOwnership' }, { driverId: b.id, type: 'ownerLetter' },
    { driverId: b.id, type: 'roadworthiness' },
  ] });
  assert.equal(done.status, 200);
  assert.equal(done.body.approved.length, 3);
  assert.deepEqual(done.body.skipped.map((s) => s.why).sort(), ['already approved', 'expired', 'not sent']);
  await new Promise((r) => setTimeout(r, 50));
  const push = told.filter((e) => e.eventType === 'PUSH_SEND');
  assert.deepEqual(push.map((p) => p.title).sort(), ['2 papers approved', "Owner's letter approved"]);
  assert.equal((await call(staff, 'POST', '/admin/driver-papers/approve', { items: [] })).status, 400);
});

test('what the AI reads off a licence is cleaned: day-first dates, the number without spaces, a misread birth date dropped', () => {
  const r = cleanReading({ readable: true, licenceNumber: 'krd 52734 aa02', firstName: 'OLUWALERE', lastName: 'AJAYI', dateOfBirth: '14/05/1991', issuedOn: '2022-04-16', expiresOn: '16-04-2027', note: 'null' });
  assert.deepEqual(r, { readable: true, licenceNumber: 'KRD52734AA02', firstName: 'OLUWALERE', middleName: null, lastName: 'AJAYI', dateOfBirth: '1991-05-14', issuedOn: '2022-04-16', expiresOn: '2027-04-16', note: null });
  assert.equal(cleanReading({ readable: true, dateOfBirth: '2020-01-01' }).dateOfBirth, null, 'a four-year-old does not drive');
  assert.equal(cleanReading({ readable: true }).readable, false, 'nothing read is unreadable');
});

test('the licence photo is read for the form, once an hour, with where it disagrees with what the driver typed', async () => {
  const d = await driver();
  const staff = await admin('STAFF');
  assert.equal((await call(staff, 'POST', `/admin/drivers/${d.id}/checks/read-licence`, {})).body.code, 'NO_LICENCE');
  await prisma.driverKycSubmission.create({ data: { driverId: d.id, licenceImageKey: `mem/${d.id}/licence.jpg` } });

  llmCalls = 0;
  llmAnswer = { readable: true, licenceNumber: 'AAD23208212299', firstName: 'Oluwalere', lastName: 'Ajayi', dateOfBirth: '12-03-1990', expiresOn: iso(inDays(400)).split('-').reverse().join('-') };
  const read = await call(staff, 'POST', `/admin/drivers/${d.id}/checks/read-licence`, {});
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.equal(read.body.reading.dateOfBirth, '1990-03-12');
  assert.deepEqual(read.body.differs, ['The photo shows licence number AAD23208212299; the driver typed AAD23208212298.']);
  assert.equal(read.body.cached, false);

  const again = await call(staff, 'POST', `/admin/drivers/${d.id}/checks/read-licence`, {});
  assert.equal(again.body.cached, true);
  assert.equal(llmCalls, 1, 'read once');
  await call(staff, 'POST', `/admin/drivers/${d.id}/checks/read-licence`, { again: true });
  assert.equal(llmCalls, 2, 'read again when asked');

  const seen = await call(staff, 'GET', `/admin/drivers/${d.id}/checks`);
  assert.equal(seen.body.documents.licence.url, `https://files.test/mem/${d.id}/licence.jpg`);
  assert.equal(await prisma.driverCheck.count({ where: { driverId: d.id } }), 0, 'a reading is never saved as a check');
});
