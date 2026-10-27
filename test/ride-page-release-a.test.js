// Rides for later booked on WhatsApp, at the moment they start, and a booked
// trip on the ride page. Through the real entry points: handleRidePageRoute
// for the page, handleRideEvent for the gateway's Kafka consumer, and
// ride-service's scheduler (dispatchSingleRide) and RIDE_REQUESTED consumer.
// Against the local Postgres; Redis is an in-memory stand-in, Kafka and Meta
// are recorded, not called.
//
//   - the WhatsApp 24 h window: Later offers times inside it (scheduleUntil),
//     the server refuses later ones, and a start outside it goes out as the
//     approved template (or, with none, does not start)
//   - a ride for later due while the rider is busy waits, with one short message,
//     and never ends their search or falls back to the app
//   - auto-accept is off for every ride for later
//   - at most 5 waiting, none within 30 minutes of another
//   - cancel a booked trip, change its route, the Emergency button, Support
//
//   node scripts/run-with-env.cjs node --test --test-force-exit test/ride-page-release-a.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');

const local = require('../apps/api-gateway/dist/auth/local.js');
const bidState = require('../apps/api-gateway/dist/whatsapp-flows/bid-state.js');
const catchup = require('../apps/api-gateway/dist/whatsapp-flows/page-catchup.js');
const autoAccept = require('../apps/api-gateway/dist/rides/auto-accept.js');
const { handleRidePageRoute } = require('../apps/api-gateway/dist/http/ride-page.route.js');
const { handleRideEvent, deliverPageCatchup, scheduledHeldText } = require('../apps/api-gateway/dist/kafka/consumer.js');
const { sayRidePageEventInChat } = require('../apps/api-gateway/dist/whatsapp/ride-card.js');
const { SCHEDULED_START_HELD_REASON } = require('../apps/api-gateway/dist/rides/scheduled-whatsapp.js');
const { dispatchSingleRide } = require('../apps/ride-service/dist/handlers/scheduled-rides.handler.js');
const { createRideRequestedConsumer } = require('../apps/ride-service/dist/consumers/ride-requested.consumer.js');

const prisma = new PrismaClient();
const JWT_SECRET = 'test-secret-that-is-at-least-32-characters-long';
const realFetch = global.fetch;
const realConsole = { log: console.log, info: console.info, warn: console.warn, error: console.error };
const realEnv = { template: process.env.WHATSAPP_SCHEDULED_TEMPLATE, support: process.env.SUPPORT_CONTACT };
const made = { users: [], rides: [], scheduled: [], drivers: [] };

const YABA = { lat: 6.5095, lng: 3.3711, address: '12 Herbert Macaulay Way, Yaba, Lagos' };
const VI = { lat: 6.4281, lng: 3.4219, address: 'Adeola Odeku Street, Victoria Island, Lagos' };
const SURULERE = { lat: 6.4995, lng: 3.3540, address: 'Adeniran Ogunsanya Street, Surulere, Lagos' };
const IKEJA = { lat: 6.6018, lng: 3.3515, address: 'Ikeja City Mall, Obafemi Awolowo Way, Ikeja' };
const place = { pickupLat: YABA.lat, pickupLng: YABA.lng, pickupAddress: YABA.address, destLat: VI.lat, destLng: VI.lng, destAddress: VI.address };

function memoryRedis() {
  const store = new Map();
  const ttls = new Map();
  return {
    store, ttls,
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async set(k, v, ttl) { store.set(k, v); if (ttl) ttls.set(k, ttl); },
    async del(k) { store.delete(k); },
    async setIfNotExists(k, v, ttl) { if (store.has(k)) return false; store.set(k, v); if (ttl) ttls.set(k, ttl); return true; },
    async send(cmd, key) {
      if (cmd === 'INCR') { const n = Number(store.get(`n:${key}`) ?? 0) + 1; store.set(`n:${key}`, String(n)); return n; }
      if (cmd === 'TTL') return store.has(key) ? (ttls.get(key) ?? -1) : -2;
      return null;
    },
  };
}

/** ride-service's Redis (ioredis): only what the scheduler uses. */
function ioRedis(gatewayRedis) {
  return {
    async get(k) { return gatewayRedis.get(k); },
    async set(k, v, ...args) { if (args.includes('NX') && gatewayRedis.store.has(k)) return null; gatewayRedis.store.set(k, v); return 'OK'; },
    async ttl(k) { return gatewayRedis.send('TTL', k); },
    async del(k) { return gatewayRedis.del(k); },
  };
}

function plannerFor() {
  return { planRoute: async () => ({ distanceKm: 11.4, durationSeconds: 1680, suggestedFareNgn: 5200, minOfferNgn: 4700, ratePerKmNgn: 420, priceReason: null, geometry: { coordinates: [], bounds: { northEast: VI, southWest: YABA } } }) };
}

function world() {
  const redis = memoryRedis();
  const events = []; const chat = [];
  const queue = { added: [], async add(name, data, opts) { this.added.push({ name, data, opts }); }, async remove() {} };
  const deps = {
    jwtSecret: JWT_SECRET,
    redisClient: redis,
    publisher: { publishRideEvent: async (event) => { events.push(event); }, publishNotificationEvent: async () => {} },
    paymentsClient: {},
    googleMapsApiKey: 'server-key',
    routePlanner: plannerFor(),
    notifyChat: async (event) => { chat.push(event); },
    scheduling: { dispatcherQueue: queue, leadTimeMs: 5 * 60_000 },
  };
  return { redis, events, chat, queue, deps };
}

async function makeRider(phone = `+23480${Math.floor(1e8 + Math.random() * 9e8)}`) {
  const id = randomUUID();
  await prisma.user.create({ data: { id, privyDid: `whatsapp:${phone}`, role: 'RIDER', name: 'Later Rider', phone, privacyConsent: 'AGREED' } });
  await prisma.wallet.create({ data: { userId: id, balanceNgn: 0 } });
  made.users.push(id);
  return id;
}

async function makeDriver() {
  const userId = randomUUID();
  await prisma.user.create({ data: { id: userId, privyDid: `local:${userId}`, role: 'DRIVER', name: 'Chinedu Okafor', phone: '+2348031234567' } });
  await prisma.wallet.create({ data: { userId, balanceNgn: 0 } });
  const driver = await prisma.driver.create({ data: { userId, status: 'ONLINE', kycStatus: 'APPROVED', lat: 6.5, lng: 3.37, lastSeenAt: new Date(), vehicleModel: 'Toyota Corolla', vehiclePlate: 'LND-174XA' } });
  made.users.push(userId); made.drivers.push(driver.id);
  return { userId, driverId: driver.id };
}

async function makeRide(riderId, data) {
  const ride = await prisma.ride.create({ data: { riderId, ...place, ...data } });
  made.rides.push(ride.id);
  return ride;
}

async function call(deps, userId, method, path, body, token) {
  const bearer = token ?? local.createWalletPageToken(userId, 'ride', JWT_SECRET, local.RIDE_PAGE_TOKEN_TTL_SECONDS);
  const raw = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = { method, headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }, async *[Symbol.asyncIterator]() { for (const c of raw) yield c; } };
  const res = { statusCode: 200, body: null, headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, writeHead(code) { this.statusCode = code; return this; }, end(text) { this.body = text ? JSON.parse(text) : null; } };
  const handled = await handleRidePageRoute(req, res, deps, new URL(`http://x${path}`));
  return { handled, status: res.statusCode, body: res.body, headers: res.headers };
}

const inMinutes = (n) => new Date(Date.now() + n * 60_000).toISOString();
const trip = { pickup: YABA, destination: VI };

function consumerDeps(redis, extra = {}) {
  const pushes = []; const said = []; const events = [];
  return {
    pushes, said, events,
    deps: {
      registry: { sendToUser: async () => {}, hasUser: () => false },
      redisClient: redis,
      publisher: { publishNotificationEvent: async (event) => { pushes.push(event); }, publishRideEvent: async (event) => { events.push(event); } },
      ridePageChat: async (event) => { said.push(event); },
      ...extra,
    },
  };
}

const started = (riderId, extra = {}) => ({
  eventType: 'RIDE_REQUESTED', rideId: randomUUID(), riderId, scheduled: true, channel: 'WHATSAPP',
  pickup: YABA, destination: VI, stops: [], plannedDistanceKm: 11.4, plannedDurationSeconds: 1680,
  fareEstimateNgn: 5200, riderOfferNgn: 5200, suggestedFareNgn: 5200, minOfferNgn: 4700, ratePerKmNgn: 420,
  paymentMethod: 'WALLET', timestamp: new Date().toISOString(), ...extra,
});

/** Meta, recorded: every message body sent. */
function recordMeta() {
  const sent = [];
  global.fetch = async (url, init) => { sent.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null }); return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.x' }] }), text: async () => '' }; };
  return sent;
}

test.beforeEach(() => { console.log = console.info = console.warn = console.error = () => {}; delete process.env.WHATSAPP_SCHEDULED_TEMPLATE; });
test.afterEach(() => {
  Object.assign(console, realConsole); global.fetch = realFetch;
  if (realEnv.template === undefined) delete process.env.WHATSAPP_SCHEDULED_TEMPLATE; else process.env.WHATSAPP_SCHEDULED_TEMPLATE = realEnv.template;
  if (realEnv.support === undefined) delete process.env.SUPPORT_CONTACT; else process.env.SUPPORT_CONTACT = realEnv.support;
});
test.after(async () => {
  await prisma.outboxEvent.deleteMany({ where: { key: { in: made.rides } } }).catch(() => {});
  await prisma.safetyAlert.deleteMany({ where: { userId: { in: made.users } } }).catch(() => {});
  await prisma.scheduledRide.deleteMany({ where: { riderId: { in: made.users } } }).catch(() => {});
  await prisma.rideStop.deleteMany({ where: { rideId: { in: made.rides } } }).catch(() => {});
  await prisma.ride.deleteMany({ where: { OR: [{ id: { in: made.rides } }, { riderId: { in: made.users } }] } }).catch(() => {});
  await prisma.driver.deleteMany({ where: { id: { in: made.drivers } } }).catch(() => {});
  await prisma.wallet.deleteMany({ where: { userId: { in: made.users } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: made.users } } }).catch(() => {});
  await prisma.$disconnect();
});

/* ── the 24 h window ──────────────────────────────────────────────────── */

test('Later offers times up to the end of the rider\'s WhatsApp window; with the start template set, the usual 7 days', async () => {
  const { deps, redis } = world();
  const rider = await makeRider();

  // No message from them on record: nothing can start (the page shows no time).
  const closed = (await call(deps, rider, 'GET', '/ride-page/state')).body;
  assert.equal(closed.phase, 'idle');
  assert.ok(Math.abs(Date.parse(closed.scheduleUntil) - Date.now()) < 5_000);

  // They wrote 2 hours ago: the window ends 22 hours from now.
  await bidState.markWhatsappInbound(redis, rider, Date.now() - 2 * 60 * 60_000);
  const open = (await call(deps, rider, 'GET', '/ride-page/state')).body;
  assert.ok(Math.abs(Date.parse(open.scheduleUntil) - (Date.now() + 22 * 60 * 60_000)) < 5_000);

  // Before this release kept the time: the phone lookup (renewed for 24 h on every message) says it.
  const older = await makeRider();
  await bidState.setPhoneLookup(redis, older, '+2348030000009');
  redis.ttls.set(`whatsapp:phone_by_user:${older}`, 3600);
  assert.ok(Math.abs(Date.parse((await call(deps, older, 'GET', '/ride-page/state')).body.scheduleUntil) - (Date.now() + 3600_000)) < 5_000);

  process.env.WHATSAPP_SCHEDULED_TEMPLATE = 'scheduled_ride_started';
  assert.equal((await call(deps, rider, 'GET', '/ride-page/state')).body.scheduleUntil, null);
});

test('a time after the window is refused (SCHEDULE_OUTSIDE_WINDOW); inside it, or with the template, it is booked', async () => {
  const { deps, redis } = world();
  const rider = await makeRider();
  const never = await call(deps, rider, 'POST', '/ride-page/schedule', { ...trip, scheduledFor: inMinutes(60) });
  assert.equal(never.status, 400);
  assert.equal(never.body.code, 'SCHEDULE_OUTSIDE_WINDOW');
  assert.equal(never.body.error, 'Send any message in WhatsApp, then pick a time.');

  await bidState.markWhatsappInbound(redis, rider, Date.now() - 20 * 60 * 60_000);   // 4 h left
  const late = await call(deps, rider, 'POST', '/ride-page/schedule', { ...trip, scheduledFor: inMinutes(5 * 60) });
  assert.equal(late.body.code, 'SCHEDULE_OUTSIDE_WINDOW');
  assert.match(late.body.error, /^Pick a time before \d{1,2}:\d{2} [AP]M\.$/);
  assert.equal(await prisma.scheduledRide.count({ where: { riderId: rider } }), 0);

  assert.equal((await call(deps, rider, 'POST', '/ride-page/schedule', { ...trip, scheduledFor: inMinutes(3 * 60) })).status, 201);
  process.env.WHATSAPP_SCHEDULED_TEMPLATE = 'scheduled_ride_started';
  assert.equal((await call(deps, rider, 'POST', '/ride-page/schedule', { ...trip, scheduledFor: inMinutes(3 * 24 * 60) })).status, 201);
});

test('at most 5 rides for later waiting, and none within 30 minutes of another', async () => {
  const { deps, redis } = world();
  const rider = await makeRider();
  await bidState.markWhatsappInbound(redis, rider);

  assert.equal((await call(deps, rider, 'POST', '/ride-page/schedule', { ...trip, scheduledFor: inMinutes(60) })).status, 201);
  const close = await call(deps, rider, 'POST', '/ride-page/schedule', { ...trip, scheduledFor: inMinutes(85) });
  assert.equal(close.status, 409);
  assert.equal(close.body.code, 'SCHEDULE_TOO_CLOSE');
  assert.equal((await call(deps, rider, 'POST', '/ride-page/schedule', { ...trip, scheduledFor: inMinutes(35) })).body.code, 'SCHEDULE_TOO_CLOSE', 'before it too');
  assert.equal((await call(deps, rider, 'POST', '/ride-page/schedule', { ...trip, scheduledFor: inMinutes(91) })).status, 201, '31 minutes after is fine');

  for (const at of [180, 240, 300]) assert.equal((await call(deps, rider, 'POST', '/ride-page/schedule', { ...trip, scheduledFor: inMinutes(at) })).status, 201);
  const sixth = await call(deps, rider, 'POST', '/ride-page/schedule', { ...trip, scheduledFor: inMinutes(400) });
  assert.equal(sixth.status, 409);
  assert.equal(sixth.body.code, 'SCHEDULE_LIMIT');
  assert.equal(sixth.body.scheduled.length, 5);
  assert.equal(await prisma.scheduledRide.count({ where: { riderId: rider } }), 5);

  // One that started (no longer waiting) frees a place.
  const first = await prisma.scheduledRide.findFirst({ where: { riderId: rider }, orderBy: { scheduledFor: 'asc' } });
  await prisma.scheduledRide.update({ where: { id: first.id }, data: { status: 'DISPATCHED' } });
  assert.equal((await call(deps, rider, 'POST', '/ride-page/schedule', { ...trip, scheduledFor: inMinutes(400) })).status, 201);
});

test('an expired link says the whole sentence (a page from before this release shows only the message)', async () => {
  const { deps } = world();
  const rider = await makeRider();
  const gone = await call(deps, rider, 'GET', '/ride-page/state', undefined, local.createWalletPageToken(rider, 'ride', JWT_SECRET, -1));
  assert.equal(gone.body.code, 'LINK_EXPIRED');
  assert.equal(gone.body.error, 'This link has expired. Go back to WhatsApp and send any message for a new one.');
});

test('the start template\'s button opens the page with its link (the token in the fragment)', async () => {
  const { deps } = world();
  const rider = await makeRider();
  const token = local.createWalletPageToken(rider, 'ride', JWT_SECRET, local.RIDE_PAGE_TOKEN_TTL_SECONDS);
  const opened = await call(deps, rider, 'GET', `/ride-page/open/${token}`);
  assert.equal(opened.status, 302);
  assert.equal(opened.headers.location, `/widget/ride/ride.html#t=${token}`);
  assert.equal(opened.headers['cache-control'], 'no-store');
  const junk = await call(deps, rider, 'GET', '/ride-page/open/<script>');
  assert.equal(junk.status, 404);
  assert.equal(junk.headers.location, '/widget/ride/ride.html');
  assert.equal((await call(deps, rider, 'POST', `/ride-page/open/${token}`)).status, 405);
});

test('a start outside the window goes out as the template, with the page link on its button; inside it, "Your bid is in" as before', async () => {
  const redis = memoryRedis();
  const rider = await makeRider('+2348035550001');
  const metaDeps = { redisClient: redis, jwtSecret: JWT_SECRET, metaAccessToken: 'meta-token', metaPhoneNumberId: '1234', appBaseUrl: 'https://app.wheelersng.com' };
  const event = { kind: 'search_started', userId: rider, phone: '+2348035550001', rideId: randomUUID(), offerNgn: 5200, pickupAddress: YABA.address, destAddress: VI.address, scheduled: true };
  process.env.WHATSAPP_SCHEDULED_TEMPLATE = 'scheduled_ride_started';

  let sent = recordMeta();
  await sayRidePageEventInChat(metaDeps, event);
  assert.equal(sent.length, 1);
  const message = sent[0].body;
  assert.equal(message.type, 'template');
  assert.equal(message.to, '2348035550001');
  assert.equal(message.template.name, 'scheduled_ride_started');
  assert.equal(message.template.language.code, 'en');
  assert.deepEqual(message.template.components[0].parameters.map((p) => p.text), ['12 Herbert Macaulay Way', 'Adeola Odeku Street']);
  const token = message.template.components[1].parameters[0].text;
  assert.equal(message.template.components[1].sub_type, 'url');
  assert.equal(local.verifyWalletPageToken(token, JWT_SECRET).userId, rider, 'the button opens this rider\'s ride page');

  // Inside the window: the plain message, never the template.
  await bidState.markWhatsappInbound(redis, rider);
  sent = recordMeta();
  await sayRidePageEventInChat(metaDeps, event);
  assert.ok(sent.length >= 1);
  assert.ok(sent.every((s) => s.body?.type !== 'template'));
});

/* ── when it starts: busy, auto-accept, a failure ─────────────────────── */

test('a rider searching when it starts keeps their search: it waits, nothing is touched, never the app\'s', async () => {
  const redis = memoryRedis();
  const { deps, pushes, said, events } = consumerDeps(redis);
  const rider = await makeRider();
  const search = await makeRide(rider, { status: 'MATCHING' });
  await bidState.setActiveRide(redis, rider, search.id);

  const event = started(rider);
  await handleRideEvent(event, deps, new Map());
  assert.equal(await bidState.getActiveRide(redis, rider), search.id, 'their search keeps the chat');
  assert.equal(await bidState.getRideMeta(redis, event.rideId), null);
  assert.equal(said.length, 0);
  assert.equal(pushes.length, 0);
  assert.equal(events.length, 0);
  assert.equal(await redis.get(`ride:${event.rideId}:app-only`), null);
  assert.equal(await redis.get(`ride:${event.rideId}:wa-scheduled`), null, 'not marked done: it starts later');
});

test('a search of their own started a moment ago (not in the database yet) is theirs too', async () => {
  const redis = memoryRedis();
  const { deps, said } = consumerDeps(redis);
  const rider = await makeRider();
  const own = randomUUID();
  await bidState.storeWhatsappRide(redis, own, { riderId: rider, phone: '+2348030000001', pickupAddress: YABA.address, destinationAddress: VI.address, offerNgn: 5000, createdAt: new Date().toISOString() });
  await bidState.setActiveRide(redis, rider, own);
  const event = started(rider);
  await handleRideEvent(event, deps, new Map());
  assert.equal(await bidState.getActiveRide(redis, rider), own);
  assert.equal(said.length, 0);

  // An old pointer left behind (the database has nothing live): the ride for later goes ahead.
  await bidState.storeWhatsappRide(redis, own, { riderId: rider, phone: '+2348030000001', pickupAddress: YABA.address, destinationAddress: VI.address, offerNgn: 5000, createdAt: new Date(Date.now() - 10 * 60_000).toISOString() });
  const later = started(rider);
  await handleRideEvent(later, deps, new Map());
  assert.equal(await bidState.getActiveRide(redis, rider), later.rideId);
  assert.equal(said.length, 1);
});

test('auto-accept is off for every ride for later: page-booked and app-booked', async () => {
  const redis = memoryRedis();
  const { deps } = consumerDeps(redis);
  const rider = await makeRider();
  const page = started(rider);
  await handleRideEvent(page, deps, new Map());
  assert.equal(await autoAccept.isAutoAcceptOn(redis, page.rideId), false);

  const pageState = world();
  pageState.deps.redisClient = redis;
  const state = (await call(pageState.deps, rider, 'GET', '/ride-page/state')).body;
  assert.equal(state.phase, 'offers');
  assert.equal(state.autoAccept, false, 'the page says no driver is booked for them');

  const appRider = await makeRider();
  const app = started(appRider, { channel: 'APP' });
  await handleRideEvent(app, deps, new Map());
  assert.equal(await autoAccept.isAutoAcceptOn(redis, app.rideId), false);
  // Off is also what no record means (D4: only the rider's yes turns it on).
  assert.equal(await autoAccept.isAutoAcceptOn(redis, randomUUID()), false);
});

test('an offer reaching auto-accept before the start was handled: no yes from the rider, nothing is booked', async () => {
  const redis = memoryRedis();
  const rider = await makeRider();
  const rideId = randomUUID();
  const scheduled = await prisma.scheduledRide.create({ data: { riderId: rider, scheduledFor: new Date(Date.now() + 5 * 60_000), status: 'DISPATCHED', requestedRideId: rideId, channel: 'WHATSAPP', ...place } });
  made.scheduled.push(scheduled.id);
  const result = await autoAccept.tryAutoAccept({ redisClient: redis, publisher: { publishRideEvent: async () => { throw new Error('nothing is published'); } } }, rideId);
  assert.equal(result.booked, false);
  assert.equal(await autoAccept.isAutoAcceptOn(redis, rideId), false, 'and it is kept off');
});

test('a start that cannot be set up is undone, not left half WhatsApp and half app: its search ends quietly and it waits again', async () => {
  const base = memoryRedis();
  const redis = { ...base, async set(k, v, ttl) { if (k.endsWith(':meta')) throw new Error('redis refused'); return base.set(k, v, ttl); } };
  const { deps, said, events, pushes } = consumerDeps(redis);
  const rider = await makeRider();
  const event = started(rider);
  const scheduled = await prisma.scheduledRide.create({ data: { riderId: rider, scheduledFor: new Date(Date.now() + 5 * 60_000), status: 'DISPATCHED', requestedRideId: event.rideId, channel: 'WHATSAPP', ...place } });
  made.scheduled.push(scheduled.id);

  await handleRideEvent(event, deps, new Map());
  assert.equal(await bidState.getActiveRide(redis, rider), null);
  assert.equal(await redis.get(`ride:${event.rideId}:wa-scheduled`), null, 'free to start again');
  assert.equal(said.length, 0);
  assert.equal(pushes.length, 0, 'not the app\'s');
  assert.equal(await redis.get(`ride:${event.rideId}:app-only`), null);
  const row = await prisma.scheduledRide.findUnique({ where: { id: scheduled.id } });
  assert.equal(row.status, 'SCHEDULED');
  assert.equal(row.requestedRideId, null);
  assert.equal(events.length, 1);
  assert.equal(events[0].eventType, 'RIDE_CANCELLED');
  assert.equal(events[0].rideId, event.rideId);
  assert.equal(events[0].cancelledBy, 'system');
  assert.equal(events[0].reason, SCHEDULED_START_HELD_REASON);

  // That ending says nothing in the chat (as a replaced search).
  const quiet = consumerDeps(base, { whatsappNotifier: { metaAccessToken: 't', metaPhoneNumberId: 'p' } });
  await bidState.setPhoneLookup(base, rider, '+2348030000001');
  const sent = recordMeta();
  await handleRideEvent(events[0], quiet.deps, new Map());
  assert.equal(sent.length, 0);
});

/* ── the one message while it waits ───────────────────────────────────── */

test('while it waits the rider hears once: in the chat, or when they leave the page, and only if it still waits', async () => {
  const redis = memoryRedis();
  const notifier = { metaAccessToken: 't', metaPhoneNumberId: 'p' };
  const { deps } = consumerDeps(redis, { whatsappNotifier: notifier });
  const rider = await makeRider('+2348035550002');
  await bidState.markWhatsappInbound(redis, rider);
  const scheduledFor = '2026-10-28T14:30:00.000Z';   // 3:30 PM in Lagos
  const held = { eventType: 'SCHEDULED_RIDE_HELD', rideId: randomUUID(), riderId: rider, scheduledFor, pickupAddress: YABA.address, timestamp: new Date().toISOString() };
  assert.equal(scheduledHeldText(scheduledFor), 'Your 3:30 PM ride will start when this one ends.');

  let sent = recordMeta();
  await handleRideEvent(held, deps, new Map());
  assert.equal(sent.length, 1);
  assert.match(JSON.stringify(sent[0].body), /Your 3:30 PM ride will start when this one ends\./);
  assert.equal(sent[0].body.to, '2348035550002');
  await handleRideEvent(held, deps, new Map());
  assert.equal(sent.length, 1, 'once');

  // On the page: kept for when they leave; said then only if the ride for later still waits.
  const onPage = await makeRider('+2348035550003');
  await bidState.markWhatsappInbound(redis, onPage);
  await bidState.markRidePageSeen(redis, onPage);
  const waiting = await prisma.scheduledRide.create({ data: { riderId: onPage, scheduledFor: new Date(scheduledFor), channel: 'WHATSAPP', ...place } });
  made.scheduled.push(waiting.id);
  sent = recordMeta();
  await handleRideEvent({ ...held, rideId: waiting.id, riderId: onPage }, deps, new Map());
  assert.equal(sent.length, 0);
  const kept = await catchup.pendingCatchup(redis, onPage);
  assert.deepEqual(kept.map((item) => [item.kind, item.rideId]), [['scheduled_held', waiting.id]]);
  assert.equal(await deliverPageCatchup(deps, onPage, kept[0]), true);
  assert.equal(sent.length, 1);
  await prisma.scheduledRide.update({ where: { id: waiting.id }, data: { status: 'DISPATCHED' } });
  assert.equal(await deliverPageCatchup(deps, onPage, kept[0]), false, 'started meanwhile: nothing to say');

  // Outside their window a plain message cannot reach them: not sent.
  const away = await makeRider();
  sent = recordMeta();
  await handleRideEvent({ ...held, rideId: randomUUID(), riderId: away }, deps, new Map());
  assert.equal(sent.length, 0);
});

/* ── ride-service: the scheduler ──────────────────────────────────────── */

function recordProducer() {
  const out = [];
  const record = (name) => async (event) => { out.push({ name, event }); };
  return {
    out,
    producer: {
      scheduledRideHeld: record('held'), rideCancelled: record('cancelled'), rideBidTimeout: record('timeout'),
      broadcastRideOffer: async (params) => { out.push({ name: 'broadcast', event: params.rideRequested }); },
      rideRequested: record('requested'), rideDriverAssigned: record('assigned'), rideDriverRejected: record('rejected'),
      rideCompleted: record('completed'), rideRouteUpdated: record('route'), rideAssignmentFailed: record('failed'),
      groupRideDriverAssigned: record('group'), rideOfferAccepted: record('accepted'), sendUpdatedOfferToDriver: async () => {},
    },
  };
}

async function dueRide(riderId, channel = 'WHATSAPP') {
  const row = await prisma.scheduledRide.create({ data: { riderId, scheduledFor: new Date(Date.now() + 4 * 60_000), ...(channel ? { channel } : {}), ...place, fareEstimateNgn: 5200, plannedDistanceKm: 11.4, plannedDurationSeconds: 1680 } });
  made.scheduled.push(row.id);
  return row;
}

async function outboxFor(scheduledId) {
  const row = await prisma.scheduledRide.findUnique({ where: { id: scheduledId } });
  if (row.requestedRideId) made.rides.push(row.requestedRideId);
  return { row, outbox: row.requestedRideId ? await prisma.outboxEvent.findMany({ where: { key: row.requestedRideId } }) : [] };
}

test('the scheduler holds a WhatsApp ride for later while its rider is busy, says so once, and starts it when they are free', async () => {
  const gateway = memoryRedis();
  const { out, producer } = recordProducer();
  const ctx = { rideEventsProducer: producer, redis: ioRedis(gateway) };
  const rider = await makeRider();
  await bidState.markWhatsappInbound(gateway, rider);
  const driver = await makeDriver();
  const onTrip = await makeRide(rider, { status: 'IN_PROGRESS', driverId: driver.driverId });
  const scheduled = await dueRide(rider);

  await dispatchSingleRide(scheduled.id, ctx);
  let { row, outbox } = await outboxFor(scheduled.id);
  assert.equal(row.status, 'SCHEDULED', 'back to waiting');
  assert.equal(outbox.length, 0, 'no search went out');
  assert.deepEqual(out.map((o) => o.name), ['held']);
  assert.equal(out[0].event.rideId, scheduled.id);
  assert.equal(out[0].event.riderId, rider);
  assert.equal(out[0].event.scheduledFor, scheduled.scheduledFor.toISOString());

  await dispatchSingleRide(scheduled.id, ctx);
  assert.deepEqual(out.map((o) => o.name), ['held'], 'said once, however many scans');

  // A search (not a trip) holds it too.
  await prisma.ride.update({ where: { id: onTrip.id }, data: { status: 'MATCHING', driverId: null } });
  await dispatchSingleRide(scheduled.id, ctx);
  assert.equal((await outboxFor(scheduled.id)).row.status, 'SCHEDULED');

  // Free: it starts, as before.
  await prisma.ride.update({ where: { id: onTrip.id }, data: { status: 'COMPLETED' } });
  await dispatchSingleRide(scheduled.id, ctx);
  ({ row, outbox } = await outboxFor(scheduled.id));
  assert.equal(row.status, 'DISPATCHED');
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].payload.channel, 'WHATSAPP');
  assert.equal(outbox[0].payload.scheduled, true);
});

test('an app ride for later is dispatched as before, busy or not', async () => {
  const gateway = memoryRedis();
  const { out, producer } = recordProducer();
  const rider = await makeRider();
  await makeRide(rider, { status: 'MATCHING' });
  const scheduled = await dueRide(rider, null);
  await dispatchSingleRide(scheduled.id, { rideEventsProducer: producer, redis: ioRedis(gateway) });
  const { row, outbox } = await outboxFor(scheduled.id);
  assert.equal(row.status, 'DISPATCHED');
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].payload.channel, 'APP');
  assert.equal(out.length, 0);
});

test('a WhatsApp ride for later whose start could not reach the rider (window closed, no template) does not start', async () => {
  const gateway = memoryRedis();
  const { producer } = recordProducer();
  const ctx = { rideEventsProducer: producer, redis: ioRedis(gateway) };
  const rider = await makeRider();
  await bidState.markWhatsappInbound(gateway, rider, Date.now() - 25 * 60 * 60_000);
  const scheduled = await dueRide(rider);
  await dispatchSingleRide(scheduled.id, ctx);
  const { row, outbox } = await outboxFor(scheduled.id);
  assert.equal(row.status, 'CANCELLED');
  assert.equal(row.cancellationReason, 'whatsapp_window_closed');
  assert.equal(outbox.length, 0, 'no driver is called for nobody');

  // With the template set, it starts (the template reaches them).
  process.env.WHATSAPP_SCHEDULED_TEMPLATE = 'scheduled_ride_started';
  const other = await dueRide(rider);
  await dispatchSingleRide(other.id, ctx);
  assert.equal((await outboxFor(other.id)).row.status, 'DISPATCHED');
});

/* ── ride-service: RIDE_REQUESTED ─────────────────────────────────────── */

function rideService() {
  const { out, producer } = recordProducer();
  const state = { onlineDrivers: new Map(), assignedDriversByRideId: new Map(), rideParticipantsByRideId: new Map(), gpsByRideId: new Map(), routeByRideId: new Map(), pendingMatchesByRideId: new Map() };
  const consumer = createRideRequestedConsumer({ state, rideEnv: { MATCH_RADIUS_KM: '5', MAX_MATCH_ATTEMPTS: '5' }, rideEventsProducer: producer });
  const handle = (event) => consumer.handle(event, { topic: 'ride.events', partition: 0, offset: '0', timestamp: '0', headers: {} });
  return { out, state, handle, stop() { for (const p of state.pendingMatchesByRideId.values()) if (p.timeout) clearTimeout(p.timeout); } };
}

test('ride-service never ends a live search for a WhatsApp ride for later: busy at that second, it goes back to wait', async () => {
  const service = rideService();
  const rider = await makeRider();
  const live = await makeRide(rider, { status: 'MATCHING' });
  const event = started(rider);
  const scheduled = await prisma.scheduledRide.create({ data: { riderId: rider, scheduledFor: new Date(Date.now() + 5 * 60_000), status: 'DISPATCHED', requestedRideId: event.rideId, channel: 'WHATSAPP', ...place } });
  made.scheduled.push(scheduled.id); made.rides.push(event.rideId);

  await service.handle(event);
  assert.equal((await prisma.ride.findUnique({ where: { id: live.id } })).status, 'MATCHING', 'their search goes on');
  assert.equal(await prisma.ride.findUnique({ where: { id: event.rideId } }), null, 'no search for the ride for later');
  assert.equal(service.out.filter((o) => o.name === 'cancelled').length, 0);
  const row = await prisma.scheduledRide.findUnique({ where: { id: scheduled.id } });
  assert.equal(row.status, 'SCHEDULED');
  assert.equal(row.requestedRideId, null);

  // Delivered again: put back already, so nothing.
  await service.handle(event);
  assert.equal(await prisma.ride.findUnique({ where: { id: event.rideId } }), null);
  service.stop();
});

test('ride-service: a WhatsApp ride for later with the rider free searches; a search the rider starts still replaces their older one', async () => {
  const service = rideService();
  const rider = await makeRider();
  const event = started(rider);
  const scheduled = await prisma.scheduledRide.create({ data: { riderId: rider, scheduledFor: new Date(Date.now() + 5 * 60_000), status: 'DISPATCHED', requestedRideId: event.rideId, channel: 'WHATSAPP', ...place } });
  made.scheduled.push(scheduled.id); made.rides.push(event.rideId);
  await service.handle(event);
  assert.equal((await prisma.ride.findUnique({ where: { id: event.rideId } })).status, 'MATCHING');

  // The rider's own new search in the same minute: replaces it, and the ride for later waits to start again after.
  const own = { ...started(rider), scheduled: undefined, channel: 'WHATSAPP' };
  made.rides.push(own.rideId);
  await service.handle(own);
  assert.equal((await prisma.ride.findUnique({ where: { id: event.rideId } })).status, 'CANCELLED');
  assert.equal(service.out.find((o) => o.name === 'cancelled').event.rideId, event.rideId);
  assert.equal((await prisma.scheduledRide.findUnique({ where: { id: scheduled.id } })).status, 'SCHEDULED');

  // An ordinary older search is replaced as before (and nothing else is put back).
  const third = { ...started(rider), scheduled: undefined, channel: 'APP' };
  made.rides.push(third.rideId);
  await service.handle(third);
  assert.equal((await prisma.ride.findUnique({ where: { id: own.rideId } })).status, 'CANCELLED');
  service.stop();
});

/* ── a booked trip on the page ────────────────────────────────────────── */

async function bookedTrip(status = 'DRIVER_EN_ROUTE') {
  const rider = await makeRider();
  const driver = await makeDriver();
  const ride = await makeRide(rider, { driverId: driver.driverId, status, agreedFareNgn: 5200, distanceKm: 11.4, durationSeconds: 1680 });
  await prisma.rideStop.createMany({ data: [
    { rideId: ride.id, stopOrder: 0, type: 'INTERMEDIATE', status: 'PENDING', lat: SURULERE.lat, lng: SURULERE.lng, address: SURULERE.address },
    { rideId: ride.id, stopOrder: 1, type: 'FINAL', status: 'PENDING', lat: VI.lat, lng: VI.lng, address: VI.address },
  ] });
  return { rider, driver, ride };
}

test('a booked trip on the page: the app\'s cancel reasons, Support, no SOS yet, and its places with the stops', async () => {
  const { deps } = world();
  process.env.SUPPORT_CONTACT = '+2348099990000';
  const { rider, ride } = await bookedTrip();
  const state = (await call(deps, rider, 'GET', '/ride-page/state')).body;
  assert.equal(state.phase, 'confirmed');
  assert.equal(state.rideId, ride.id);
  assert.deepEqual(state.rideCancelReasons, ['Long waiting time', 'Wrong pickup or destination', 'Driver is not moving', 'Driver asked me to cancel', 'My plans changed', 'Other reason']);
  assert.equal(state.supportContact, '+2348099990000');
  assert.equal(state.sosActive, false);
  assert.deepEqual(state.places, { pickup: YABA, destination: VI, stops: [SURULERE] });
  assert.deepEqual(state.route.stopAddresses, [SURULERE.address]);

  delete process.env.SUPPORT_CONTACT;
  assert.equal((await call(deps, rider, 'GET', '/ride-page/state')).body.supportContact, null);
});

test('cancel a booked trip: the app\'s ride:cancel with the reason, the page goes idle, the chat says nothing', async () => {
  const { deps, events, chat, redis } = world();
  const { rider, driver, ride } = await bookedTrip('ARRIVED');
  await bidState.setActiveRide(redis, rider, ride.id);

  assert.equal((await call(deps, rider, 'POST', '/ride-page/cancel-ride', { reason: 'The prices are too high' })).body.code, 'REASON_INVALID', 'a search reason is not one of these');
  assert.equal(events.length, 0);

  const done = await call(deps, rider, 'POST', '/ride-page/cancel-ride', { reason: 'Other reason', detail: '  Driver went   the wrong way ' });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.phase, 'idle');
  assert.equal(events.length, 1);
  assert.equal(events[0].eventType, 'RIDE_CANCELLED');
  assert.equal(events[0].rideId, ride.id);
  assert.equal(events[0].riderId, rider);
  assert.equal(events[0].driverId, driver.driverId);
  assert.equal(events[0].cancelledBy, 'rider');
  assert.equal(events[0].reason, 'Driver went the wrong way', 'their own words, as the app sends them');
  assert.equal(chat.length, 0);
  assert.equal(await bidState.wasCancelledOnPage(redis, ride.id), true, 'the consumer keeps the chat quiet');
  assert.equal(await bidState.getActiveRide(redis, rider), null);

  // Again (a double tap): nothing more.
  assert.equal((await call(deps, rider, 'POST', '/ride-page/cancel-ride', { reason: 'My plans changed' })).body.code, 'NO_TRIP');
  assert.equal(events.length, 1);
});

test('cancel during the trip is allowed (as in the app); with no driver yet it is the search\'s cancel instead', async () => {
  const { deps, events } = world();
  const { rider } = await bookedTrip('IN_PROGRESS');
  const done = await call(deps, rider, 'POST', '/ride-page/cancel-ride', { reason: 'Driver is not moving' });
  assert.equal(done.status, 200);
  assert.equal(events[0].reason, 'Driver is not moving');

  const searching = await makeRider();
  await makeRide(searching, { status: 'MATCHING' });
  assert.equal((await call(deps, searching, 'POST', '/ride-page/cancel-ride', { reason: 'My plans changed' })).body.code, 'NO_TRIP');
});

test('change a booked trip\'s route: the app\'s ride:route:update (the ride service plans and prices it, the driver is told)', async () => {
  const { deps, events } = world();
  const { rider, driver, ride } = await bookedTrip('IN_PROGRESS');

  const changed = await call(deps, rider, 'POST', '/ride-page/trip-route', { stops: [IKEJA] });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  assert.equal(changed.body.phase, 'confirmed');
  assert.equal(events.length, 1);
  assert.equal(events[0].eventType, 'RIDE_ROUTE_UPDATE_REQUESTED');
  assert.equal(events[0].rideId, ride.id);
  assert.equal(events[0].riderId, rider);
  assert.equal(events[0].driverId, driver.driverId);
  assert.equal(events[0].updatedBy, 'rider');
  assert.deepEqual(events[0].destination, VI, 'no destination sent: the trip\'s own');
  assert.deepEqual(events[0].stops, [IKEJA]);
  assert.equal(events[0].fareEstimateNgn, undefined, 'priced by the ride service, as the app\'s');

  await call(deps, rider, 'POST', '/ride-page/trip-route', { destination: SURULERE, stops: [] });
  assert.deepEqual(events[1].destination, SURULERE);
  assert.deepEqual(events[1].stops, []);

  assert.equal((await call(deps, rider, 'POST', '/ride-page/trip-route', { destination: { lat: 7.1475, lng: 3.3619, address: 'Kuto, Abeokuta' }, stops: [] })).body.code, 'OUTSIDE_SERVICE_AREA');
  assert.equal((await call(deps, rider, 'POST', '/ride-page/trip-route', { stops: [{ lat: 'x', address: '' }] })).body.code, 'PLACE_INVALID');
  assert.equal(events.length, 2);

  const stranger = await makeRider();
  assert.equal((await call(deps, stranger, 'POST', '/ride-page/trip-route', { stops: [IKEJA] })).body.code, 'NO_TRIP');
});

test('the Emergency button raises the same alert as the ride card\'s SOS, once; "I\'m safe" withdraws it', async () => {
  const { deps } = world();
  const { rider, driver, ride } = await bookedTrip('IN_PROGRESS');

  const raised = await call(deps, rider, 'POST', '/ride-page/sos');
  assert.equal(raised.status, 200);
  assert.deepEqual(raised.body, { ok: true, alreadyOpen: false });
  const alerts = await prisma.safetyAlert.findMany({ where: { userId: rider } });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, 'SOS');
  assert.equal(alerts[0].raisedByRole, 'RIDER');
  assert.equal(alerts[0].rideId, ride.id);
  assert.equal(alerts[0].counterpartUserId, driver.userId);
  assert.match(alerts[0].note, /ride page/);

  assert.deepEqual((await call(deps, rider, 'POST', '/ride-page/sos')).body, { ok: true, alreadyOpen: true });
  assert.equal(await prisma.safetyAlert.count({ where: { userId: rider } }), 1, 'one emergency, not two');
  assert.equal((await call(deps, rider, 'GET', '/ride-page/state')).body.sosActive, true);

  assert.deepEqual((await call(deps, rider, 'POST', '/ride-page/sos/cancel')).body, { ok: true, withdrawn: true });
  assert.equal((await call(deps, rider, 'GET', '/ride-page/state')).body.sosActive, false);
  assert.deepEqual((await call(deps, rider, 'POST', '/ride-page/sos/cancel')).body, { ok: true, withdrawn: false });
});
