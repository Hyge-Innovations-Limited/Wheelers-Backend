// B1: agreePrivacyOnce is atomic; setContactEmail never touches User.email. Real Postgres.
//   node scripts/run-with-env.cjs node --test --test-force-exit --test-concurrency=1 test/user-contact-email.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const { userClient } = require('../packages/db/dist/index.js');

const prisma = new PrismaClient();
const made = [];
async function makeUser(extra = {}) {
  const id = randomUUID();
  await prisma.user.create({ data: { id, privyDid: `local:${id}`, role: 'RIDER', name: 'B1 Test', ...extra } });
  made.push(id);
  return id;
}
test.after(async () => {
  await prisma.user.deleteMany({ where: { id: { in: made } } });
  await prisma.$disconnect();
});

test('two parallel agreePrivacyOnce calls: exactly one true', async () => {
  const id = await makeUser();
  const r = await Promise.all([userClient.agreePrivacyOnce(id), userClient.agreePrivacyOnce(id)]);
  assert.equal(r.filter(Boolean).length, 1);
  const u = await prisma.user.findUnique({ where: { id } });
  assert.equal(u.privacyConsent, 'AGREED');
  assert.ok(u.privacyConsentAt);
});

test('already AGREED returns false and keeps the original time', async () => {
  const at = new Date('2026-01-01T00:00:00Z');
  const id = await makeUser({ privacyConsent: 'AGREED', privacyConsentAt: at });
  assert.equal(await userClient.agreePrivacyOnce(id), false);
  const u = await prisma.user.findUnique({ where: { id } });
  assert.equal(u.privacyConsentAt.getTime(), at.getTime());
});

test('DECLINED user can agree once', async () => {
  const id = await makeUser({ privacyConsent: 'DECLINED' });
  assert.equal(await userClient.agreePrivacyOnce(id), true);
  assert.equal(await userClient.agreePrivacyOnce(id), false);
});

test('setContactEmail stores trimmed lowercase and leaves User.email alone', async () => {
  const id = await makeUser({ email: 'login@example.com' });
  const now = new Date('2026-11-02T10:00:00Z');
  await userClient.setContactEmail(id, '  Ada.Lovelace@Example.COM ', now);
  const u = await prisma.user.findUnique({ where: { id } });
  assert.equal(u.contactEmail, 'ada.lovelace@example.com');
  assert.equal(u.contactEmailAt.getTime(), now.getTime());
  assert.equal(u.email, 'login@example.com');
});
