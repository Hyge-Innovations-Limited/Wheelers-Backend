// Release A fixes, through the real entry points: handleRidePageRoute (the ride
// page), handleRideMessage (the app's socket), handleRideEvent (the gateway's
// Kafka consumer, events parsed with the real schema), handleMetaWhatsappWebhookRoute
// (WhatsApp), ride-service's scheduler (dispatchSingleRide) and RIDE_REQUESTED
// consumer, and submitWithdrawal. Against the local Postgres; Redis is an
// in-memory stand-in; Kafka, Meta and Telegram are recorded, not called.
//
//   - auto-accept's yes is for a price (C1, C2)
//   - a route change asks first: quote, then the change at that price (C3)
//   - a cancel that never went out leaves the ride as it was (M1)
//   - a held ride for later never becomes a search nobody sees; it gives up an
//     hour late and the rider hears it, once (M2, M3, W1, W4, W5)
//   - the start template: a one-time code, a quick reply, no plain messages
//     until the rider answers, and nothing at all when it cannot be sent (M4, W2, W3)
//   - the 24 h window is the rider's last message alone (M5)
//   - "back in your wallet" only when it is; one Paystack alert per half hour (M6)
//   - the Emergency button's kinds (S1)
//
//   node scripts/run-with-env.cjs node --test --test-force-exit test/release-a-fixes.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');

const { RideEvent } = require('../packages/kafka-schemas/dist/index.js');
const db = require('../packages/db/dist/index.js');
const local = require('../apps/api-gateway/dist/auth/local.js');
const bidState = require('../apps/api-gateway/dist/whatsapp-flows/bid-state.js');
const autoAccept = require('../apps/api-gateway/dist/rides/auto-accept.js');
const bookingLock = require('../apps/api-gateway/dist/rides/booking-lock.js');
const { handleRidePageRoute } = require('../apps/api-gateway/dist/http/ride-page.route.js');
const { getSafePathForLog } = require('../apps/api-gateway/dist/http/log-path.js');
const { handleRideEvent, scheduledGaveUpText } = require('../apps/api-gateway/dist/kafka/consumer.js');
const { handleRideMessage } = require('../apps/api-gateway/dist/websocket/handlers/ride.handler.js');
const { handleMetaWhatsappWebhookRoute, sayRidePageEventInChat } = require('../apps/api-gateway/dist/http/whatsapp.route.js');
const { SCHEDULED_START_HELD_REASON } = require('../apps/api-gateway/dist/rides/scheduled-whatsapp.js');
const { submitWithdrawal, WithdrawalError, FLOAT_SHORT_MESSAGE, WITHDRAWAL_PENDING_CONFIRMATION_MESSAGE } = require('../apps/api-gateway/dist/payments/withdrawal.js');
const { dispatchSingleRide } = require('../apps/ride-service/dist/handlers/scheduled-rides.handler.js');
const { createRideRequestedConsumer } = require('../apps/ride-service/dist/consumers/ride-requested.consumer.js');

const prisma = new PrismaClient();
const JWT_SECRET = 'test-secret-that-is-at-least-32-characters-long';
const realFetch = global.fetch;
const realConsole = { log: console.log, info: console.info, warn: console.warn, error: console.error };
const realEnv = { ...process.env };
const made = { users: [], rides: [], scheduled: [], drivers: [] };

const YABA = { lat: 6.5095, lng: 3.3711, address: '12 Herbert Macaulay Way, Yaba, Lagos' };
const VI = { lat: 6.4281, lng: 3.4219, address: 'Adeola Odeku Street, Victoria Island, Lagos' };
const SURULERE = { lat: 6.4995, lng: 3.3540, address: 'Adeniran Ogunsanya Street, Surulere, Lagos' };
const IKEJA = { lat: 6.6018, lng: 3.3515, address: 'Ikeja City Mall, Obafemi Awolowo Way, Ikeja' };
const place = { pickupLat: YABA.lat, pickupLng: YABA.lng, pickupAddress: YABA.address, destLat: VI.lat, destLng: VI.lng, destAddress: VI.address };
const LINE = [{ lat: YABA.lat, lng: YABA.lng }, { lat: IKEJA.lat, lng: IKEJA.lng }, { lat: VI.lat, lng: VI.lng }];

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
      if (cmd === 'GETDEL') { const v = store.has(key) ? store.get(key) : null; store.delete(key); return v; }
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

function planner(fareNgn = 5200, calls = { n: 0 }) {
  return { calls, planRoute: async () => { calls.n += 1; return { distanceKm: 11.4, durationSeconds: 1680, suggestedFareNgn: fareNgn, minOfferNgn: 4700, ratePerKmNgn: 420, priceReason: null, geometry: { coordinates: LINE, bounds: { northEast: VI, southWest: YABA } } }; } };
}

function world(extra = {}) {
  const redis = memoryRedis();
  const events = []; const chat = [];
  const deps = {
    jwtSecret: JWT_SECRET,
    redisClient: redis,
    publisher: { publishRideEvent: async (event) => { events.push(event); }, publishNotificationEvent: async () => {} },
    paymentsClient: {},
    googleMapsApiKey: 'server-key',
    routePlanner: planner(),
    notifyChat: async (event) => { chat.push(event); },
    ...extra,
  };
  return { redis, events, chat, deps };
}

async function makeRider(phone = `+23480${Math.floor(1e8 + Math.random() * 9e8)}`, balanceNgn = 0) {
  const id = randomUUID();
  await prisma.user.create({ data: { id, privyDid: `whatsapp:${phone}`, role: 'RIDER', name: 'Fix Rider', phone, privacyConsent: 'AGREED', privacyConsentAt: new Date() } });
  await prisma.wallet.create({ data: { userId: id, balanceNgn } });
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

async function bookedTrip(status = 'IN_PROGRESS') {
  const rider = await makeRider();
  const driver = await makeDriver();
  const ride = await makeRide(rider, { driverId: driver.driverId, status, agreedFareNgn: 5200, distanceKm: 11.4, durationSeconds: 1680 });
  await prisma.rideStop.createMany({ data: [
    { rideId: ride.id, stopOrder: 0, type: 'INTERMEDIATE', status: 'PENDING', lat: SURULERE.lat, lng: SURULERE.lng, address: SURULERE.address },
    { rideId: ride.id, stopOrder: 1, type: 'FINAL', status: 'PENDING', lat: VI.lat, lng: VI.lng, address: VI.address },
  ] });
  return { rider, driver, ride };
}

async function call(deps, userId, method, path, body) {
  const bearer = local.createWalletPageToken(userId, 'ride', JWT_SECRET, local.RIDE_PAGE_TOKEN_TTL_SECONDS);
  const raw = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = { method, headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }, async *[Symbol.asyncIterator]() { for (const c of raw) yield c; } };
  const res = { statusCode: 200, body: null, headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, writeHead(code) { this.statusCode = code; return this; }, end(text) { this.body = text ? JSON.parse(text) : null; } };
  await handleRidePageRoute(req, res, deps, new URL(`http://x${path}`));
  return { status: res.statusCode, body: res.body, headers: res.headers };
}

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

async function startedRow(riderId, extra = {}) {
  const event = started(riderId, extra);
  const row = await prisma.scheduledRide.create({ data: { riderId, scheduledFor: new Date(Date.now() + 5 * 60_000), status: 'DISPATCHED', requestedRideId: event.rideId, channel: 'WHATSAPP', ...place } });
  made.scheduled.push(row.id);
  return { event, row };
}

/** Meta (and Telegram), recorded. `refuse`: Meta answers 400 to what matches. */
function recordFetch({ refuse = () => false } = {}) {
  const sent = []; const telegram = [];
  global.fetch = async (url, init) => {
    const href = String(url);
    if (href.includes('api.telegram.org')) { telegram.push(href); return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => '' }; }
    const body = init?.body ? JSON.parse(init.body) : null;
    if (href.includes('graph.facebook.com') && body && refuse(body)) return { ok: false, status: 400, json: async () => ({}), text: async () => 'refused' };
    if (body && body.status !== 'read') sent.push({ url: href, body });
    return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.x' }], choices: [{ message: { content: '{"intent":"other"}' } }] }), text: async () => '' };
  };
  return { sent, telegram, messages: () => sent.filter((s) => s.url.includes('graph.facebook.com') && ['text', 'interactive', 'template', 'image'].includes(s.body?.type)) };
}

function recordProducer({ failGaveUp = false } = {}) {
  const out = [];
  const record = (name) => async (event) => { out.push({ name, event }); };
  return {
    out,
    producer: {
      scheduledRideHeld: record('held'),
      scheduledRideGaveUp: async (event) => { if (failGaveUp) throw new Error('kafka away'); out.push({ name: 'gaveUp', event }); },
      rideCancelled: record('cancelled'), rideBidTimeout: record('timeout'),
      broadcastRideOffer: async (params) => { out.push({ name: 'broadcast', event: params.rideRequested }); },
      rideRequested: record('requested'), rideDriverAssigned: record('assigned'), rideDriverRejected: record('rejected'),
      rideCompleted: record('completed'), rideRouteUpdated: record('route'), rideAssignmentFailed: record('failed'),
      groupRideDriverAssigned: record('group'), rideOfferAccepted: record('accepted'), sendUpdatedOfferToDriver: async () => {},
    },
  };
}

function rideService() {
  const { out, producer } = recordProducer();
  const state = { onlineDrivers: new Map(), assignedDriversByRideId: new Map(), rideParticipantsByRideId: new Map(), gpsByRideId: new Map(), routeByRideId: new Map(), pendingMatchesByRideId: new Map() };
  const consumer = createRideRequestedConsumer({ state, rideEnv: { MATCH_RADIUS_KM: '5', MAX_MATCH_ATTEMPTS: '5' }, rideEventsProducer: producer });
  const handle = (event) => consumer.handle(event, { topic: 'ride.events', partition: 0, offset: '0', timestamp: '0', headers: {} });
  return { out, state, handle, stop() { for (const p of state.pendingMatchesByRideId.values()) if (p.timeout) clearTimeout(p.timeout); } };
}

/** A WhatsApp message, as Meta posts it, through the real webhook route. */
let messageCounter = 0;
async function whatsapp(deps, phone, message) {
  messageCounter += 1;
  const payload = { object: 'whatsapp_business_account', entry: [{ changes: [{ value: {
    contacts: [{ profile: { name: 'Fix Rider' }, wa_id: phone.replace(/^\+/, '') }],
    messages: [{ id: `wamid.fix.${Date.now()}.${messageCounter}`, from: phone.replace(/^\+/, ''), ...message }],
  } }] }] };
  const raw = Buffer.from(JSON.stringify(payload));
  await handleMetaWhatsappWebhookRoute({ method: 'POST', headers: {}, async *[Symbol.asyncIterator]() { yield raw; } }, { statusCode: 0, setHeader() {}, writeHead() { return this; }, end() {} }, deps);
}

function webhookDeps(redis) {
  const published = [];
  return {
    published,
    deps: {
      jwtSecret: JWT_SECRET,
      publisher: new Proxy({}, { get: (_t, name) => async (event) => { published.push({ via: String(name), event }); } }),
      paymentsClient: { createCustomer: async () => ({ id: 'cus_x' }), findCustomerByReference: async () => null, updateCustomer: async () => ({}), createVirtualAccount: async () => ({ id: 'va_x', bank_name: 'Test Bank', account_number: '0123456789', account_name: 'Test', currency: 'NGN', country: 'NG' }) },
      redisClient: redis,
      routePlanner: planner(),
      googleMapsApiKey: 'test-key',
      metaAccessToken: 'meta-token',
      metaPhoneNumberId: '1234567890',
      groqApiKey: 'groq-key',
      groqModel: 'openai/gpt-oss-120b',
      groqTimeoutMs: 4000,
      appBaseUrl: 'https://app.wheelersng.com',
    },
  };
}

test.beforeEach(() => { console.log = console.info = console.warn = console.error = () => {}; delete process.env.WHATSAPP_SCHEDULED_TEMPLATE; });
test.afterEach(() => {
  Object.assign(console, realConsole); global.fetch = realFetch;
  for (const key of ['WHATSAPP_SCHEDULED_TEMPLATE', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'ALERTS']) {
    if (realEnv[key] === undefined) delete process.env[key]; else process.env[key] = realEnv[key];
  }
});
test.after(async () => {
  await prisma.outboxEvent.deleteMany({ where: { key: { in: made.rides } } }).catch(() => {});
  await prisma.safetyAlert.deleteMany({ where: { userId: { in: made.users } } }).catch(() => {});
  await prisma.scheduledRide.deleteMany({ where: { riderId: { in: made.users } } }).catch(() => {});
  await prisma.driverBid.deleteMany({ where: { rideId: { in: made.rides } } }).catch(() => {});
  await prisma.rideHold.deleteMany({ where: { rideId: { in: made.rides } } }).catch(() => {});
  await prisma.rideStop.deleteMany({ where: { rideId: { in: made.rides } } }).catch(() => {});
  await prisma.ride.deleteMany({ where: { OR: [{ id: { in: made.rides } }, { riderId: { in: made.users } }] } }).catch(() => {});
  await prisma.driver.deleteMany({ where: { id: { in: made.drivers } } }).catch(() => {});
  await prisma.withdrawalRequest.deleteMany({ where: { userId: { in: made.users } } }).catch(() => {});
  await prisma.transaction.deleteMany({ where: { wallet: { userId: { in: made.users } } } }).catch(() => {});
  await prisma.walletReservation.deleteMany({ where: { userId: { in: made.users } } }).catch(() => {});
  await prisma.virtualAccount.deleteMany({ where: { userId: { in: made.users } } }).catch(() => {});
  await prisma.wallet.deleteMany({ where: { userId: { in: made.users } } }).catch(() => {});
  // One by one: a row this file did not foresee keeps that user, not all of them.
  for (const id of made.users) await prisma.user.delete({ where: { id } }).catch(() => {});
  await prisma.$disconnect();
});

/* ── C1, C2: a yes is for a price ─────────────────────────────────────── */

async function pageSearch(w, rider, body) {
  await bidState.storePendingRoute(w.redis, rider, {
    ...place, stops: [], distanceKm: 11.4, durationSeconds: 1680, suggestedFareNgn: 7900, minOfferNgn: 7000, ratePerKmNgn: 420, confirmed: true,
  });
  const found = await call(w.deps, rider, 'POST', '/ride-page/find', body);
  assert.equal(found.status, 200, JSON.stringify(found.body));
  return found.body;
}

test('ride page: Find with a yes keeps its price; a raised price without a new yes switches it off; a yes sent with the price keeps it on at that price', async () => {
  const w = world();
  const { deps: consumer } = consumerDeps(w.redis);
  const rider = await makeRider(undefined, 20_000);
  const found = await pageSearch(w, rider, { amountNgn: 7900, autoAccept: true });
  assert.deepEqual([found.autoAccept, found.autoAcceptPriceNgn], [true, 7900]);
  const rideId = found.rideId;

  // Raised to ₦8,500 with no answer (an older page): the change reaches the gateway, and the yes does not carry over.
  await call(w.deps, rider, 'POST', '/ride-page/offer', { amountNgn: 8500 });
  for (const e of w.events.splice(0).filter((e) => e.eventType === 'RIDE_RIDER_COUNTER_OFFER')) await handleRideEvent(RideEvent.parse(e), consumer, new Map());
  let state = (await call(w.deps, rider, 'GET', '/ride-page/state')).body;
  assert.deepEqual([state.offerNgn, state.autoAccept, state.autoAcceptPriceNgn], [8500, false, null]);

  // Raised again with "Yes, auto-book" for it: on, at ₦9,000 — before or after the change reaches the gateway.
  await call(w.deps, rider, 'POST', '/ride-page/offer', { amountNgn: 9000, autoAccept: true });
  for (const e of w.events.splice(0).filter((e) => e.eventType === 'RIDE_RIDER_COUNTER_OFFER')) await handleRideEvent(RideEvent.parse(e), consumer, new Map());
  state = (await call(w.deps, rider, 'GET', '/ride-page/state')).body;
  assert.deepEqual([state.autoAccept, state.autoAcceptPriceNgn], [true, 9000]);

  // The switch with a price (the page's own sheet).
  state = (await call(w.deps, rider, 'POST', '/ride-page/auto-accept', { on: true, priceNgn: 9000 })).body;
  assert.deepEqual([state.autoAccept, state.autoAcceptPriceNgn], [true, 9000]);
  assert.match(w.redis.store.get(`ride:${rideId}:auto-accept`), /"priceNgn":9000/);
  // "No, I'll choose" with the price: off.
  await call(w.deps, rider, 'POST', '/ride-page/offer', { amountNgn: 9200, autoAccept: false });
  assert.equal((await call(w.deps, rider, 'GET', '/ride-page/state')).body.autoAccept, false);
});

test('a price typed in the WhatsApp chat never keeps a yes (through the webhook)', async () => {
  const redis = memoryRedis();
  const { deps, published } = webhookDeps(redis);
  const fetched = recordFetch();
  const phone = `+23480${Math.floor(1e8 + Math.random() * 9e8)}`;
  const rider = await makeRider(phone, 20_000);
  const rideId = randomUUID();
  await makeRide(rider, { id: rideId, status: 'MATCHING', riderOfferNgn: 5200, channel: 'WHATSAPP' });
  await bidState.storeWhatsappRide(redis, rideId, { riderId: rider, phone, pickupAddress: YABA.address, pickupLat: YABA.lat, pickupLng: YABA.lng, destinationAddress: VI.address, destinationLat: VI.lat, destinationLng: VI.lng, stops: [], distanceKm: 11.4, durationSeconds: 1680, offerNgn: 5200, suggestedFareNgn: 5200, priceReason: null, paymentMethod: 'WALLET', createdAt: new Date().toISOString() });
  await bidState.setActiveRide(redis, rider, rideId);
  await bidState.setRideState(redis, rideId, 'searching');
  await autoAccept.autoAcceptOnAtStart(redis, rideId, rider, 5200);

  await whatsapp(deps, phone, { type: 'text', text: { body: '5000' } });
  assert.ok(published.some((p) => p.event?.eventType === 'RIDE_RIDER_COUNTER_OFFER' && p.event.counterOfferNgn === 5000), JSON.stringify(fetched.messages().map((m) => m.body.text?.body)));
  assert.equal(await autoAccept.isAutoAcceptOn(redis, rideId), false, 'even a lower price: the chat never asked');
});

/* ── C3: a route change asks first ────────────────────────────────────── */

test('trip route: the quote says what more is held, moves nothing; the change goes ahead only at that price, held exactly; 5 stops as in the app', async () => {
  const calls = { n: 0 };
  const w = world({ routePlanner: planner(6000, calls) });
  const { rider, ride } = await bookedTrip('IN_PROGRESS');

  const state = (await call(w.deps, rider, 'GET', '/ride-page/state')).body;
  assert.equal(state.maxStops, 5, 'as many stops as the app allows on a trip');

  const quote = await call(w.deps, rider, 'POST', '/ride-page/trip-route/quote', { stops: [IKEJA] });
  assert.deepEqual([quote.status, quote.body], [200, { fareNgn: 6000, extraNgn: 800 }]);
  assert.equal(w.events.length, 0, 'a quote moves nothing');

  const wrong = await call(w.deps, rider, 'POST', '/ride-page/trip-route', { stops: [IKEJA], acceptedFareNgn: 5200 });
  assert.deepEqual([wrong.status, wrong.body.code, wrong.body.fareNgn, wrong.body.extraNgn], [409, 'PRICE_CHANGED', 6000, 800]);
  assert.equal(w.events.length, 0);

  const done = await call(w.deps, rider, 'POST', '/ride-page/trip-route', { stops: [IKEJA], acceptedFareNgn: 6000 });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(calls.n, 1, 'priced once: the change is the quote the rider saw');
  assert.equal(w.events.length, 1);
  assert.equal(w.events[0].eventType, 'RIDE_ROUTE_UPDATE_REQUESTED');
  assert.equal(w.events[0].fareEstimateNgn, 6000, 'wallet-service holds exactly this (adjustRideHold on RIDE_ROUTE_UPDATED)');
  assert.deepEqual(done.body.trip.line, LINE, 'the road drawn is the new route');
  assert.equal(done.body.rideId, ride.id);

  // Five stops (a trip booked in the app with five): none cut off.
  const five = [IKEJA, SURULERE, YABA, IKEJA, SURULERE];
  const q5 = await call(w.deps, rider, 'POST', '/ride-page/trip-route/quote', { stops: five });
  await call(w.deps, rider, 'POST', '/ride-page/trip-route', { stops: five, acceptedFareNgn: q5.body.fareNgn });
  assert.equal(w.events.at(-1).stops.length, 5);

  const stranger = await makeRider();
  assert.equal((await call(w.deps, stranger, 'POST', '/ride-page/trip-route/quote', { stops: [IKEJA] })).body.code, 'NO_TRIP');
});

test('the app\'s socket: ride:route:quote, and ride:route:update with acceptedFareNgn refused at another price; without it, as before', async () => {
  const redis = memoryRedis();
  const events = [];
  const publisher = { publishRideEvent: async (e) => { events.push(e); } };
  const { rider, driver, ride } = await bookedTrip('DRIVER_EN_ROUTE');
  const auth = { userId: rider, role: 'RIDER' };
  const plan = planner(5700);

  const quoted = await handleRideMessage('ride:route:quote', { rideId: ride.id, destination: VI, stops: [IKEJA] }, auth, publisher, plan, redis);
  assert.deepEqual([quoted.type, quoted.payload.fareNgn, quoted.payload.extraNgn], ['ride:route:quote:result', 5700, 500]);
  const refused = await handleRideMessage('ride:route:update', { rideId: ride.id, driverId: driver.driverId, destination: VI, stops: [IKEJA], acceptedFareNgn: 5200 }, auth, publisher, plan, redis);
  assert.deepEqual([refused.type, refused.payload.reason, refused.payload.fareNgn], ['ride:route:update:rejected', 'PRICE_CHANGED', 5700]);
  assert.equal(events.length, 0);
  const agreed = await handleRideMessage('ride:route:update', { rideId: ride.id, driverId: driver.driverId, destination: VI, stops: [IKEJA], acceptedFareNgn: 5700 }, auth, publisher, plan, redis);
  assert.equal(agreed.type, 'ride:route:update:accepted');
  assert.equal(events[0].fareEstimateNgn, 5700);

  // An app that sends no price: as before (the ride service prices it).
  await handleRideMessage('ride:route:update', { rideId: ride.id, driverId: driver.driverId, destination: VI, stops: [] }, auth, publisher, plan, redis);
  assert.equal(events[1].fareEstimateNgn, undefined);

  const stranger = await makeRider();
  await assert.rejects(handleRideMessage('ride:route:quote', { rideId: ride.id, destination: VI, stops: [] }, { userId: stranger, role: 'RIDER' }, publisher, plan, redis), /not yours/);
});

test('a route changed in the app: the trip\'s road on the page is the new one (RIDE_ROUTE_UPDATED)', async () => {
  const w = world();
  const { deps } = consumerDeps(w.redis);
  const { rider, ride, driver } = await bookedTrip('IN_PROGRESS');
  await handleRideEvent(RideEvent.parse({
    eventType: 'RIDE_ROUTE_UPDATED', rideId: ride.id, riderId: rider, driverId: driver.driverId, destination: VI,
    stops: [{ stopId: randomUUID(), stopOrder: 0, type: 'final', status: 'pending', lat: VI.lat, lng: VI.lng, address: VI.address }],
    route: { coordinates: LINE, bounds: { northEast: VI, southWest: YABA } }, updatedBy: 'rider', timestamp: new Date().toISOString(),
  }), deps, new Map());
  assert.deepEqual((await call(w.deps, rider, 'GET', '/ride-page/state')).body.trip.line, LINE);
});

/* ── M1: a cancel that never went out ─────────────────────────────────── */

test('a cancel that could not be sent leaves the ride as it was: still on the page, and the chat may speak of it', async () => {
  const w = world();
  w.deps.publisher.publishRideEvent = async () => { throw new Error('kafka away'); };
  const { rider, ride } = await bookedTrip('DRIVER_EN_ROUTE');
  const failed = await call(w.deps, rider, 'POST', '/ride-page/cancel-ride', { reason: 'My plans changed' });
  assert.deepEqual([failed.status, failed.body.code], [503, 'CANCEL_FAILED']);
  assert.equal(await bidState.wasCancelledOnPage(w.redis, ride.id), false);
  assert.equal(await bookingLock.isSearchEnded(w.redis, ride.id), false);
  assert.equal((await call(w.deps, rider, 'GET', '/ride-page/state')).body.phase, 'confirmed');

  // A search cancelled on the page: the same.
  const searcher = await makeRider();
  const rideId = randomUUID();
  await bidState.storeWhatsappRide(w.redis, rideId, { riderId: searcher, phone: '+2348030000001', pickupAddress: YABA.address, destinationAddress: VI.address, offerNgn: 5000, suggestedFareNgn: 5000, createdAt: new Date().toISOString() });
  await bidState.setActiveRide(w.redis, searcher, rideId);
  const search = await call(w.deps, searcher, 'POST', '/ride-page/cancel', { reason: 'My plans changed' });
  assert.equal(search.body.code, 'CANCEL_FAILED');
  assert.equal(await bidState.wasCancelledOnPage(w.redis, rideId), false);
  assert.equal(await bookingLock.isSearchEnded(w.redis, rideId), false, 'auto-accept may still book it');
  assert.equal(await bidState.getActiveRide(w.redis, searcher), rideId);
});

/* ── rides for later: put back, given up, told ────────────────────────── */

test('SCHEDULED_RIDE_HELD through the real schema: said once in the chat', async () => {
  const redis = memoryRedis();
  const fetched = recordFetch();
  const { deps } = consumerDeps(redis, { whatsappNotifier: { metaAccessToken: 't', metaPhoneNumberId: 'p' } });
  const rider = await makeRider();
  await bidState.markWhatsappInbound(redis, rider);
  const raw = { eventType: 'SCHEDULED_RIDE_HELD', rideId: randomUUID(), riderId: rider, scheduledFor: '2026-10-28T14:30:00.000Z', pickupAddress: YABA.address, timestamp: new Date().toISOString() };
  await handleRideEvent(RideEvent.parse(raw), deps, new Map());
  await handleRideEvent(RideEvent.parse(raw), deps, new Map());
  assert.equal(fetched.messages().length, 1);
  assert.match(JSON.stringify(fetched.messages()[0].body), /Your 3:30 PM ride will start when this one ends\./);
});

test('a ride for later an hour past its time is given up: cancelled, the rider told once; a notice that cannot go out keeps it for the next scan', async () => {
  const gateway = memoryRedis();
  const rider = await makeRider();
  await bidState.markWhatsappInbound(gateway, rider);
  const late = await prisma.scheduledRide.create({ data: { riderId: rider, scheduledFor: new Date(Date.now() - 61 * 60_000), channel: 'WHATSAPP', ...place, fareEstimateNgn: 5200 } });
  made.scheduled.push(late.id);

  const broken = recordProducer({ failGaveUp: true });
  await dispatchSingleRide(late.id, { rideEventsProducer: broken.producer, redis: ioRedis(gateway) });
  assert.equal((await prisma.scheduledRide.findUnique({ where: { id: late.id } })).status, 'SCHEDULED', 'not cancelled unsaid');

  const { out, producer } = recordProducer();
  await dispatchSingleRide(late.id, { rideEventsProducer: producer, redis: ioRedis(gateway) });
  const row = await prisma.scheduledRide.findUnique({ where: { id: late.id } });
  assert.deepEqual([row.status, row.cancellationReason, row.requestedRideId], ['CANCELLED', 'waited_too_long', null]);
  assert.deepEqual(out.map((o) => [o.name, o.event.reason]), [['gaveUp', 'waited_too_long']]);
  assert.equal(await prisma.outboxEvent.count({ where: { payload: { path: ['riderId'], equals: rider } } }), 0, 'never started hours late');

  // An hour is not up yet: a busy rider's ride for later still waits.
  const soon = await prisma.scheduledRide.create({ data: { riderId: rider, scheduledFor: new Date(Date.now() - 50 * 60_000), channel: 'WHATSAPP', ...place, fareEstimateNgn: 5200 } });
  made.scheduled.push(soon.id);
  await makeRide(rider, { status: 'MATCHING' });
  await dispatchSingleRide(soon.id, { rideEventsProducer: producer, redis: ioRedis(gateway) });
  assert.equal((await prisma.scheduledRide.findUnique({ where: { id: soon.id } })).status, 'SCHEDULED');
});

test('given up (SCHEDULED_RIDE_GAVE_UP): in the chat when it reaches them; else a notice on the page\'s Home and the app — once', async () => {
  const notifier = { metaAccessToken: 't', metaPhoneNumberId: 'p' };
  const scheduledFor = '2026-10-28T14:30:00.000Z';
  assert.equal(scheduledGaveUpText(scheduledFor), 'Your 3:30 PM ride could not start, so it was cancelled.');
  const gaveUp = (riderId, reason) => RideEvent.parse({ eventType: 'SCHEDULED_RIDE_GAVE_UP', rideId: randomUUID(), riderId, scheduledFor, pickupAddress: YABA.address, reason, timestamp: new Date().toISOString() });

  // Their window open, off the page: the chat.
  const redis = memoryRedis();
  let fetched = recordFetch();
  const chatty = consumerDeps(redis, { whatsappNotifier: notifier });
  const open = await makeRider();
  await bidState.markWhatsappInbound(redis, open);
  const event = gaveUp(open, 'waited_too_long');
  await handleRideEvent(event, chatty.deps, new Map());
  await handleRideEvent(event, chatty.deps, new Map());
  assert.equal(fetched.messages().length, 1, 'once');
  assert.match(JSON.stringify(fetched.messages()[0].body), /Your 3:30 PM ride could not start, so it was cancelled\./);
  assert.equal(chatty.pushes.length, 0);

  // Window closed: never silent — Home on the page, and the app.
  fetched = recordFetch();
  const closed = await makeRider();
  const closedEvent = gaveUp(closed, 'window_closed');
  await handleRideEvent(closedEvent, chatty.deps, new Map());
  assert.equal(fetched.messages().length, 0, 'a plain message cannot reach them');
  assert.deepEqual(chatty.pushes.map((p) => [p.eventType, p.body]), [['PUSH_SEND', 'Your 3:30 PM ride could not start, so it was cancelled.'], ['IN_APP_SEND', 'Your 3:30 PM ride could not start, so it was cancelled.']]);
  const w = world();
  w.deps.redisClient = redis;
  const home = (await call(w.deps, closed, 'GET', '/ride-page/state')).body;
  assert.equal(home.phase, 'idle');
  assert.deepEqual(home.notice, { id: closedEvent.rideId, text: 'Your 3:30 PM ride could not start, so it was cancelled.' });
  assert.equal((await call(w.deps, closed, 'POST', '/ride-page/notice/seen', { id: 'another' })).body.notice.id, closedEvent.rideId, 'only that notice is cleared');
  assert.equal((await call(w.deps, closed, 'POST', '/ride-page/notice/seen', { id: closedEvent.rideId })).body.notice, null);

  // On the page (window open): the page, not the chat.
  fetched = recordFetch();
  const onPage = await makeRider();
  await bidState.markWhatsappInbound(redis, onPage);
  await bidState.markRidePageSeen(redis, onPage);
  await handleRideEvent(gaveUp(onPage, 'waited_too_long'), chatty.deps, new Map());
  assert.equal(fetched.messages().length, 0);
  assert.ok(await bidState.getPageNotice(redis, onPage));
});

test('a held ride for later starts on a later scan once the rider is free: put back by the gateway, dispatched again, a WhatsApp search', async () => {
  const gateway = memoryRedis();
  const { producer } = recordProducer();
  const ctx = { rideEventsProducer: producer, redis: ioRedis(gateway) };
  const rider = await makeRider();
  await bidState.markWhatsappInbound(gateway, rider);
  const scheduled = await prisma.scheduledRide.create({ data: { riderId: rider, scheduledFor: new Date(Date.now() + 4 * 60_000), channel: 'WHATSAPP', ...place, fareEstimateNgn: 5200, plannedDistanceKm: 11.4, plannedDurationSeconds: 1680 } });
  made.scheduled.push(scheduled.id);

  // Dispatched while free; by the time the gateway hears it the rider started a search: put back.
  await dispatchSingleRide(scheduled.id, ctx);
  let row = await prisma.scheduledRide.findUnique({ where: { id: scheduled.id } });
  const first = (await prisma.outboxEvent.findFirst({ where: { key: row.requestedRideId } })).payload;
  made.rides.push(first.rideId);
  const busy = await makeRide(rider, { status: 'MATCHING' });
  const { deps, said, events } = consumerDeps(gateway);
  await handleRideEvent(RideEvent.parse(first), deps, new Map());
  row = await prisma.scheduledRide.findUnique({ where: { id: scheduled.id } });
  assert.deepEqual([row.status, row.requestedRideId], ['SCHEDULED', null]);
  assert.deepEqual(events.map((e) => [e.eventType, e.reason]), [['RIDE_CANCELLED', SCHEDULED_START_HELD_REASON]]);
  assert.equal(said.length, 0);

  // Next scan, still busy: waits. Then free: a new search, and it is a WhatsApp one.
  await dispatchSingleRide(scheduled.id, ctx);
  assert.equal((await prisma.scheduledRide.findUnique({ where: { id: scheduled.id } })).status, 'SCHEDULED');
  await prisma.ride.update({ where: { id: busy.id }, data: { status: 'COMPLETED' } });
  await dispatchSingleRide(scheduled.id, ctx);
  row = await prisma.scheduledRide.findUnique({ where: { id: scheduled.id } });
  assert.equal(row.status, 'DISPATCHED');
  assert.notEqual(row.requestedRideId, first.rideId);
  const second = (await prisma.outboxEvent.findFirst({ where: { key: row.requestedRideId } })).payload;
  made.rides.push(second.rideId);
  await handleRideEvent(RideEvent.parse(second), deps, new Map());
  assert.equal(await bidState.getActiveRide(gateway, rider), second.rideId);
  assert.equal(said.length, 1);
  assert.equal(await gateway.get(`ride:${second.rideId}:wa-scheduled`), '1');
});

test('the gateway\'s busy call is final: ride-service started the search, the gateway put it back, and the search ends', async () => {
  const service = rideService();
  const redis = memoryRedis();
  const rider = await makeRider();
  const { event, row } = await startedRow(rider);
  made.rides.push(event.rideId);
  await service.handle(event);
  assert.equal(service.state.pendingMatchesByRideId.has(event.rideId), true, 'ride-service does not ask again whether the rider is busy');

  // The gateway, a moment later, finds them busy (a search of theirs reached the database).
  await makeRide(rider, { status: 'MATCHING' });
  const { deps, events, said } = consumerDeps(redis);
  await handleRideEvent(event, deps, new Map());
  assert.equal(said.length, 0);
  assert.deepEqual(events.map((e) => e.reason), [SCHEDULED_START_HELD_REASON]);
  await service.handle(events[0]);
  assert.equal(service.state.pendingMatchesByRideId.has(event.rideId), false, 'no search left that nobody sees');
  assert.equal((await prisma.scheduledRide.findUnique({ where: { id: row.id } })).status, 'SCHEDULED');
  service.stop();
});

test('a WhatsApp ride for later the rider replaced on purpose (not in the same seconds) is not put back', async () => {
  const service = rideService();
  const rider = await makeRider();
  const { event, row } = await startedRow(rider);
  made.rides.push(event.rideId);
  await service.handle(event);
  // They saw it start, and a minute later booked something else in the app.
  await prisma.ride.update({ where: { id: event.rideId }, data: { createdAt: new Date(Date.now() - 60_000) } });
  const own = { ...started(rider), scheduled: undefined, channel: 'APP' };
  made.rides.push(own.rideId);
  await service.handle(own);
  assert.equal((await prisma.ride.findUnique({ where: { id: event.rideId } })).status, 'CANCELLED');
  const after = await prisma.scheduledRide.findUnique({ where: { id: row.id } });
  assert.deepEqual([after.status, after.requestedRideId], ['DISPATCHED', event.rideId], 'it is not started again');
  service.stop();
});

/* ── the start template ───────────────────────────────────────────────── */

test('with the template: it goes out, the first offer adds no bubble, and the rider\'s tap on its quick reply opens the chat again (through the webhook)', async () => {
  process.env.WHATSAPP_SCHEDULED_TEMPLATE = 'scheduled_ride_started';
  const redis = memoryRedis();
  const fetched = recordFetch();
  const phone = `+23480${Math.floor(1e8 + Math.random() * 9e8)}`;
  const rider = await makeRider(phone);
  const { deps: meta } = webhookDeps(redis);
  const notifier = { metaAccessToken: 'meta-token', metaPhoneNumberId: '1234567890' };
  const { deps } = consumerDeps(redis, { whatsappNotifier: notifier, ridePageChat: (event) => sayRidePageEventInChat(meta, event) });
  const { event } = await startedRow(rider);
  await handleRideEvent(RideEvent.parse(event), deps, new Map());
  assert.deepEqual(fetched.messages().map((m) => m.body.type), ['template']);
  assert.equal(await bidState.getActiveRide(redis, rider), event.rideId, 'it is searching');
  assert.equal(await bidState.lookupPhoneByUserId(redis, rider), null, 'the phone lookup is not renewed by a start (it would look like an open window)');

  // A driver's offer: nothing in the chat (it would not arrive); the page shows it.
  const driver = await makeDriver();
  await handleRideEvent(RideEvent.parse({
    eventType: 'RIDE_COUNTER_OFFER', rideId: event.rideId, bidId: randomUUID(), riderId: rider, driverId: driver.driverId, driverUserId: driver.userId,
    counterOfferNgn: 5200, driverName: 'Chinedu Okafor', driverRating: 4.9, vehiclePlate: 'LND-174XA', vehicleModel: 'Toyota Corolla', etaSeconds: 240, distanceKm: 1.2,
    timestamp: new Date().toISOString(),
  }), deps, new Map());
  assert.deepEqual(fetched.messages().map((m) => m.body.type), ['template']);
  assert.equal((await bidState.getBids(redis, event.rideId)).length, 1);

  // They tap "OK" on the template: their window opens, nothing is said back.
  await whatsapp(meta, phone, { type: 'button', button: { text: 'OK', payload: 'ride_later_ok' } });
  assert.ok(await bidState.whatsappWindowEnd(redis, rider));
  assert.equal(await bidState.isRidePageOpen(redis, rider), false, 'the chat can speak to them again');
  assert.deepEqual(fetched.messages().map((m) => m.body.type), ['template']);
});

test('the template set but refused by Meta (window closed): no plain message; it waits again and its search ends quietly', async () => {
  process.env.WHATSAPP_SCHEDULED_TEMPLATE = 'scheduled_ride_started';
  const redis = memoryRedis();
  const fetched = recordFetch({ refuse: (body) => body.type === 'template' });
  const rider = await makeRider();
  const { deps: meta } = webhookDeps(redis);
  const { deps, events } = consumerDeps(redis, { whatsappNotifier: { metaAccessToken: 'meta-token', metaPhoneNumberId: '1234567890' }, ridePageChat: (event) => sayRidePageEventInChat(meta, event) });
  const { event, row } = await startedRow(rider);
  await handleRideEvent(RideEvent.parse(event), deps, new Map());
  assert.equal(fetched.messages().length, 0, 'never a plain message outside the window');
  assert.equal(await bidState.getActiveRide(redis, rider), null, 'undone');
  assert.equal(await bidState.getRideMeta(redis, event.rideId), null);
  assert.equal(await redis.get(`ride:${event.rideId}:wa-scheduled`), 'undone');
  assert.deepEqual(events.map((e) => [e.eventType, e.reason]), [['RIDE_CANCELLED', SCHEDULED_START_HELD_REASON]]);
  const after = await prisma.scheduledRide.findUnique({ where: { id: row.id } });
  assert.deepEqual([after.status, after.requestedRideId], ['SCHEDULED', null]);

  // No template at all, window closed (a race with the scheduler's own check): the same.
  delete process.env.WHATSAPP_SCHEDULED_TEMPLATE;
  const other = await startedRow(rider);
  await handleRideEvent(RideEvent.parse(other.event), deps, new Map());
  assert.equal(fetched.messages().length, 0);
  assert.equal((await prisma.scheduledRide.findUnique({ where: { id: other.row.id } })).status, 'SCHEDULED');
});

test('a start no longer current (put back meanwhile) is never set up', async () => {
  const redis = memoryRedis();
  const { deps, said } = consumerDeps(redis);
  const rider = await makeRider();
  await bidState.markWhatsappInbound(redis, rider);
  const { event, row } = await startedRow(rider);
  await prisma.scheduledRide.update({ where: { id: row.id }, data: { status: 'SCHEDULED', requestedRideId: null } });
  await handleRideEvent(event, deps, new Map());
  assert.equal(await bidState.getActiveRide(redis, rider), null);
  assert.equal(said.length, 0);
  assert.equal(await redis.get(`ride:${event.rideId}:wa-scheduled`), 'undone');
});

test('the open code never reaches a log', () => {
  assert.equal(getSafePathForLog(new URL('http://x/ride-page/open/AbCdEfGhIjKlMnOpQrStUv')), '/ride-page/open/<redacted>');
  assert.equal(getSafePathForLog(new URL('http://x/ride-page/state?token=abc&x=1')), '/ride-page/state?x=<redacted>');
});

/* ── M5: the window is the rider's last message ───────────────────────── */

test('an inbound WhatsApp message keeps its time for 30 days (through the webhook); once kept, the phone lookup never says the window', async () => {
  const redis = memoryRedis();
  const { deps } = webhookDeps(redis);
  recordFetch();
  const phone = `+23480${Math.floor(1e8 + Math.random() * 9e8)}`;
  const rider = await makeRider(phone);
  await whatsapp(deps, phone, { type: 'text', text: { body: 'hi' } });
  const at = Date.parse(await redis.get(`whatsapp:user:${rider}:last_in`));
  assert.ok(Math.abs(at - Date.now()) < 10_000);
  assert.equal(redis.ttls.get(`whatsapp:user:${rider}:last_in`), 30 * 24 * 60 * 60);
  assert.ok(await bidState.whatsappWindowEnd(redis, rider));

  // 25 hours ago, and the phone lookup renewed since by something else: closed.
  await bidState.markWhatsappInbound(redis, rider, Date.now() - 25 * 60 * 60_000);
  await bidState.setPhoneLookup(redis, rider, phone);
  redis.ttls.set(`whatsapp:phone_by_user:${rider}`, 20 * 60 * 60);
  assert.equal(await bidState.whatsappWindowEnd(redis, rider), null);
});

/* ── M6: withdrawals Paystack refuses for its own balance ─────────────── */

test('Paystack short: "back in your wallet" only when it is; the alert to top up once per half hour', async () => {
  process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  process.env.TELEGRAM_CHAT_ID = '1';
  delete process.env.ALERTS;
  const fetched = recordFetch();
  const { PaymentsApiError } = require('@wheleers/payments');
  const payments = { createPayout: async () => { throw new PaymentsApiError('Your balance is not enough to fulfil this request', 400); } };
  const publisher = { publishPaymentEvent: async () => {} };
  const redis = memoryRedis();
  const rider = await makeRider(undefined, 20_000);
  const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: rider } });
  const withdraw = () => submitWithdrawal({ paymentsClient: payments, publisher, redis }, { userId: rider, walletId: wallet.id, amountNgn: 3_000, bankCode: '057', accountNumber: '0000000000', accountName: 'Fix Rider', pinPolicy: 'if_set' });

  await assert.rejects(withdraw(), (error) => error instanceof WithdrawalError && error.code === 'FLOAT_SHORT' && error.message === FLOAT_SHORT_MESSAGE);
  assert.equal(Number((await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } })).lockedNgn), 0, 'it is back');

  // The release fails: the money is still reserved, and they are not told it is back.
  const realRelease = db.withdrawalClient.releaseFailedRequest;
  db.withdrawalClient.releaseFailedRequest = async () => { throw new Error('database away'); };
  try {
    await assert.rejects(withdraw(), (error) => error instanceof WithdrawalError && error.code === 'PENDING_CONFIRMATION' && error.fundsStillReserved && error.message === WITHDRAWAL_PENDING_CONFIRMATION_MESSAGE);
  } finally {
    db.withdrawalClient.releaseFailedRequest = realRelease;
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(fetched.telegram.length, 1, "one alert, not one per refused withdrawal");
  assert.ok(await redis.get('alerts:paystack-float-short'), 'the half hour is shared by every gateway process');
});

/* ── S1: the Emergency button's kinds ─────────────────────────────────── */

test('the Emergency button takes the app\'s kinds; the trip state lists them and, once sent, when and which', async () => {
  const w = world();
  const { rider } = await bookedTrip('IN_PROGRESS');
  let state = (await call(w.deps, rider, 'GET', '/ride-page/state')).body;
  assert.deepEqual(state.sosKinds, ['I need help now', 'Unsafe driving', 'We are off the route', 'There has been an accident', 'Medical emergency']);
  assert.equal(state.sosSentAt, undefined);

  assert.deepEqual((await call(w.deps, rider, 'POST', '/ride-page/sos', { kind: 'Unsafe driving' })).body, { ok: true, alreadyOpen: false });
  const alert = await prisma.safetyAlert.findFirstOrThrow({ where: { userId: rider } });
  assert.equal(alert.kind, 'UNSAFE_DRIVING');
  state = (await call(w.deps, rider, 'GET', '/ride-page/state')).body;
  assert.equal(state.sosActive, true);
  assert.equal(state.sosSentAt, alert.createdAt.toISOString());
  assert.equal(state.sosKind, 'Unsafe driving');

  await call(w.deps, rider, 'POST', '/ride-page/sos/cancel');
  await call(w.deps, rider, 'POST', '/ride-page/sos', { kind: 'MEDICAL' });
  assert.equal((await prisma.safetyAlert.findFirstOrThrow({ where: { userId: rider, status: { not: 'CANCELLED' } } })).kind, 'MEDICAL', 'the app\'s code too');
  await call(w.deps, rider, 'POST', '/ride-page/sos/cancel');
  await call(w.deps, rider, 'POST', '/ride-page/sos', { kind: 'something else' });
  assert.equal((await prisma.safetyAlert.findFirstOrThrow({ where: { userId: rider, status: { not: 'CANCELLED' } } })).kind, 'SOS', 'unknown: "I need help now"');
});
