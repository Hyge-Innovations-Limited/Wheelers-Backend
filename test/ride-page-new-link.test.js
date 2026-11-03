// The booking page link no longer expires (3 Nov 2026). "new link" in the chat ends every link made
// before it: those are refused the way an expired link is, and the fresh one works. Against the local Postgres.
//
//   node scripts/run-with-env.cjs node --test --test-force-exit test/ride-page-new-link.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const { handleRidePageRoute, forgetRideLinksEnded } = require('../apps/api-gateway/dist/http/ride-page.route.js');
const { isNewLinkRequest } = require('../apps/api-gateway/dist/http/whatsapp.route.js');
const { userClient } = require('../packages/db/dist/index.js');
const local = require('../apps/api-gateway/dist/auth/local.js');

const prisma = new PrismaClient();
const JWT = 'test-secret-that-is-at-least-32-characters-long';
const users = [];
test.after(async () => {
  await prisma.user.deleteMany({ where: { id: { in: users } } });
  await prisma.$disconnect();
});

const memoryRedis = () => { const m = new Map(); return { async get(k) { return m.get(k) ?? null; }, async set(k, v) { m.set(k, v); }, async del(k) { m.delete(k); }, async send() { return null; } }; };

async function scheduled(bearer) {
  const req = { method: 'GET', headers: { authorization: `Bearer ${bearer}` }, async *[Symbol.asyncIterator]() {} };
  const res = { statusCode: 200, body: null, setHeader() {}, writeHead(code) { this.statusCode = code; return this; }, end(text) { this.body = text ? JSON.parse(text) : null; } };
  await handleRidePageRoute(req, res, { jwtSecret: JWT, redisClient: memoryRedis() }, new URL('http://x/ride-page/scheduled'));
  return res;
}

test('a booking page link lasts for good: years, not six hours', () => {
  assert.ok(local.RIDE_PAGE_TOKEN_TTL_SECONDS >= 10 * 365 * 24 * 60 * 60 - 1);
  const t = local.createWalletPageToken('u', 'ride', JWT, local.RIDE_PAGE_TOKEN_TTL_SECONDS);
  assert.equal(local.verifyWalletPageToken(t, JWT).scope, 'ride');
});

test('"new link" ends every earlier link; the new one works', async () => {
  const u = await prisma.user.create({ data: { privyDid: `whatsapp:test-newlink-${randomUUID()}`, role: 'RIDER', name: 'Link Rider' } });
  users.push(u.id);
  const nowSec = Math.floor(Date.now() / 1000);
  // A link made a minute ago.
  const realNow = Date.now;
  Date.now = () => (nowSec - 60) * 1000;
  const old = local.createWalletPageToken(u.id, 'ride', JWT, local.RIDE_PAGE_TOKEN_TTL_SECONDS);
  Date.now = realNow;
  assert.equal((await scheduled(old)).statusCode, 200, 'works before "new link"');

  await userClient.endRideLinks(u.id, new Date(nowSec * 1000));
  forgetRideLinksEnded(u.id);
  const refused = await scheduled(old);
  assert.equal(refused.statusCode, 401);
  assert.equal(refused.body.code, 'LINK_EXPIRED', 'the page shows its way back to the chat');
  assert.match(refused.body.error, /replaced/);

  const fresh = local.createWalletPageToken(u.id, 'ride', JWT, local.RIDE_PAGE_TOKEN_TTL_SECONDS);
  assert.equal((await scheduled(fresh)).statusCode, 200, 'the new link works');
});

test('only "new link" itself asks for it', () => {
  for (const said of ['new link', 'New Link', ' new  link! ', 'NEW LINK.']) assert.equal(isNewLinkRequest(said), true, said);
  for (const said of ['link', 'new', 'send me the new link please', 'new linky']) assert.equal(isNewLinkRequest(said), false, said);
});
