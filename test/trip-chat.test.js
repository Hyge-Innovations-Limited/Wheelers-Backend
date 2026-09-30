// Trip chat and Live call: who may talk on a trip and when, the phone-number
// block, TURN logins, and calls rung, answered, relayed and ended across two
// gateway processes. Against a real Redis (database 15, emptied first) and a
// real Postgres.
//
//   node scripts/run-with-env.cjs node --test --test-force-exit test/trip-chat.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { randomUUID, createHmac } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const WebSocket = require('../apps/api-gateway/node_modules/ws');

const { RedisClient } = require('../apps/api-gateway/dist/redis/client.js');
const { SocketRegistry } = require('../apps/api-gateway/dist/websocket/registry.js');
const { createGatewayWebSocketServer } = require('../apps/api-gateway/dist/websocket/server.js');
const local = require('../apps/api-gateway/dist/auth/local.js');
const { containsPhoneNumber } = require('../apps/api-gateway/dist/trip-chat/phone-guard.js');
const { turnCredentials, iceServersFor } = require('../apps/api-gateway/dist/trip-chat/ice-servers.js');
const { chatWindow, CHAT_AFTER_TRIP_MS } = require('../apps/api-gateway/dist/trip-chat/access.js');
const { createTripChatService } = require('../apps/api-gateway/dist/trip-chat/service.js');
const { handleTripChatPageRoute } = require('../apps/api-gateway/dist/trip-chat/page.route.js');

const REDIS_URL = process.env.TEST_REDIS_URL || 'redis://127.0.0.1:6379/15';
const JWT_SECRET = 'test-secret-that-is-at-least-32-characters-long';
const TURN = { host: 'turn.example.test', secret: 'turn-test-secret', ttlSeconds: 7200 };
const prisma = new PrismaClient();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── what needs no database ─────────────────────────────────────────────── */

test('a phone number is found however it is typed, and ordinary messages pass', () => {
  for (const text of [
    '08031234567', 'call me 0803 123 4567', '0803-123-4567', '+234 803 123 4567', '234.803.123.4567',
    '8031234567', 'O8O31234567', 'my number na 0 8 0 3 1 2 3 4 5 6 7', '(0803) 123-4567', '+2348031234567',
  ]) assert.equal(containsPhoneNumber(text), true, text);
  for (const text of [
    'I am at the gate', '₦2,500', 'WH-01234', 'plate KJA 123 AB', '10 minutes', 'trip 12345678',
    'see you by 10:30', '₦12,500,000', 'I dey come in 5 mins o',
  ]) assert.equal(containsPhoneNumber(text), false, text);
});

test("a TURN login is coturn's REST scheme: expiry:user, HMAC-SHA1 of it with the shared secret", () => {
  const now = Date.UTC(2026, 8, 29, 12, 0, 0);
  const login = turnCredentials('user-1', 'secret', 3600, now);
  const expiry = Math.floor(now / 1000) + 3600;
  assert.equal(login.username, `${expiry}:user-1`);
  assert.equal(login.credential, createHmac('sha1', 'secret').update(`${expiry}:user-1`).digest('base64'));

  assert.deepEqual(iceServersFor('u', { ttlSeconds: 60 }), [], 'no server configured, none offered');
  assert.deepEqual(iceServersFor('u', { host: 'h', ttlSeconds: 60 }), [{ urls: ['stun:h:3478'] }], 'no secret, STUN only');
  const servers = iceServersFor('u', { host: 'h', secret: 's', ttlSeconds: 60 }, now);
  assert.deepEqual(servers[1].urls, ['turn:h:3478?transport=udp', 'turn:h:3478?transport=tcp', 'turns:h:443?transport=tcp']);
  assert.equal(servers[1].credential, createHmac('sha1', 's').update(servers[1].username).digest('base64'));
});

test('the chat opens when a driver is assigned and closes when the trip ends (or a set time after)', () => {
  const now = Date.now();
  const base = { driverId: 'd', completedAt: null, cancelledAt: null, updatedAt: new Date(now) };
  assert.equal(chatWindow({ ...base, status: 'MATCHING', driverId: null }, now).open, false);
  for (const status of ['DRIVER_ASSIGNED', 'DRIVER_EN_ROUTE', 'ARRIVED', 'IN_PROGRESS']) {
    assert.deepEqual(chatWindow({ ...base, status }, now), { open: true, closesAt: null }, status);
  }
  // By default the chat closes the moment the trip ends or is cancelled.
  assert.equal(CHAT_AFTER_TRIP_MS, 0);
  const ended = chatWindow({ ...base, status: 'COMPLETED', completedAt: new Date(now - 1000) }, now);
  assert.deepEqual([ended.open, ended.closesAt.getTime()], [false, now - 1000]);
  assert.equal(chatWindow({ ...base, status: 'CANCELLED', cancelledAt: new Date(now - 1000) }, now).open, false);
  // TRIP_CHAT_AFTER_TRIP_MINUTES = 30 keeps it open half an hour longer.
  const thirty = 30 * 60_000;
  assert.equal(chatWindow({ ...base, status: 'COMPLETED', completedAt: new Date(now - 10 * 60_000) }, now, thirty).open, true);
  assert.equal(chatWindow({ ...base, status: 'COMPLETED', completedAt: new Date(now - 31 * 60_000) }, now, thirty).open, false);
  assert.equal(chatWindow({ ...base, status: 'CANCELLED', driverId: null, cancelledAt: new Date(now) }, now, thirty).open, false, 'cancelled before a driver: never opened');
});

test('a Trip chat link names its ride, and no other page accepts it', () => {
  const token = local.createWalletPageToken('rider-1', 'trip', JWT_SECRET, 600, 'ride-1');
  assert.deepEqual(local.verifyWalletPageToken(token, JWT_SECRET), { userId: 'rider-1', scope: 'trip', rideId: 'ride-1' });
  assert.throws(() => local.createWalletPageToken('rider-1', 'trip', JWT_SECRET, 600), /must name its ride/);
  assert.throws(() => local.verifyLocalAccessToken(token, JWT_SECRET), 'never a login');
  const rideLink = local.createWalletPageToken('rider-1', 'ride', JWT_SECRET, 600);
  assert.equal(local.verifyWalletPageToken(rideLink, JWT_SECRET).rideId, undefined);
});

test('the ride card status light: Meta is asked only when the status changes, "none" removes it, and a refusal says so', async () => {
  const { rememberRideCard, setCardStatus, cardStatusOf } = require('../apps/api-gateway/dist/trip-chat/card-status.js');
  const store = new Map();
  const redis = { get: async (k) => store.get(k) ?? null, set: async (k, v) => { store.set(k, v); }, del: async (k) => { store.delete(k); } };
  const calls = [];
  let refuse = false;
  const realFetch = global.fetch;
  global.fetch = async (_url, init) => { calls.push(JSON.parse(init.body).reaction); return { ok: !refuse, status: refuse ? 400 : 200, text: async () => '' }; };
  try {
    const deps = { redis, meta: { metaAccessToken: 't', metaPhoneNumberId: '1' } };
    assert.equal(await setCardStatus(deps, 'ride-x', 'message'), false, 'no card yet: the caller sends a real message');
    await rememberRideCard(deps, 'ride-x', '+2348030000001', 'wamid.CARD');
    assert.deepEqual(calls, [{ message_id: 'wamid.CARD', emoji: '🟢' }]);
    await setCardStatus(deps, 'ride-x', 'message');
    await setCardStatus(deps, 'ride-x', 'message');
    await setCardStatus(deps, 'ride-x', 'message');
    assert.equal(calls.length, 2, 'three messages, one reaction');
    assert.equal(await cardStatusOf(redis, 'ride-x'), 'message');
    refuse = true;
    assert.equal(await setCardStatus(deps, 'ride-x', 'call'), false, 'refused: say so');
    assert.equal(await cardStatusOf(redis, 'ride-x'), 'message', 'and the status is not pretended');
    refuse = false;
    assert.equal(await setCardStatus(deps, 'ride-x', 'none'), true);
    assert.deepEqual(calls.at(-1), { message_id: 'wamid.CARD', emoji: '' }, 'removed');
    assert.equal(await cardStatusOf(redis, 'ride-x'), null, 'forgotten with the trip');
  } finally {
    global.fetch = realFetch;
  }
});

test('the status light lives on the chat message: a fresh link takes it over, the old one loses it, the status carries', async () => {
  const { rememberRideCard, setCardStatus, cardStatusOf } = require('../apps/api-gateway/dist/trip-chat/card-status.js');
  const { tripChatLinkText } = require('../apps/api-gateway/dist/whatsapp/ride-card.js');
  const store = new Map();
  const redis = { get: async (k) => store.get(k) ?? null, set: async (k, v) => { store.set(k, v); }, del: async (k) => { store.delete(k); } };
  const calls = [];
  const realFetch = global.fetch;
  global.fetch = async (_url, init) => { calls.push(JSON.parse(init.body).reaction); return { ok: true, status: 200, text: async () => '' }; };
  try {
    const deps = { redis, meta: { metaAccessToken: 't', metaPhoneNumberId: '1' } };
    await rememberRideCard(deps, 'ride-y', '+2348030000001', 'wamid.CHAT1');
    await setCardStatus(deps, 'ride-y', 'message');
    await rememberRideCard(deps, 'ride-y', '+2348030000001', 'wamid.CHAT2');   // the rider asked for a fresh link
    assert.deepEqual(calls, [
      { message_id: 'wamid.CHAT1', emoji: '🟢' },
      { message_id: 'wamid.CHAT1', emoji: '💬' },
      { message_id: 'wamid.CHAT1', emoji: '' },
      { message_id: 'wamid.CHAT2', emoji: '💬' },
    ], 'one message wears it, and it keeps saying there is a message');
    assert.equal(await cardStatusOf(redis, 'ride-y'), 'message');
    await rememberRideCard(deps, 'ride-y', '+2348030000001', 'wamid.CHAT2');
    assert.equal(calls.length, 4, 'the same message again: nothing to do');
  } finally {
    global.fetch = realFetch;
  }
  assert.match(tripChatLinkText('Oke', true), /Message or call \*Oke\*.*\n\nOn this message: 🟢 trip on · 💬 new message · 📞 calling\./s);
  assert.doesNotMatch(tripChatLinkText('Oke', false), /📞/);
});

/* ── two gateway processes, one Redis, one Postgres ─────────────────────── */

const clients = [];
async function redis() {
  const client = new RedisClient(REDIS_URL);
  await client.connect();
  clients.push(client);
  return client;
}

const made = { users: [], rides: [] };
async function user(role, name) {
  const id = randomUUID();
  await prisma.user.create({ data: { id, privyDid: `test:trip-chat:${id}`, role, name, phone: `+23480${Math.floor(10000000 + Math.random() * 89999999)}` } });
  made.users.push(id);
  return id;
}
async function trip({ status = 'IN_PROGRESS', channel = 'APP', completedAt = null } = {}) {
  const riderId = await user('RIDER', 'Ada Obi');
  const driverUserId = await user('DRIVER', 'Tunde Bakare');
  const driver = await prisma.driver.create({ data: { userId: driverUserId, kycStatus: 'APPROVED', vehicleMake: 'Toyota', vehicleModel: 'Corolla', vehiclePlate: 'KJA-123AB' } });
  const ride = await prisma.ride.create({ data: {
    riderId, driverId: driver.id, status, channel, completedAt,
    pickupLat: 6.5, pickupLng: 3.37, pickupAddress: 'Yaba', destLat: 6.45, destLng: 3.43, destAddress: 'Lekki',
  } });
  made.rides.push(ride.id);
  return { rideId: ride.id, riderId, driverUserId };
}

const captured = { pushes: [], rideEvents: [], whatsapp: [] };
const publisher = {
  publishRideEvent: async (event) => { captured.rideEvents.push(event); },
  publishNotificationEvent: async (event) => { captured.pushes.push(event); },
  publishDriverEvent: async () => {},
};
// The ride card's status light: rides listed in `cards` have a card to react to.
const cards = new Map();
const whatsapp = {
  pageUrl: (riderId, rideId, callId) => `https://app.test/widget/trip/chat.html#rider=${riderId}&ride=${rideId}${callId ? `&call=${callId}` : ''}`,
  send: async (phone, body, button) => { captured.whatsapp.push({ phone, body, button }); },
  setCardStatus: async (rideId, status) => {
    if (!cards.has(rideId)) return false;
    cards.get(rideId).push(status);
    return true;
  },
};

const gateways = [];
async function gateway(callOptions = {}) {
  const commandRedis = await redis();
  const registry = new SocketRegistry({ instanceId: `trip-${randomUUID()}`, commandRedis, subscriberRedis: await redis() });
  await registry.start();
  const tripChat = createTripChatService({
    redis: commandRedis,
    sockets: registry,
    publisher,
    whatsapp,
    calls: { enabled: true, turn: TURN, ...callOptions },
  });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    handleTripChatPageRoute(req, res, { jwtSecret: JWT_SECRET, tripChat }, url).then((handled) => {
      if (!handled) { res.statusCode = 404; res.end(); }
    });
  });
  createGatewayWebSocketServer({
    server, jwtSecret: JWT_SECRET, allowedOrigins: new Set(), idleTimeoutMs: 60_000, registry,
    publisher, routePlanner: {}, redis: await redis(), tripChat, pageOrigins: new Set(),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const g = { server, registry, tripChat, port, url: (token) => `ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}` };
  gateways.push(g);
  return g;
}

function open(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.inbox = [];
    socket.on('message', (raw) => socket.inbox.push(JSON.parse(raw.toString())));
    socket.once('open', () => resolve(socket));
    socket.once('unexpected-response', (_req, res) => reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode })));
    socket.once('error', reject);
  });
}
async function connect(g, userId, registryToWatch) {
  const socket = await open(g.url(local.createLocalAccessToken(userId, JWT_SECRET)));
  await until(() => (registryToWatch ?? g.registry).isUserConnected(userId));
  return socket;
}
async function until(check, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await sleep(25);
  }
  return false;
}
/** The first message of this type (and shape) the socket has received, waiting up to `ms` for it. */
async function next(socket, type, match = () => true, ms = 4000) {
  let found = null;
  await until(() => {
    const index = socket.inbox.findIndex((m) => m.type === type && match(m.payload));
    if (index === -1) return false;
    found = socket.inbox.splice(index, 1)[0].payload;
    return true;
  }, ms);
  if (!found) throw new Error(`no ${type} arrived; inbox: ${JSON.stringify(socket.inbox.map((m) => [m.type, m.payload?.code ?? '']))}`);
  return found;
}
const say = (socket, type, payload) => socket.send(JSON.stringify({ type, payload }));
const sockets = [];
async function sock(g, userId) { const s = await connect(g, userId); sockets.push(s); return s; }

let A;
let B;
test('two gateways', { concurrency: false }, async (t) => {
  console.info = () => {};
  console.warn = () => {};
  const flush = await redis();
  await flush.send('FLUSHDB');
  A = await gateway({ ringMs: { app: 400, whatsapp: 600 } });
  B = await gateway({ ringMs: { app: 400, whatsapp: 600 } });

  await t.test('a message reaches both people on the trip at once, across processes, and a push goes to the other', async () => {
    const { rideId, riderId, driverUserId } = await trip();
    const rider = await sock(A, riderId);
    const driver = await sock(B, driverUserId);
    captured.pushes.length = 0;

    say(rider, 'chat:send', { rideId, content: '  I am at the gate  ', clientId: 'c-1' });
    const accepted = await next(rider, 'chat:send:accepted');
    assert.equal(accepted.clientId, 'c-1');
    assert.equal(accepted.message.content, 'I am at the gate', 'trimmed');
    const atDriver = await next(driver, 'chat:message');
    assert.equal(atDriver.messageId, accepted.messageId);
    assert.equal(atDriver.senderRole, 'RIDER');
    assert.equal(atDriver.senderName, 'Ada');
    const atRider = await next(rider, 'chat:message');
    assert.equal(atRider.messageId, accepted.messageId, "the sender's own screens get it too");

    await until(() => captured.pushes.some((p) => p.userId === driverUserId));
    const push = captured.pushes.find((p) => p.userId === driverUserId);
    assert.equal(push.title, 'Ada (your rider)');
    assert.equal(push.body, 'I am at the gate');
    assert.deepEqual(push.data, { type: 'chat:message', rideId, messageId: accepted.messageId });
    assert.equal(captured.pushes.some((p) => p.userId === riderId), false, 'no push to the sender');

    say(driver, 'chat:history', { rideId });
    const history = await next(driver, 'chat:history');
    assert.equal(history.messages.length, 1);
    assert.equal(history.other.name, 'Ada');
    assert.equal(history.open, true);
  });

  await t.test('someone not on the trip can neither send into it nor read it', async () => {
    const { rideId, riderId } = await trip();
    const rider = await sock(A, riderId);
    const strangerId = await user('RIDER', 'Stranger');
    const stranger = await sock(B, strangerId);
    say(stranger, 'chat:send', { rideId, content: 'hello' });
    const refused = await next(stranger, 'error');
    assert.equal(refused.code, 'NOT_ON_TRIP');
    assert.equal(refused.requestType, 'chat:send');
    say(stranger, 'chat:history', { rideId });
    assert.equal((await next(stranger, 'error')).code, 'NOT_ON_TRIP');
    await sleep(200);
    assert.equal(rider.inbox.some((m) => m.type === 'chat:message'), false, 'nothing reached the rider');
    assert.equal(await prisma.chatMessage.count({ where: { rideId } }), 0);
  });

  await t.test("a driver cannot send their phone number; a rider's own words are not checked", async () => {
    const { rideId, riderId, driverUserId } = await trip();
    const driver = await sock(A, driverUserId);
    const rider = await sock(B, riderId);
    say(driver, 'chat:send', { rideId, content: 'call me on 0803 123 4567' });
    const refused = await next(driver, 'error');
    assert.equal(refused.code, 'PHONE_NUMBER');
    say(rider, 'chat:send', { rideId, content: 'my other line is 0803 123 4567' });
    await next(rider, 'chat:send:accepted');
  });

  await t.test('the chat is closed once the trip has ended', async () => {
    const { rideId, riderId } = await trip({ status: 'COMPLETED', completedAt: new Date(Date.now() - 1000) });
    const rider = await sock(A, riderId);
    say(rider, 'chat:send', { rideId, content: 'I left my bag' });
    assert.equal((await next(rider, 'error')).code, 'CHAT_CLOSED');
    say(rider, 'call:start', { rideId });
    assert.equal((await next(rider, 'error')).code, 'CHAT_CLOSED');
  });

  await t.test('a call: rung, answered, connection details relayed both ways, hung up, and on record', async () => {
    const { rideId, riderId, driverUserId } = await trip();
    const rider = await sock(A, riderId);
    const driver = await sock(B, driverUserId);
    captured.pushes.length = 0;

    say(rider, 'call:start', { rideId });
    const started = await next(rider, 'call:start:accepted');
    assert.equal(started.state, 'ringing');
    assert.equal(started.direction, 'outgoing');
    assert.equal(started.other.name, 'Tunde');
    assert.equal(started.iceServers[1].username.endsWith(`:${riderId}`), true, "the caller's own TURN login");

    const incoming = await next(driver, 'call:incoming');
    assert.equal(incoming.callId, started.callId);
    assert.equal(incoming.direction, 'incoming');
    assert.equal(incoming.other.name, 'Ada');
    assert.equal(incoming.iceServers[1].username.endsWith(`:${driverUserId}`), true, "the driver's own TURN login");
    await until(() => captured.pushes.some((p) => p.data?.type === 'call:incoming'));
    const ringPush = captured.pushes.find((p) => p.data?.type === 'call:incoming');
    assert.equal(ringPush.userId, driverUserId);
    assert.equal(ringPush.priority, 'high');

    say(rider, 'call:start', { rideId });
    assert.equal((await next(rider, 'error')).code, 'CALL_BUSY', 'one call at a time');

    say(driver, 'call:accept', { callId: started.callId });
    await next(driver, 'call:accept:accepted');
    const accepted = await next(rider, 'call:accepted');
    assert.equal(accepted.state, 'active');
    await next(driver, 'call:answered');

    say(rider, 'call:signal', { callId: started.callId, signal: { type: 'offer', sdp: 'v=0 offer' } });
    assert.deepEqual((await next(driver, 'call:signal')).signal, { type: 'offer', sdp: 'v=0 offer' });
    say(driver, 'call:signal', { callId: started.callId, signal: { type: 'answer', sdp: 'v=0 answer' } });
    assert.deepEqual((await next(rider, 'call:signal')).signal, { type: 'answer', sdp: 'v=0 answer' });
    say(driver, 'call:signal', { callId: started.callId, signal: { type: 'candidate', candidate: { candidate: 'candidate:1 1 udp 1 1.2.3.4 5 typ relay', sdpMid: '0' } } });
    assert.equal((await next(rider, 'call:signal')).signal.type, 'candidate');
    say(driver, 'call:signal', { callId: started.callId, signal: { type: 'video' } });
    assert.equal((await next(driver, 'error')).code, 'BAD_SIGNAL', 'only call details are passed on');

    await sleep(1100);
    say(rider, 'call:end', { callId: started.callId });
    const endedForDriver = await next(driver, 'call:ended');
    assert.equal(endedForDriver.reason, 'completed');
    assert.ok(endedForDriver.durationSeconds >= 1);
    await next(rider, 'call:ended');

    const line = await next(driver, 'chat:message', (m) => m.kind === 'call');
    assert.match(line.content, /^Call · 0:0\d$/);
    assert.equal(line.senderRole, 'RIDER', 'from the caller');

    const record = await prisma.tripCall.findUnique({ where: { id: started.callId } });
    assert.equal(record.status, 'COMPLETED');
    assert.equal(record.calleeChannel, 'app');
    assert.ok(record.answeredAt && record.endedAt);

    say(rider, 'call:start', { rideId });
    const again = await next(rider, 'call:start:accepted');
    assert.notEqual(again.callId, started.callId, 'the line is free again');
    say(driver, 'call:decline', { callId: again.callId });
    assert.equal((await next(rider, 'call:ended')).reason, 'declined');
    assert.equal((await prisma.tripCall.findUnique({ where: { id: again.callId } })).status, 'DECLINED');
  });

  await t.test('an unanswered call stops ringing, and both hear "missed"', async () => {
    const { rideId, riderId, driverUserId } = await trip();
    const rider = await sock(A, riderId);
    const driver = await sock(B, driverUserId);
    captured.pushes.length = 0;
    say(driver, 'call:start', { rideId });
    const started = await next(driver, 'call:start:accepted');
    await next(rider, 'call:incoming');

    await sleep(450);
    // Both processes sweep at once: the call ends once.
    await Promise.all([A.tripChat.sweepOnce(), B.tripChat.sweepOnce()]);
    assert.equal((await next(rider, 'call:ended')).reason, 'missed');
    assert.equal((await next(driver, 'call:ended')).reason, 'missed');
    const line = await next(rider, 'chat:message', (m) => m.kind === 'call');
    assert.equal(line.content, 'Missed call');
    await sleep(200);
    assert.equal(rider.inbox.filter((m) => m.type === 'call:ended').length, 0, 'ended once, not twice');
    assert.equal(await prisma.chatMessage.count({ where: { rideId, kind: 'call' } }), 1);
    await until(() => captured.pushes.some((p) => p.data?.type === 'call:missed'));
    const missed = captured.pushes.find((p) => p.data?.type === 'call:missed');
    assert.equal(missed.userId, riderId);
    assert.equal(missed.title, 'Missed call from Tunde');
    assert.equal((await prisma.tripCall.findUnique({ where: { id: started.callId } })).status, 'MISSED');
  });

  await t.test('answering at the moment it stops ringing: one of the two wins, never both', async () => {
    const { rideId, riderId, driverUserId } = await trip();
    const rider = await sock(A, riderId);
    await sock(B, driverUserId);
    const started = await A.tripChat.calls.start({ rideId, userId: riderId });
    await sleep(420);
    const [answer] = await Promise.allSettled([
      B.tripChat.calls.accept({ callId: started.callId, userId: driverUserId }),
      A.tripChat.sweepOnce(),
    ]);
    const record = await prisma.tripCall.findUnique({ where: { id: started.callId } });
    if (answer.status === 'fulfilled') {
      assert.equal(record.status, 'ACTIVE', 'answered: the sweep left it alone');
      await A.tripChat.calls.end({ callId: started.callId, userId: riderId });
    } else {
      assert.equal(answer.reason.code, 'CALL_GONE');
      assert.equal(record.status, 'MISSED');
    }
    rider.inbox.length = 0;
  });

  await t.test('a WhatsApp rider: driver messages and calls go to WhatsApp when the page is closed, and to the page when it is open', async () => {
    const { rideId, riderId, driverUserId } = await trip({ channel: 'WHATSAPP' });
    const driver = await sock(A, driverUserId);
    captured.whatsapp.length = 0;
    captured.pushes.length = 0;

    say(driver, 'chat:send', { rideId, content: 'I dey your gate' });
    await next(driver, 'chat:send:accepted');
    await until(() => captured.whatsapp.length === 1);
    assert.equal(captured.whatsapp[0].body, '*Tunde (your driver):*\nI dey your gate');
    assert.equal(captured.whatsapp[0].button.text, 'Reply');
    assert.match(captured.whatsapp[0].button.url, new RegExp(`ride=${rideId}`));
    assert.equal(captured.pushes.some((p) => p.userId === riderId), false, 'a WhatsApp rider has no app to push to');

    // The page opens, with its link as the login.
    const pageToken = local.createWalletPageToken(riderId, 'trip', JWT_SECRET, 600, rideId);
    const page = await open(B.url(pageToken));
    sockets.push(page);
    await until(() => A.registry.isUserConnected(riderId));
    say(driver, 'chat:send', { rideId, content: 'Blue Corolla' });
    assert.equal((await next(page, 'chat:message')).content, 'Blue Corolla');
    await sleep(200);
    assert.equal(captured.whatsapp.length, 1, 'the page is open: nothing more to WhatsApp');

    // The page's socket may chat and call on its own ride, and nothing else.
    say(page, 'chat:send', { rideId: randomUUID(), content: 'Coming out now' });
    const fromPage = await next(page, 'chat:send:accepted');
    assert.equal(fromPage.rideId, rideId, "the link's ride, whatever the message says");
    say(page, 'ride:request', {});
    assert.match((await next(page, 'error')).message, /Unknown event type/);

    // HTTP, for opening the page.
    const state = await fetch(`http://127.0.0.1:${B.port}/trip-chat/state`, { headers: { authorization: `Bearer ${pageToken}` } }).then((r) => r.json());
    assert.equal(state.me.role, 'RIDER');
    assert.equal(state.other.name, 'Tunde');
    assert.equal(state.other.vehicle, 'Toyota Corolla');
    assert.equal(state.other.plate, 'KJA-123AB');
    assert.equal(state.messages.length, 3);
    assert.equal(state.callsEnabled, true);
    const loginRefused = await fetch(`http://127.0.0.1:${B.port}/trip-chat/state`, { headers: { authorization: `Bearer ${local.createLocalAccessToken(riderId, JWT_SECRET)}` } });
    assert.equal(loginRefused.status, 401, 'the page takes its link, not an app login');

    // The page is closed; the driver calls. WhatsApp rings, with the Answer link.
    page.close();
    await until(async () => !(await A.registry.isUserConnected(riderId)));
    captured.whatsapp.length = 0;
    say(driver, 'call:start', { rideId });
    const started = await next(driver, 'call:start:accepted');
    assert.equal(started.calleeChannel, 'whatsapp');
    await until(() => captured.whatsapp.length === 1);
    assert.match(captured.whatsapp[0].body, /Tunde, your driver, is calling you/);
    assert.equal(captured.whatsapp[0].button.text, 'Answer call');
    assert.match(captured.whatsapp[0].button.url, new RegExp(`call=${started.callId}`));

    await sleep(650);
    await B.tripChat.sweepOnce();
    await next(driver, 'call:ended');
    await until(() => captured.whatsapp.length === 2);
    assert.match(captured.whatsapp[1].body, /You missed a call from \*Tunde\*/);
    assert.equal(captured.whatsapp[1].button.text, 'Call back');
  });

  await t.test('a WhatsApp rider with a ride card: 💬 and 📞 change on the card, and no new messages are sent', async () => {
    const { rideId, riderId, driverUserId } = await trip({ channel: 'WHATSAPP' });
    cards.set(rideId, []);
    const driver = await sock(A, driverUserId);
    captured.whatsapp.length = 0;

    say(driver, 'chat:send', { rideId, content: 'I dey your gate' });
    await next(driver, 'chat:send:accepted');
    say(driver, 'chat:send', { rideId, content: 'Blue Corolla' });
    await next(driver, 'chat:send:accepted');
    await until(() => cards.get(rideId).length >= 2);
    assert.deepEqual(cards.get(rideId).slice(0, 2), ['message', 'message'], '💬 (the store skips the repeat at Meta)');

    // The rider opens the Trip chat page: seen, back to 🟢.
    const pageToken = local.createWalletPageToken(riderId, 'trip', JWT_SECRET, 600, rideId);
    await fetch(`http://127.0.0.1:${A.port}/trip-chat/state`, { headers: { authorization: `Bearer ${pageToken}` } });
    await until(() => cards.get(rideId).at(-1) === 'live');

    // The driver calls: 📞, and it stays after the call is missed.
    say(driver, 'call:start', { rideId });
    await next(driver, 'call:start:accepted');
    await until(() => cards.get(rideId).at(-1) === 'call');
    await sleep(650);
    await A.tripChat.sweepOnce();
    await next(driver, 'call:ended');
    await sleep(200);
    assert.equal(cards.get(rideId).at(-1), 'call', 'the missed call keeps 📞');
    assert.equal(captured.whatsapp.length, 0, 'not one WhatsApp message');
  });

  await t.test('calls switched off: refused, and chat still works', async () => {
    const off = await gateway({ enabled: false });
    const { rideId, riderId } = await trip();
    const rider = await sock(off, riderId);
    say(rider, 'call:start', { rideId });
    assert.equal((await next(rider, 'error')).code, 'CALLS_OFF');
    say(rider, 'chat:send', { rideId, content: 'hello' });
    await next(rider, 'chat:send:accepted');
  });

  await t.test('messages are limited to 20 a minute per person per trip', async () => {
    const { rideId, riderId } = await trip();
    for (let i = 0; i < 20; i += 1) await A.tripChat.sendMessage({ rideId, userId: riderId, content: `m${i}` });
    await assert.rejects(A.tripChat.sendMessage({ rideId, userId: riderId, content: 'one more' }), { code: 'RATE_LIMITED' });
  });
});

test.after(async () => {
  for (const s of sockets) { try { s.terminate(); } catch { /* closed */ } }
  for (const g of gateways) {
    g.tripChat.stop();
    await g.registry.shutdown().catch(() => {});
    await new Promise((resolve) => g.server.close(resolve));
  }
  await prisma.tripCall.deleteMany({ where: { rideId: { in: made.rides } } });
  await prisma.chatMessage.deleteMany({ where: { rideId: { in: made.rides } } });
  await prisma.ride.deleteMany({ where: { id: { in: made.rides } } });
  await prisma.driver.deleteMany({ where: { userId: { in: made.users } } });
  await prisma.user.deleteMany({ where: { id: { in: made.users } } });
  await prisma.$disconnect();
  for (const c of clients) await c.disconnect().catch(() => {});
});
