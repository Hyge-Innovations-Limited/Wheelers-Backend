// Nobody is called "Driver": an account with no name gets one from Google /
// Apple / the sign-up form, else from the email. Against the local Postgres.
//
//   node scripts/run-with-env.cjs node --test --test-force-exit test/display-name.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const { nameFromEmail, fillMissingName } = require('../apps/api-gateway/dist/auth/display-name.js');

const prisma = new PrismaClient();
const made = [];

test('a name from the email: the first word, capitalised, no digits', () => {
  assert.equal(nameFromEmail('timilehinolowu46@gmail.com'), 'Timilehinolowu');
  assert.equal(nameFromEmail('timilehin.olowu46@gmail.com'), 'Timilehin');
  assert.equal(nameFromEmail('ADA_OBI+wheelers@yahoo.com'), 'Ada');
  assert.equal(nameFromEmail('tunde-bakare@outlook.com'), 'Tunde');
  assert.equal(nameFromEmail('12345@gmail.com'), null, 'nothing usable');
  assert.equal(nameFromEmail(null), null);
});

test('an account with no name gets one and keeps it; a real name is never touched', async () => {
  const bare = await prisma.user.create({ data: { id: randomUUID(), privyDid: `test:name:${randomUUID()}`, role: 'DRIVER', email: `timilehinolowu46.${Date.now()}@example.com` } });
  const named = await prisma.user.create({ data: { id: randomUUID(), privyDid: `test:name:${randomUUID()}`, role: 'DRIVER', name: 'Oke Adeyemi', email: `oke.${Date.now()}@example.com` } });
  const fromGoogle = await prisma.user.create({ data: { id: randomUUID(), privyDid: `test:name:${randomUUID()}`, role: 'RIDER', email: `x9.${Date.now()}@example.com` } });
  made.push(bare.id, named.id, fromGoogle.id);

  assert.equal((await fillMissingName(bare)).name, 'Timilehinolowu');
  assert.equal((await prisma.user.findUnique({ where: { id: bare.id } })).name, 'Timilehinolowu', 'kept');
  assert.equal((await fillMissingName(named, 'Someone Else')).name, 'Oke Adeyemi');
  assert.equal((await fillMissingName(fromGoogle, 'Ada Obi')).name, 'Ada Obi', "Google's name first");
});

test.after(async () => {
  await prisma.user.deleteMany({ where: { id: { in: made } } }).catch(() => {});
  await prisma.$disconnect();
});
