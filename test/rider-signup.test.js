// The rider app's account journey, end to end against a real database:
//
//   sign up (email+password / Google / Apple)  →  enter phone  →  code on
//   WhatsApp or SMS  →  verify  →  phone attached to the account
//
// Outbound HTTP is stubbed, so no real message is ever sent. Google/Apple
// token verification is stubbed the same way.
//
//   DATABASE_URL=… node --test test/rider-signup.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { PrismaClient } = require('@prisma/client');

const authRoute = require('../apps/api-gateway/dist/http/auth.route.js');
const socialRoute = require('../apps/api-gateway/dist/http/social-auth.route.js');
const phoneRoute = require('../apps/api-gateway/dist/http/phone.route.js');
const phoneLoginRoute = require('../apps/api-gateway/dist/http/phone-login.route.js');

const prisma = new PrismaClient();
const JWT_SECRET = 'test-secret-that-is-at-least-32-characters-long';

/** Twilio only — proves the rider app works without Meta being reachable. */
const OTP_DEPS = {
  twilioAccountSid: 'ACtest',
  twilioAuthToken: 'secret',
  twilioWhatsappNumber: '+14155238886',
  twilioFromNumber: '+14155550100',
};

const created = [];
let sentMessages = [];
let publishedEvents = [];

/**
 * Signup publishes a USER_CREATED event and kicks off deposit-account provisioning.
 * Neither belongs in this test's scope, so both are stubbed — but the publisher
 * records what it was given, so the test can assert the event still fires.
 */
const SIGNUP_DEPS = {
  jwtSecret: JWT_SECRET,
  publisher: {
    publishUserEvent: async (event) => { publishedEvents.push(event); },
    publishCryptoWalletEvent: async () => {},
  },
  paymentsClient: {
    // Unique per call: providerCustomerId is a unique column, and a shared stub
    // id makes the background provisioning log a constraint error.
    createCustomer: async () => ({ id: `cus_${Math.random().toString(36).slice(2, 12)}` }),
    findCustomerByReference: async () => null,
    updateCustomer: async () => ({}),
    createVirtualAccount: async () => ({
      id: `va_${Math.random().toString(36).slice(2, 12)}`,
      bank_name: 'Test Bank',
      account_number: String(Math.floor(1e9 + Math.random() * 9e9)),
      account_name: 'Test Account', currency: 'NGN', country: 'NG',
    }),
  },
};

/* ── plumbing ──────────────────────────────────────────────────────────── */

function req(body, token) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  return {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c;
    },
  };
}

function res() {
  const out = { status: 200, body: null };
  return {
    out,
    res: {
      set statusCode(v) { out.status = v; },
      get statusCode() { return out.status; },
      setHeader() {},
      writeHead(code) { out.status = code; return this; },
      end(body) { out.body = body ? JSON.parse(body) : null; },
    },
  };
}

const call = async (handler, ...args) => {
  const { out, res: r } = res();
  await handler(args[0], r, ...args.slice(1));
  return out;
};

/** Redis stand-in — the OTP routes only need get/set/del with a TTL. */
function memoryRedis() {
  const store = new Map();
  return {
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async set(k, v) { store.set(k, v); },
    async del(k) { store.delete(k); },
    async send(cmd, k) {
      if (cmd === 'INCR') { const n = Number(store.get(k) ?? 0) + 1; store.set(k, String(n)); return n; }
      if (cmd === 'TTL') return 300;
      if (cmd === 'DECR') { const n = Number(store.get(k) ?? 0) - 1; store.set(k, String(n)); return n; }
      if (cmd === 'EXPIRE') return 1;
      return null;
    },
  };
}

const originalFetch = global.fetch;

test.before(() => {
  // Capture Twilio sends; fail loudly on anything else leaving the process.
  global.fetch = async (url, init) => {
    const href = String(url);
    if (href.includes('api.twilio.com')) {
      const params = new URLSearchParams(String(init?.body ?? ''));
      sentMessages.push({ to: params.get('To'), from: params.get('From'), body: params.get('Body') });
      return {
        ok: true, status: 201,
        text: async () => '{"sid":"SMtest"}',
        json: async () => ({ sid: 'SMtest' }),
      };
    }
    throw new Error(`unexpected outbound request in test: ${href}`);
  };
});

test.after(async () => {
  global.fetch = originalFetch;
  // Let any in-flight background provisioning finish so teardown is not racing it.
  await new Promise((resolve) => setTimeout(resolve, 250));
  const ids = created.filter(Boolean);
  const walletIds = (
    await prisma.wallet.findMany({ where: { userId: { in: ids } }, select: { id: true } })
  ).map((w) => w.id);
  await prisma.transaction.deleteMany({ where: { walletId: { in: walletIds } } });
  // Provisioning runs in the background after signup, so a virtual account may
  // land between the test finishing and this teardown.
  await prisma.virtualAccount.deleteMany({ where: { userId: { in: ids } } });
  await prisma.wallet.deleteMany({ where: { userId: { in: ids } } });
  await prisma.driver.deleteMany({ where: { userId: { in: ids } } });
  await prisma.userActivityEvent.deleteMany({ where: { userId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
  await prisma.$disconnect();
});

const unique = () => Math.random().toString(36).slice(2, 10);

/* ── signup ────────────────────────────────────────────────────────────── */

test('email + password signup creates a rider, not a driver', async () => {
  const email = `rider.${unique()}@example.com`;
  const out = await call(
    authRoute.handleUsernamePasswordSignupRoute,
    req({ email, password: 'correct-horse-battery', fullName: 'Ada Rider' }),
    SIGNUP_DEPS,
  );

  assert.equal(out.status, 201, JSON.stringify(out.body));
  assert.ok(out.body.accessToken);
  assert.equal(out.body.user.role, 'RIDER');
  created.push(out.body.user.id);

  const driver = await prisma.driver.findUnique({ where: { userId: out.body.user.id } });
  assert.equal(driver, null, 'a rider must not get a Driver record');
});

test('signing up as a driver still produces a driver', async () => {
  const email = `driver.${unique()}@example.com`;
  const out = await call(
    authRoute.handleUsernamePasswordSignupRoute,
    req({ email, password: 'correct-horse-battery', fullName: 'Musa Driver', role: 'DRIVER' }),
    SIGNUP_DEPS,
  );

  assert.equal(out.status, 201, JSON.stringify(out.body));
  assert.equal(out.body.user.role, 'DRIVER');
  created.push(out.body.user.id);

  const driver = await prisma.driver.findUnique({ where: { userId: out.body.user.id } });
  assert.ok(driver, 'a driver signup must create the Driver record');
});

test('Google sign-in creates a RIDER by default', async () => {
  // Stub token verification: we are testing our own branching, not Google's JWKS.
  const sub = `google-sub-${unique()}`;
  const original = socialRoute.__setTokenVerifierForTests;
  assert.equal(typeof original, 'function', 'social-auth must expose a test seam');
  original(async () => ({ sub, email: `g.${unique()}@example.com`, name: 'Gbenga Rider' }));

  try {
    const out = await call(
      socialRoute.handleGoogleAuthRoute,
      req({ idToken: 'stub' }),
      { jwtSecret: JWT_SECRET, googleClientId: 'test-client' },
    );

    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(out.body.user.role, 'RIDER', 'social sign-in used to hardcode DRIVER');
    assert.equal(out.body.user.isNewUser, true);
    created.push(out.body.user.id);

    const driver = await prisma.driver.findUnique({ where: { userId: out.body.user.id } });
    assert.equal(driver, null);
  } finally {
    original(null);
  }
});

test('Google sign-in with role=driver produces a driver', async () => {
  const sub = `google-sub-${unique()}`;
  socialRoute.__setTokenVerifierForTests(async () => ({
    sub, email: `gd.${unique()}@example.com`, name: 'Sani Driver',
  }));

  try {
    const out = await call(
      socialRoute.handleGoogleAuthRoute,
      req({ idToken: 'stub', role: 'driver' }),
      { jwtSecret: JWT_SECRET, googleClientId: 'test-client' },
    );

    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(out.body.user.role, 'DRIVER');
    created.push(out.body.user.id);
    assert.ok(await prisma.driver.findUnique({ where: { userId: out.body.user.id } }));
  } finally {
    socialRoute.__setTokenVerifierForTests(null);
  }
});

test('signing in again with the same Google account reuses the user', async () => {
  const sub = `google-sub-${unique()}`;
  const email = `repeat.${unique()}@example.com`;
  socialRoute.__setTokenVerifierForTests(async () => ({ sub, email, name: 'Repeat Rider' }));

  try {
    const first = await call(
      socialRoute.handleGoogleAuthRoute,
      req({ idToken: 'stub' }),
      { jwtSecret: JWT_SECRET, googleClientId: 'test-client' },
    );
    created.push(first.body.user.id);
    assert.equal(first.body.user.isNewUser, true);

    const second = await call(
      socialRoute.handleGoogleAuthRoute,
      req({ idToken: 'stub' }),
      { jwtSecret: JWT_SECRET, googleClientId: 'test-client' },
    );
    assert.equal(second.body.user.isNewUser, false);
    assert.equal(second.body.user.id, first.body.user.id, 'a second sign-in must not fork the account');
  } finally {
    socialRoute.__setTokenVerifierForTests(null);
  }
});

/* ── phone verification ────────────────────────────────────────────────── */

test('a new rider verifies their phone by WhatsApp code', async () => {
  sentMessages = [];
  const redisClient = memoryRedis();
  const deps = { jwtSecret: JWT_SECRET, redisClient, ...OTP_DEPS };

  // 1. Sign up.
  const signup = await call(
    authRoute.handleUsernamePasswordSignupRoute,
    req({ email: `flow.${unique()}@example.com`, password: 'correct-horse-battery', fullName: 'Chidi Rider' }),
    SIGNUP_DEPS,
  );
  assert.equal(signup.status, 201);
  const token = signup.body.accessToken;
  created.push(signup.body.user.id);
  assert.equal(signup.body.user.phone, null, 'phone comes later, in its own step');

  // 2. Enter a phone number → code goes out.
  const phone = `+23480${Math.floor(10000000 + Math.random() * 89999999)}`.slice(0, 14);
  const send = await call(phoneRoute.handleSendPhoneOtpRoute, req({ phone }, token), deps);
  assert.equal(send.status, 200, JSON.stringify(send.body));
  assert.equal(send.body.sent, true);
  assert.ok(['whatsapp', 'sms'].includes(send.body.channel));
  assert.equal(send.body.phone, phone);

  assert.equal(sentMessages.length, 1, 'exactly one message should be sent');
  assert.equal(sentMessages[0].to, `whatsapp:${phone}`, 'WhatsApp is tried before SMS');
  const code = sentMessages[0].body.match(/\b(\d{6})\b/)?.[1];
  assert.ok(code, `no 6-digit code in: ${sentMessages[0].body}`);

  // 3. A wrong code is refused.
  const wrong = await call(
    phoneRoute.handleVerifyPhoneOtpRoute,
    req({ code: code === '000000' ? '111111' : '000000' }, token),
    deps,
  );
  assert.equal(wrong.status, 400);
  assert.match(wrong.body.error, /Invalid verification code/);

  // 4. The real code attaches the phone to the account.
  const verify = await call(phoneRoute.handleVerifyPhoneOtpRoute, req({ code }, token), deps);
  assert.equal(verify.status, 200, JSON.stringify(verify.body));
  assert.equal(verify.body.verified, true);
  assert.equal(verify.body.user.phone, phone);

  const stored = await prisma.user.findUniqueOrThrow({ where: { id: signup.body.user.id } });
  assert.equal(stored.phone, phone, 'the phone must be persisted, not just echoed');
});

test('a used code cannot be replayed', async () => {
  sentMessages = [];
  const redisClient = memoryRedis();
  const deps = { jwtSecret: JWT_SECRET, redisClient, ...OTP_DEPS };

  const signup = await call(
    authRoute.handleUsernamePasswordSignupRoute,
    req({ email: `replay.${unique()}@example.com`, password: 'correct-horse-battery', fullName: 'Replay Rider' }),
    SIGNUP_DEPS,
  );
  created.push(signup.body.user.id);
  const token = signup.body.accessToken;
  const phone = `+23481${Math.floor(10000000 + Math.random() * 89999999)}`.slice(0, 14);

  await call(phoneRoute.handleSendPhoneOtpRoute, req({ phone }, token), deps);
  const code = sentMessages[0].body.match(/\b(\d{6})\b/)[1];

  const first = await call(phoneRoute.handleVerifyPhoneOtpRoute, req({ code }, token), deps);
  assert.equal(first.status, 200);

  const second = await call(phoneRoute.handleVerifyPhoneOtpRoute, req({ code }, token), deps);
  assert.equal(second.status, 400, 'the code must be consumed on first use');
});

test('a malformed phone number is rejected before anything is sent', async () => {
  sentMessages = [];
  const deps = { jwtSecret: JWT_SECRET, redisClient: memoryRedis(), ...OTP_DEPS };

  const signup = await call(
    authRoute.handleUsernamePasswordSignupRoute,
    req({ email: `bad.${unique()}@example.com`, password: 'correct-horse-battery', fullName: 'Bad Number' }),
    SIGNUP_DEPS,
  );
  created.push(signup.body.user.id);

  const out = await call(
    phoneRoute.handleSendPhoneOtpRoute,
    req({ phone: '0801234' }, signup.body.accessToken),
    deps,
  );
  assert.equal(out.status, 400);
  assert.match(out.body.error, /E\.164/);
  assert.equal(sentMessages.length, 0, 'nothing should be sent for an invalid number');
});

test('phone verification requires a signed-in account', async () => {
  const deps = { jwtSecret: JWT_SECRET, redisClient: memoryRedis(), ...OTP_DEPS };
  const out = await call(phoneRoute.handleSendPhoneOtpRoute, req({ phone: '+2348012345678' }), deps);
  assert.equal(out.status, 400);
  assert.match(out.body.error, /Authorization bearer token is required/);
});

/* ── passwordless entry (what the rider app now opens on) ──────────────── */

/**
 * The rider app's first screen is a phone number, with no account behind it.
 * These routes have to resolve the number to an account — the same one the
 * WhatsApp bot uses — or create it, and hand back a session.
 */
const loginDeps = (redisClient) => ({
  jwtSecret: JWT_SECRET,
  redisClient,
  ...OTP_DEPS,
  onboarding: {
    jwtSecret: JWT_SECRET,
    publisher: SIGNUP_DEPS.publisher,
    paymentsClient: SIGNUP_DEPS.paymentsClient,
  },
});

test('a number with no account gets a code and a session', async () => {
  sentMessages = [];
  const deps = loginDeps(memoryRedis());
  const phone = `+23482${Math.floor(10000000 + Math.random() * 89999999)}`.slice(0, 14);

  const send = await call(phoneLoginRoute.handlePhoneLoginSendOtpRoute, req({ phone }), deps);
  assert.equal(send.status, 200, JSON.stringify(send.body));
  assert.equal(send.body.sent, true);
  assert.equal(sentMessages.length, 1);
  const code = sentMessages[0].body.match(/\b(\d{6})\b/)[1];

  const verify = await call(phoneLoginRoute.handlePhoneLoginVerifyOtpRoute, req({ phone, code }), deps);
  assert.equal(verify.status, 200, JSON.stringify(verify.body));
  assert.ok(verify.body.accessToken, 'the code is the sign-in, so a session must come back');
  assert.equal(verify.body.isNewUser, true);
  assert.equal(verify.body.user.phone, phone);
  assert.equal(verify.body.user.role, 'RIDER');
  created.push(verify.body.user.id);
});

test('the same number signs back into the same account', async () => {
  sentMessages = [];
  const deps = loginDeps(memoryRedis());
  const phone = `+23483${Math.floor(10000000 + Math.random() * 89999999)}`.slice(0, 14);

  await call(phoneLoginRoute.handlePhoneLoginSendOtpRoute, req({ phone }), deps);
  const first = await call(
    phoneLoginRoute.handlePhoneLoginVerifyOtpRoute,
    req({ phone, code: sentMessages[0].body.match(/\b(\d{6})\b/)[1] }),
    deps,
  );
  created.push(first.body.user.id);

  sentMessages = [];
  const deps2 = loginDeps(memoryRedis());
  await call(phoneLoginRoute.handlePhoneLoginSendOtpRoute, req({ phone }), deps2);
  const second = await call(
    phoneLoginRoute.handlePhoneLoginVerifyOtpRoute,
    req({ phone, code: sentMessages[0].body.match(/\b(\d{6})\b/)[1] }),
    deps2,
  );

  assert.equal(second.body.isNewUser, false);
  assert.equal(second.body.user.id, first.body.user.id, 'one number is one account');
});

test('a wrong code never hands out a session', async () => {
  sentMessages = [];
  const deps = loginDeps(memoryRedis());
  const phone = `+23484${Math.floor(10000000 + Math.random() * 89999999)}`.slice(0, 14);

  await call(phoneLoginRoute.handlePhoneLoginSendOtpRoute, req({ phone }), deps);
  const real = sentMessages[0].body.match(/\b(\d{6})\b/)[1];

  const wrong = await call(
    phoneLoginRoute.handlePhoneLoginVerifyOtpRoute,
    req({ phone, code: real === '000000' ? '111111' : '000000' }),
    deps,
  );
  assert.equal(wrong.status, 400);
  assert.equal(wrong.body.accessToken, undefined);
  assert.equal(wrong.body.code, 'OTP_INVALID');
  assert.ok(wrong.body.attemptsRemaining >= 1, 'the rider should be told how many tries are left');
});
