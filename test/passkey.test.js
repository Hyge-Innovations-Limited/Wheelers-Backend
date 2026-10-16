/**
 * Passkeys: signing in with Face ID or a fingerprint instead of an SMS code.
 * The test is the phone: it holds a real key pair and signs the server's
 * challenge the way an iPhone or Android phone does.
 *
 *   node scripts/run-with-env.cjs node --test --test-force-exit test/passkey.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { prisma, userClient } = require('@wheleers/db');
const { createLocalAccessToken, verifyLocalAccessToken } = require('../apps/api-gateway/dist/auth/local.js');
const { handlePasskeyRoute } = require('../apps/api-gateway/dist/http/passkey.route.js');

const SECRET = 'test-secret-that-is-at-least-32-characters-long';
const made = [];
const b64url = (buf) => Buffer.from(buf).toString('base64url');

function memoryRedis() {
  const store = new Map();
  return {
    get: async (k) => store.get(k) ?? null,
    set: async (k, v) => { store.set(k, String(v)); },
    del: async (k) => { store.delete(k); },
    send: async (cmd, k) => { if (cmd === 'INCR') { const n = Number(store.get(k) ?? 0) + 1; store.set(k, String(n)); return n; } return 1; },
  };
}
const deps = { jwtSecret: SECRET, redisClient: memoryRedis() };

async function call(method, path, { token, body } = {}) {
  let sent;
  const res = { statusCode: 0, setHeader() {}, end(text) { sent = JSON.parse(text); } };
  const req = {
    method,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() { if (body) yield Buffer.from(JSON.stringify(body)); },
  };
  assert.equal(await handlePasskeyRoute(req, res, deps, new URL(`http://x${path}`)), true);
  return { status: res.statusCode, body: sent };
}

/** A phone's passkey: a P-256 key pair, its public half in COSE form as the server stores it. */
function phoneKey() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const x = Buffer.from(jwk.x, 'base64url');
  const y = Buffer.from(jwk.y, 'base64url');
  // CBOR map {1: 2 (EC2), 3: -7 (ES256), -1: 1 (P-256), -2: x, -3: y}
  const cose = Buffer.concat([Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]), x, Buffer.from([0x22, 0x58, 0x20]), y]);
  return { privateKey, cose, credentialId: b64url(crypto.randomBytes(16)) };
}

/** The phone's answer to a sign-in challenge. */
function sign(key, challenge, { origin = 'https://wheelersng.com', rpId = 'wheelersng.com', counter = 1, userId = 'u' } = {}) {
  const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin, crossOrigin: false }));
  const counterBytes = Buffer.alloc(4);
  counterBytes.writeUInt32BE(counter);
  const authenticatorData = Buffer.concat([crypto.createHash('sha256').update(rpId).digest(), Buffer.from([0x05]), counterBytes]);
  const signature = crypto.sign('sha256', Buffer.concat([authenticatorData, crypto.createHash('sha256').update(clientDataJSON).digest()]), key.privateKey);
  return {
    id: key.credentialId, rawId: key.credentialId, type: 'public-key', clientExtensionResults: {},
    response: { clientDataJSON: b64url(clientDataJSON), authenticatorData: b64url(authenticatorData), signature: b64url(signature), userHandle: b64url(Buffer.from(userId)) },
  };
}

async function rider() {
  const user = await prisma.user.create({ data: { privyDid: `did:test:${crypto.randomUUID()}`, role: 'RIDER', name: 'Passkey Rider', phone: `+23480${Math.floor(10000000 + Math.random() * 89999999)}` } });
  made.push(user.id);
  return { user, token: createLocalAccessToken(user.id, SECRET) };
}

test.after(async () => {
  await prisma.userActivityEvent.deleteMany({ where: { userId: { in: made } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: made } } }).catch(() => {});
  await prisma.$disconnect();
});

test('a phone holding the passkey signs in: the same answer as an SMS code, and its count moves on', async () => {
  const { user } = await rider();
  const key = phoneKey();
  await prisma.passkey.create({ data: { userId: user.id, credentialId: key.credentialId, publicKey: key.cose, counter: 0n, transports: ['internal'], deviceName: 'iPhone' } });

  const asked = await call('POST', '/auth/passkey/login/options');
  assert.equal(asked.status, 200);
  assert.equal(asked.body.options.rpId, 'wheelersng.com');
  assert.equal(asked.body.options.userVerification, 'required');

  const signedIn = await call('POST', '/auth/passkey/login/verify', { body: { challengeId: asked.body.challengeId, response: sign(key, asked.body.options.challenge, { counter: 7, userId: user.id }) } });
  assert.equal(signedIn.status, 200, JSON.stringify(signedIn.body));
  assert.equal(signedIn.body.user.id, user.id);
  assert.equal(signedIn.body.isNewUser, false);
  assert.equal(verifyLocalAccessToken(signedIn.body.accessToken, SECRET).sub, user.id);
  const after = await prisma.passkey.findUnique({ where: { credentialId: key.credentialId } });
  assert.equal(after.counter, 7n);
  assert.ok(after.lastUsedAt);
});

test('a challenge works once; another website, an older count (a copied key) and a stranger are refused in words', async () => {
  const { user } = await rider();
  const key = phoneKey();
  await prisma.passkey.create({ data: { userId: user.id, credentialId: key.credentialId, publicKey: key.cose, counter: 10n, transports: ['internal'] } });

  const first = await call('POST', '/auth/passkey/login/options');
  const answer = sign(key, first.body.options.challenge, { counter: 11 });
  assert.equal((await call('POST', '/auth/passkey/login/verify', { body: { challengeId: first.body.challengeId, response: answer } })).status, 200);
  const replay = await call('POST', '/auth/passkey/login/verify', { body: { challengeId: first.body.challengeId, response: answer } });
  assert.equal(replay.body.code, 'PASSKEY_EXPIRED', 'the same challenge cannot be used twice');

  const phishing = await call('POST', '/auth/passkey/login/options');
  const elsewhere = await call('POST', '/auth/passkey/login/verify', { body: { challengeId: phishing.body.challengeId, response: sign(key, phishing.body.options.challenge, { origin: 'https://wheelers-login.example', counter: 12 }) } });
  assert.equal(elsewhere.status, 401);
  assert.equal(elsewhere.body.code, 'PASSKEY_REFUSED');

  const copied = await call('POST', '/auth/passkey/login/options');
  const older = await call('POST', '/auth/passkey/login/verify', { body: { challengeId: copied.body.challengeId, response: sign(key, copied.body.options.challenge, { counter: 3 }) } });
  assert.equal(older.status, 401, 'a count that went backwards is a copied key');

  const stranger = phoneKey();
  const unknown = await call('POST', '/auth/passkey/login/options');
  const nobody = await call('POST', '/auth/passkey/login/verify', { body: { challengeId: unknown.body.challengeId, response: sign(stranger, unknown.body.options.challenge) } });
  assert.equal(nobody.body.code, 'PASSKEY_UNKNOWN');
  assert.match(nobody.body.error, /Sign in with your phone number/);
});

test('signed in: a challenge to make one, the list, removing one; signing out everywhere removes them all', async () => {
  const { user, token } = await rider();
  const made1 = await call('POST', '/auth/passkey/register/options', { token });
  assert.equal(made1.status, 200);
  assert.equal(made1.body.rp.id, 'wheelersng.com');
  assert.equal(made1.body.authenticatorSelection.residentKey, 'required');
  assert.equal(made1.body.user.name, user.phone);

  const expired = await call('POST', '/auth/passkey/register/verify', { token, body: { response: { id: 'x' } } });
  assert.equal(expired.status, 400, 'a made-up answer is refused');

  const key = phoneKey();
  const row = await prisma.passkey.create({ data: { userId: user.id, credentialId: key.credentialId, publicKey: key.cose, transports: [], deviceName: 'Android phone' } });
  const list = await call('GET', '/auth/passkeys', { token });
  assert.deepEqual(list.body.passkeys.map((p) => p.deviceName), ['Android phone']);
  assert.equal((await call('DELETE', `/auth/passkeys/${row.id}`, { token })).body.removed, true);
  assert.equal((await call('GET', '/auth/passkeys', { token })).body.passkeys.length, 0);

  await prisma.passkey.create({ data: { userId: user.id, credentialId: phoneKey().credentialId, publicKey: key.cose, transports: [] } });
  await userClient.endSessions(user.id);
  assert.equal(await prisma.passkey.count({ where: { userId: user.id } }), 0);
  assert.equal((await call('GET', '/auth/passkeys')).status, 401, 'nothing for someone not signed in');
});
