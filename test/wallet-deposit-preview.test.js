/**
 * GET /wallet/deposit-preview?amount=: what the app's pay sheet says to send,
 * so the amount that lands after the deposit charges covers the fare.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');

const { depositNeededFor, splitDeposit, estimateDepositProviderFee } = require('../packages/config/dist/index.js');
const { handleWalletDepositPreviewRoute } = require('../apps/api-gateway/dist/http/wallet.route.js');
const local = require('../apps/api-gateway/dist/auth/local.js');

const prisma = new PrismaClient();
const JWT_SECRET = 'test-secret-that-is-at-least-32-characters-long';
const made = [];

async function makeUser() {
  const id = randomUUID();
  await prisma.user.create({ data: { id, privyDid: `whatsapp:+234${Math.floor(1e9 + Math.random() * 9e9)}`, role: 'RIDER', name: 'Preview Test' } });
  made.push(id);
  return id;
}

async function preview(query, token) {
  const req = { method: 'GET', headers: token ? { authorization: `Bearer ${token}` } : {} };
  const res = { statusCode: 0, body: null, setHeader() {}, writeHead(code) { this.statusCode = code; }, end(t) { this.body = JSON.parse(t); } };
  await handleWalletDepositPreviewRoute(req, res, { jwtSecret: JWT_SECRET }, new URL(`http://x/wallet/deposit-preview${query}`));
  return res;
}

test.after(async () => {
  await prisma.user.deleteMany({ where: { id: { in: made } } });
  await prisma.$disconnect();
});

test('says what to send so the shortfall lands, charges included', async () => {
  const token = local.createLocalAccessToken(await makeUser(), JWT_SECRET);
  for (const short of [1, 500, 1_250, 4_000, 40_000]) {
    const res = await preview(`?amount=${short}`, token);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.walletGetsNgn, short);
    assert.equal(res.body.sendNgn, depositNeededFor(short));
    assert.ok(res.body.sendNgn > short, 'sending the bare shortfall would land short');
    const lands = splitDeposit(res.body.sendNgn, estimateDepositProviderFee(res.body.sendNgn)).userCreditNgn;
    assert.ok(lands >= short, `₦${res.body.sendNgn} lands ₦${lands}, covers ₦${short}`);
  }
});

test('a part-naira shortfall is rounded up', async () => {
  const token = local.createLocalAccessToken(await makeUser(), JWT_SECRET);
  const res = await preview('?amount=499.2', token);
  assert.equal(res.body.walletGetsNgn, 500);
  assert.equal(res.body.sendNgn, depositNeededFor(500));
});

test('refuses no sign-in and a bad amount', async () => {
  assert.equal((await preview('?amount=500')).statusCode, 401);
  const token = local.createLocalAccessToken(await makeUser(), JWT_SECRET);
  for (const q of ['', '?amount=0', '?amount=-5', '?amount=abc', '?amount=99999999']) {
    assert.equal((await preview(q, token)).statusCode, 400, q);
  }
});
