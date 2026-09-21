// The bidding page: a WhatsApp rider names a price, watches driver offers and
// accepts one — on a page, not in the chat. Against a real Postgres; Redis is an
// in-memory stand-in and Kafka/Meta are recorded, not called.
//
//   DATABASE_URL=… node --test --test-force-exit test/ride-page.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');

const local = require('../apps/api-gateway/dist/auth/local.js');
const bidState = require('../apps/api-gateway/dist/whatsapp-flows/bid-state.js');
const { handleRidePageRoute } = require('../apps/api-gateway/dist/http/ride-page.route.js');
const notifier = require('../apps/api-gateway/dist/whatsapp-flows/whatsapp-notifier.js');

const prisma = new PrismaClient();
const JWT_SECRET = 'test-secret-that-is-at-least-32-characters-long';
const realFetch = global.fetch;
const realConsole = { log: console.log, info: console.info, warn: console.warn, error: console.error };

const QUOTE = {
  pickupLat: 6.6194, pickupLng: 3.5105, pickupAddress: 'Ikorodu Garage, Lagos Rd, Ikorodu',
  destLat: 6.6018, destLng: 3.48, destAddress: 'Caleb University College of Law, Magodo, Lagos',
  distanceKm: 16.9, durationSeconds: 2220, suggestedFareNgn: 6400, minOfferNgn: 5440, ratePerKmNgn: 300,
};

function memoryRedis() {
  const store = new Map();
  return {
    store,
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async set(k, v) { store.set(k, v); },
    async del(k) { store.delete(k); },
    async setIfNotExists(k, v) { if (store.has(k)) return false; store.set(k, v); return true; },
    async send() { return null; },
  };
}

async function makeRider(balanceNgn) {
  const id = randomUUID();
  await prisma.user.create({ data: { id, privyDid: `whatsapp:+23480${Math.floor(1e8 + Math.random() * 9e8)}`, role: 'RIDER', name: 'Timi Rider', phone: '+2348030000001', privacyConsent: 'AGREED' } });
  await prisma.wallet.create({ data: { userId: id, balanceNgn } });
  return id;
}

async function makeDriver({ status = 'ONLINE', seenSecondsAgo = 10 } = {}) {
  const userId = randomUUID();
  await prisma.user.create({ data: { id: userId, privyDid: `local:${userId}`, role: 'DRIVER', name: 'Chinedu Okafor', phone: '+2348031234567' } });
  await prisma.wallet.create({ data: { userId, balanceNgn: 0 } });
  const driver = await prisma.driver.create({
    data: { userId, status, kycStatus: 'APPROVED', lat: 6.62, lng: 3.51, lastSeenAt: new Date(Date.now() - seenSecondsAgo * 1000), vehicleModel: 'Toyota Corolla', vehiclePlate: 'LND-174XA', totalRides: 412 },
  });
  return { userId, driverId: driver.id };
}

function bidFrom(driver, priceNgn, extra = {}) {
  return {
    bidId: randomUUID(), driverId: driver.driverId, driverUserId: driver.userId, counterOfferNgn: priceNgn,
    driverName: 'Chinedu Okafor', driverRating: 4.9, vehiclePlate: 'LND-174XA', vehicleModel: 'Toyota Corolla',
    etaSeconds: 240, distanceKm: 1.2, receivedAt: new Date().toISOString(), ...extra,
  };
}

function world() {
  const redis = memoryRedis();
  const events = [];
  const chat = [];
  const deps = {
    jwtSecret: JWT_SECRET,
    redisClient: redis,
    publisher: { publishRideEvent: async (event) => { events.push(event); } },
    paymentsClient: {},
    notifyChat: async (event) => { chat.push(event); },
  };
  return { redis, events, chat, deps };
}

async function call(deps, userId, method, path, body, token) {
  const bearer = token ?? local.createWalletPageToken(userId, 'ride', JWT_SECRET, local.RIDE_PAGE_TOKEN_TTL_SECONDS);
  const raw = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = { method, headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }, async *[Symbol.asyncIterator]() { for (const c of raw) yield c; } };
  const res = { statusCode: 200, body: null, headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, writeHead(code) { this.statusCode = code; return this; }, end(text) { this.body = text ? JSON.parse(text) : null; } };
  const handled = await handleRidePageRoute(req, res, deps, new URL(`http://x${path}`));
  return { handled, status: res.statusCode, body: res.body, headers: res.headers };
}

test.beforeEach(() => { console.log = console.info = console.warn = console.error = () => {}; });
test.afterEach(() => { Object.assign(console, realConsole); global.fetch = realFetch; });
// Searches this file left open would sit in the admin dispatch queue (the 50 OLDEST unmatched rides)
// for a day and crowd another file's ride out of it. Close them.
const startedAt = new Date();
test.after(async () => {
  await prisma.ride.updateMany({ where: { status: { in: ['REQUESTED', 'MATCHING'] }, createdAt: { gte: startedAt } }, data: { status: 'CANCELLED' } }).catch(() => {});
  await prisma.$disconnect();
});

/* ── the link ─────────────────────────────────────────────────────────── */

test('the link opens the bidding page and nothing else; money links cannot open it', async () => {
  const { deps } = world();
  const rider = await makeRider(0);

  assert.equal((await call(deps, rider, 'GET', '/ride-page/state')).status, 200);
  for (const scope of ['deposit', 'withdraw']) {
    const wrong = local.createWalletPageToken(rider, scope, JWT_SECRET);
    assert.equal((await call(deps, rider, 'GET', '/ride-page/state', undefined, wrong)).status, 403, `${scope} link`);
  }
  assert.equal((await call(deps, rider, 'GET', '/ride-page/state', undefined, local.createLocalAccessToken(rider, JWT_SECRET))).status, 401, 'a login token is not a page link');
  const expired = local.createWalletPageToken(rider, 'ride', JWT_SECRET, -1);
  assert.equal((await call(deps, rider, 'GET', '/ride-page/state', undefined, expired)).status, 401);

  // A ride link lives as long as a search does — not the 15 minutes of a money link.
  const payload = JSON.parse(Buffer.from(local.createWalletPageToken(rider, 'ride', JWT_SECRET, local.RIDE_PAGE_TOKEN_TTL_SECONDS).split('.')[1], 'base64url').toString());
  assert.equal(payload.exp - payload.iat, 2 * 60 * 60);
});

/* ── name your price ──────────────────────────────────────────────────── */

test('with a quote waiting, the page asks for a price — and refuses one under the floor', async () => {
  const { deps, redis, events, chat } = world();
  const rider = await makeRider(1200);
  await bidState.storePendingRoute(redis, rider, QUOTE);

  const state = await call(deps, rider, 'GET', '/ride-page/state');
  assert.equal(state.headers['cache-control'], 'no-store');
  assert.equal(state.body.phase, 'price');
  assert.equal(state.body.minOfferNgn, 5440);
  assert.equal(state.body.balanceNgn, 1200);
  assert.equal(state.body.route.destAddress, QUOTE.destAddress);

  const low = await call(deps, rider, 'POST', '/ride-page/find', { amountNgn: 3000 });
  assert.equal(low.status, 400);
  assert.equal(low.body.code, 'BELOW_MINIMUM');
  assert.equal(events.length, 0, 'nothing went to drivers');
  assert.equal((await call(deps, rider, 'POST', '/ride-page/find', { amountNgn: 'plenty' })).status, 400);

  // A short wallet does NOT stop the search — the wallet is checked at Accept.
  const found = await call(deps, rider, 'POST', '/ride-page/find', { amountNgn: '6,400' });
  assert.equal(found.status, 200);
  assert.equal(found.body.phase, 'offers');
  assert.equal(found.body.offerNgn, 6400);
  assert.deepEqual(found.body.offers, []);
  assert.equal(events.length, 1);
  assert.equal(events[0].eventType, 'RIDE_REQUESTED');
  assert.equal(events[0].riderOfferNgn, 6400);
  assert.equal(events[0].paymentMethod, 'WALLET');
  assert.equal(chat[0].kind, 'search_started', 'the chat gets its one message, with the way back');
  assert.equal(await bidState.getPendingRoute(redis, rider), null, 'the quote is spent');

  // A second tap is the same search, not a second ride.
  const again = await call(deps, rider, 'POST', '/ride-page/find', { amountNgn: 6400 });
  assert.equal(again.body.phase, 'offers');
  assert.equal(events.length, 1);
});

/* ── offers ───────────────────────────────────────────────────────────── */

test('offers appear by themselves, update in place, and disappear when a driver pulls out', async () => {
  const { deps, redis } = world();
  const rider = await makeRider(10_000);
  await bidState.storePendingRoute(redis, rider, QUOTE);
  const { body: searching } = await call(deps, rider, 'POST', '/ride-page/find', { amountNgn: 6400 });
  const rideId = searching.rideId;

  const chinedu = await makeDriver();
  const aisha = await makeDriver();
  const first = bidFrom(chinedu, 6400);
  await bidState.addBid(redis, rideId, first);
  await bidState.addBid(redis, rideId, bidFrom(aisha, 7000, { driverName: 'Aisha Bello', etaSeconds: 95 }));

  let state = (await call(deps, rider, 'GET', '/ride-page/state')).body;
  assert.deepEqual(state.offers.map((o) => [o.driverName, o.priceNgn, o.etaMin]), [['Chinedu Okafor', 6400, 4], ['Aisha Bello', 7000, 2]]);
  assert.deepEqual(state.offers.map((o) => o.topupSendNgn), [null, null], 'a wallet that covers the fare is asked for nothing');
  assert.equal(state.offers[0].key, first.bidId);
  assert.equal(state.offers[0].plate, 'LND-174XA');
  assert.equal(JSON.stringify(state).includes('+234'), false, 'no driver phone before a ride is confirmed');

  // All the PAGE says about them is a count: offers are seen, and taken, in the chat.
  assert.equal(state.offerCount, 2);
  // …and looking at the page must not reorder what "1" means in the chat.
  assert.equal((await bidState.getLastBatch(redis, rideId)).length, 0);

  await bidState.addBid(redis, rideId, { ...first, counterOfferNgn: 6200 });        // same driver, new price
  await bidState.removeBid(redis, rideId, aisha.driverId);
  state = (await call(deps, rider, 'GET', '/ride-page/state')).body;
  assert.deepEqual(state.offers.map((o) => [o.driverName, o.priceNgn]), [['Chinedu Okafor', 6200]]);
});

test('changing the bid reaches every driver, and the floor still holds', async () => {
  const { deps, redis, events } = world();
  const rider = await makeRider(10_000);
  await bidState.storePendingRoute(redis, rider, QUOTE);
  await call(deps, rider, 'POST', '/ride-page/find', { amountNgn: 6400 });

  const raised = await call(deps, rider, 'POST', '/ride-page/offer', { amountNgn: 7000 });
  assert.equal(raised.body.offerNgn, 7000);
  assert.equal(events.at(-1).eventType, 'RIDE_RIDER_COUNTER_OFFER');
  assert.equal(events.at(-1).counterOfferNgn, 7000);

  const before = events.length;
  const tooLow = await call(deps, rider, 'POST', '/ride-page/offer', { amountNgn: 1000 });
  assert.equal(tooLow.status, 400);
  assert.equal(tooLow.body.code, 'BELOW_MINIMUM');
  assert.equal(events.length, before, 'drivers never saw it');
});

/* ── accept ───────────────────────────────────────────────────────────── */

test('accept with a short wallet: no hold, no ride — one figure to send, and no fee breakdown', async () => {
  const { deps, redis, events } = world();
  const rider = await makeRider(1200);
  await prisma.virtualAccount.create({ data: { userId: rider, provider: 'paystack', providerAccountId: `va_${randomUUID()}`, bankName: 'Wema Bank', accountNumber: '9912345678', accountName: 'WHEELERS / TIMI', status: 'active' } }).catch(() => null);
  await bidState.storePendingRoute(redis, rider, QUOTE);
  const { body } = await call(deps, rider, 'POST', '/ride-page/find', { amountNgn: 6400 });
  const bid = bidFrom(await makeDriver(), 6400);
  await bidState.addBid(redis, body.rideId, bid);

  // Before they even tap: the offer already says what they would have to SEND for it
  // (13,000 short once showed as "Add ₦13,000" — not the amount that gets them the ride).
  const listed = (await call(deps, rider, 'GET', '/ride-page/state')).body.offers[0];
  assert.equal(listed.topupSendNgn, 5283, '(6400 − 1200 + 30) / 0.99, in whole naira');

  const short = await call(deps, rider, 'POST', '/ride-page/accept', { key: bid.bidId });
  assert.equal(short.status, 402);
  assert.equal(short.body.code, 'WALLET_SHORT');
  assert.equal(short.body.shortNgn, 5200);
  assert.equal(short.body.sendNgn, 5283, '(5200 + 30) / 0.99, in whole naira');
  assert.equal(/fee|charge/i.test(JSON.stringify(short.body).replace(/"error":"[^"]*"/, '')), false);
  assert.equal(events.filter((e) => e.eventType === 'RIDE_OFFER_ACCEPTED').length, 0);
  assert.equal(await prisma.rideHold.count({ where: { rideId: body.rideId } }), 0, 'no money moved');
  assert.equal((await call(deps, rider, 'GET', '/ride-page/state')).body.phase, 'offers', 'their offers are still there');

  const quote = await call(deps, rider, 'GET', '/ride-page/topup?amount=5200');
  assert.deepEqual([quote.body.walletGetsNgn, quote.body.sendNgn], [5200, 5283]);
});

test('accept: the fare is held BEFORE the ride is confirmed, the chat is told, the driver\'s details appear', async () => {
  const { deps, redis, events, chat } = world();
  const rider = await makeRider(10_000);
  await bidState.storePendingRoute(redis, rider, QUOTE);
  const { body } = await call(deps, rider, 'POST', '/ride-page/find', { amountNgn: 6400 });
  const rideId = body.rideId;
  // ride-service would have written the ride row from RIDE_REQUESTED.
  await prisma.ride.create({ data: { id: rideId, riderId: rider, status: 'MATCHING', pickupLat: QUOTE.pickupLat, pickupLng: QUOTE.pickupLng, pickupAddress: QUOTE.pickupAddress, destLat: QUOTE.destLat, destLng: QUOTE.destLng, destAddress: QUOTE.destAddress } });
  const driver = await makeDriver();
  const bid = bidFrom(driver, 6200);
  await bidState.addBid(redis, rideId, bid);

  let heldWhenPublished = null;
  deps.publisher.publishRideEvent = async (event) => {
    if (event.eventType === 'RIDE_OFFER_ACCEPTED') heldWhenPublished = await prisma.rideHold.count({ where: { rideId } });
    events.push(event);
  };

  const accepted = await call(deps, rider, 'POST', '/ride-page/accept', { key: bid.bidId });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.equal(heldWhenPublished, 1, 'a ride is never confirmed on money that is not held');
  assert.equal(accepted.body.phase, 'confirmed');
  assert.deepEqual(
    [accepted.body.driver.name, accepted.body.driver.plate, accepted.body.driver.fareNgn, accepted.body.driver.phone, accepted.body.driver.totalRides],
    ['Chinedu Okafor', 'LND-174XA', 6200, '+2348031234567', 412],
  );

  const event = events.find((e) => e.eventType === 'RIDE_OFFER_ACCEPTED');
  assert.deepEqual([event.bidId, event.driverId, event.agreedFareNgn, event.paymentMethod], [bid.bidId, driver.driverId, 6200, 'WALLET']);
  const wallet = await prisma.wallet.findUnique({ where: { userId: rider } });
  assert.equal(Number(wallet.lockedNgn), 6200);
  assert.equal(chat.at(-1).kind, 'ride_confirmed');
  assert.equal(chat.at(-1).ride.driverName, 'Chinedu Okafor');

  // Tapping again changes nothing.
  const twice = await call(deps, rider, 'POST', '/ride-page/accept', { key: bid.bidId });
  assert.equal(twice.status, 200);
  assert.equal(twice.body.phase, 'confirmed', 'not "add money" for a ride they already have');
  assert.equal(Number((await prisma.wallet.findUnique({ where: { userId: rider } })).lockedNgn), 6200, 'held once');
  assert.equal(events.filter((e) => e.eventType === 'RIDE_OFFER_ACCEPTED').length, 1);
});

test('a driver who went quiet, went offline, or is being taken by someone else cannot be accepted — and no money moves', async () => {
  const { deps, redis } = world();
  const rider = await makeRider(10_000);
  await bidState.storePendingRoute(redis, rider, QUOTE);
  const { body } = await call(deps, rider, 'POST', '/ride-page/find', { amountNgn: 6400 });

  const quiet = bidFrom(await makeDriver({ seenSecondsAgo: 600 }), 6400);
  const offline = bidFrom(await makeDriver({ status: 'OFFLINE' }), 6400);
  const contested = await makeDriver();
  const taken = bidFrom(contested, 6400);
  for (const bid of [quiet, offline, taken]) await bidState.addBid(redis, body.rideId, bid);
  await redis.set(`whatsapp:driver:${contested.driverId}:accepting`, 'another-riders-ride');

  for (const [bid, code] of [[quiet, 'DRIVER_UNAVAILABLE'], [offline, 'DRIVER_UNAVAILABLE'], [taken, 'DRIVER_TAKEN']]) {
    const result = await call(deps, rider, 'POST', '/ride-page/accept', { key: bid.bidId });
    assert.equal(result.status, 409);
    assert.equal(result.body.code, code);
  }
  assert.equal((await call(deps, rider, 'POST', '/ride-page/accept', { key: 'not-an-offer' })).body.code, 'OFFER_GONE');
  assert.equal(Number((await prisma.wallet.findUnique({ where: { userId: rider } })).lockedNgn), 0);
});

test('one rider cannot touch another rider\'s search', async () => {
  const { deps, redis } = world();
  const owner = await makeRider(10_000);
  const stranger = await makeRider(10_000);
  await bidState.storePendingRoute(redis, owner, QUOTE);
  const { body } = await call(deps, owner, 'POST', '/ride-page/find', { amountNgn: 6400 });
  const bid = bidFrom(await makeDriver(), 6400);
  await bidState.addBid(redis, body.rideId, bid);

  assert.equal((await call(deps, stranger, 'GET', '/ride-page/state')).body.phase, 'idle');
  assert.equal((await call(deps, stranger, 'POST', '/ride-page/accept', { key: bid.bidId })).status, 409);
  assert.equal((await call(deps, stranger, 'POST', '/ride-page/offer', { amountNgn: 9000 })).status, 409);
});

/* ── track live trip ──────────────────────────────────────────────────── */

async function assignedRide(riderId, driver, status) {
  return prisma.ride.create({ data: {
    riderId, driverId: driver.driverId, status, agreedFareNgn: 6200,
    pickupLat: QUOTE.pickupLat, pickupLng: QUOTE.pickupLng, pickupAddress: QUOTE.pickupAddress,
    destLat: QUOTE.destLat, destLng: QUOTE.destLng, destAddress: QUOTE.destAddress, distanceKm: 16.9, durationSeconds: 2220,
  } });
}

test('once a driver is assigned the page tracks the trip — from the database, so it outlives the chat\'s 15-minute keys', async () => {
  const { deps } = world();          // an EMPTY Redis: nothing of this ride is left in the chat's state
  const rider = await makeRider(3800);
  const driver = await makeDriver({ seenSecondsAgo: 12 });
  const ride = await assignedRide(rider, driver, 'DRIVER_EN_ROUTE');

  const state = (await call(deps, rider, 'GET', '/ride-page/state')).body;
  assert.equal(state.phase, 'confirmed');
  assert.equal(state.trip.status, 'DRIVER_EN_ROUTE');
  assert.deepEqual(state.trip.driverPosition, { lat: 6.62, lng: 3.51 });
  assert.equal(state.trip.positionFresh, true);
  assert.deepEqual(state.trip.pickup, { lat: QUOTE.pickupLat, lng: QUOTE.pickupLng });
  assert.ok(state.trip.etaMin >= 1, 'minutes to the PICKUP before the trip starts');
  assert.match(state.trip.map.tileUrl, /\{z\}\/\{x\}\/\{y\}/);
  assert.deepEqual([state.driver.name, state.driver.plate, state.driver.phone, state.driver.fareNgn], ['Chinedu Okafor', 'LND-174XA', '+2348031234567', 6200]);

  // Arrived: no countdown. In progress: the countdown is to the DESTINATION.
  await prisma.ride.update({ where: { id: ride.id }, data: { status: 'ARRIVED' } });
  assert.equal((await call(deps, rider, 'GET', '/ride-page/state')).body.trip.etaMin, null);
  await prisma.ride.update({ where: { id: ride.id }, data: { status: 'IN_PROGRESS' } });
  await prisma.driver.update({ where: { id: driver.driverId }, data: { lat: QUOTE.destLat + 0.02, lng: QUOTE.destLng, lastSeenAt: new Date(Date.now() - 5 * 60_000) } });
  const inTrip = (await call(deps, rider, 'GET', '/ride-page/state')).body.trip;
  assert.ok(inTrip.etaMin >= 1 && inTrip.etaMin <= 15, 'about 2 km from the destination');
  assert.equal(inTrip.positionFresh, false, 'a five-minute-old fix is shown, but labelled old');
  assert.ok(inTrip.positionAgeSeconds >= 290);

  // The trip ends → the driver's position is nobody's business any more.
  await prisma.ride.update({ where: { id: ride.id }, data: { status: 'COMPLETED' } });
  const after = (await call(deps, rider, 'GET', '/ride-page/state')).body;
  assert.equal(after.phase, 'idle');
  assert.equal(JSON.stringify(after).includes('6.6'), false);
});

test('a driver\'s position is shown to THEIR rider only', async () => {
  const { deps } = world();
  const rider = await makeRider(0);
  const stranger = await makeRider(0);
  await assignedRide(rider, await makeDriver(), 'IN_PROGRESS');

  const theirs = (await call(deps, stranger, 'GET', '/ride-page/state')).body;
  assert.equal(theirs.phase, 'idle');
  assert.equal(theirs.trip, undefined);
});

/* ── cancel ───────────────────────────────────────────────────────────── */

test('cancel stops the search; once a driver is confirmed the page sends them to the chat instead', async () => {
  const { deps, redis, events, chat } = world();
  const rider = await makeRider(10_000);
  await bidState.storePendingRoute(redis, rider, QUOTE);
  const { body } = await call(deps, rider, 'POST', '/ride-page/find', { amountNgn: 6400 });

  const cancelled = await call(deps, rider, 'POST', '/ride-page/cancel');
  assert.equal(cancelled.body.phase, 'idle');
  assert.equal(events.at(-1).eventType, 'RIDE_CANCELLED');
  assert.equal(events.at(-1).rideId, body.rideId);
  assert.equal(chat.at(-1).kind, 'search_cancelled');

  // Cancel, then search again straight away: must not be blocked by the first search's guard.
  await bidState.storePendingRoute(redis, rider, QUOTE);
  const second = (await call(deps, rider, 'POST', '/ride-page/find', { amountNgn: 6400 })).body;
  assert.equal(second.phase, 'offers');
  assert.notEqual(second.rideId, body.rideId, 'a new search, not the old one');
  await bidState.setRideState(redis, second.rideId, 'confirmed');
  const refused = await call(deps, rider, 'POST', '/ride-page/cancel');
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'ALREADY_CONFIRMED');
});

/* ── the chat stays quiet while the page is open ──────────────────────── */

test('every request from the page says "still here"; silence means they left', async () => {
  const { deps, redis } = world();
  const rider = await makeRider(0);
  assert.equal(await bidState.isRidePageOpen(redis, rider), false);
  await call(deps, rider, 'GET', '/ride-page/state');
  assert.equal(await bidState.isRidePageOpen(redis, rider), true);
  await redis.del(`whatsapp:user:${rider}:ride_page_seen`);   // what the 25-second expiry does
  assert.equal(await bidState.isRidePageOpen(redis, rider), false);
});

/* ── offers go to the CHAT, as things to tap ──────────────────────────── */

test('one offer is an "Accept ₦X" button; several are a "Choose a driver" list — and nowhere does it say "reply with a number"', async () => {
  const sent = [];
  global.fetch = async (_url, init) => { sent.push(JSON.parse(init.body)); return { ok: true, status: 200, text: async () => '' }; };
  const meta = { metaAccessToken: 't', metaPhoneNumberId: '1' };
  const driver = { driverId: 'd', userId: 'u' };
  const chinedu = bidFrom(driver, 6400);
  const bids = [chinedu, bidFrom(driver, 6100, { driverName: 'Aisha Bello', etaSeconds: 95 }), bidFrom(driver, 6800, { driverName: 'Babatunde Olanrewaju-Adeyemi' })];

  // one offer
  assert.equal(await notifier.sendOffersInChat(meta, '+2348030000001', [chinedu], 6000), 'buttons');
  const single = sent[0].interactive;
  assert.equal(single.type, 'button');
  assert.deepEqual(single.action.buttons.map((b) => b.reply.title), ['Accept ₦6,400', 'Change my price', 'Cancel search']);
  assert.match(single.body.text, /\*Chinedu Okafor\* offers \*₦6,400\*[\s\S]*Toyota Corolla · LND-174XA · 4\.9★ · 4 min away[\s\S]*Your price: ₦6,000/);
  // The id carries the price they SAW, so an old message can never hold a newer fare.
  assert.deepEqual(notifier.parseOfferReplyId(single.action.buttons[0].reply.id), { shownPriceNgn: 6400, key: chinedu.bidId });

  // several: cheapest first, everything visible without opening the list
  assert.equal(await notifier.sendOffersInChat(meta, '+2348030000001', bids, 6000, ['Aisha Bello joined at ₦6,100']), 'buttons');
  const list = sent[1].interactive;
  assert.equal(list.type, 'list');
  assert.equal(list.action.button, 'Choose a driver');
  const rows = list.action.sections[0].rows;
  assert.deepEqual(rows.map((r) => r.title), ['₦6,100 · Aisha', '₦6,400 · Chinedu', '₦6,800 · Babatunde']);
  assert.ok(rows.every((r) => r.title.length <= 24 && r.description.length <= 72), "WhatsApp's row limits");
  assert.deepEqual(list.action.sections[1].rows.map((r) => r.title), ['Change my price', 'Cancel search']);
  assert.match(list.body.text, /^🔔 Aisha Bello joined at ₦6,100\n\n🚗 \*3 drivers have made offers\*/);
  assert.match(list.body.text, /\*₦6,100\* — Aisha Bello[\s\S]*\*₦6,400\* — Chinedu Okafor/);
  for (const message of [single, list]) assert.doesNotMatch(message.body.text, /reply with|reply \*?\d/i);

  // more offers than WhatsApp has rows for: the cheapest eight, and it says so
  const many = Array.from({ length: 11 }, (_, i) => bidFrom(driver, 7000 + i * 100, { driverName: `Driver ${i}` }));
  await notifier.sendOffersInChat(meta, '+234', many, 6000);
  assert.equal(sent[2].interactive.action.sections[0].rows.length, 8);
  assert.match(sent[2].interactive.body.text, /and 3 more at higher prices/);

  // Meta refuses → false, so the caller falls back to the numbered text list.
  global.fetch = async () => ({ ok: false, status: 400, text: async () => 'no' });
  assert.equal(await notifier.sendOffersInChat(meta, '+234', bids, 6000), false);
  assert.equal(await notifier.sendOffersInChat(meta, '+234', [], 6000), false);
});

test('the first offer and a cheaper-than-shown offer interrupt at once; the rest are bundled', () => {
  const { isUrgentOffer } = require('../apps/api-gateway/dist/kafka/consumer.js');
  const shown = [{ counterOfferNgn: 6400 }, { counterOfferNgn: 7000 }];
  assert.equal(isUrgentOffer([], { counterOfferNgn: 9000 }), true, 'the first offer of a search');
  assert.equal(isUrgentOffer(shown, { counterOfferNgn: 6000 }), true, 'cheaper than anything they have seen');
  assert.equal(isUrgentOffer(shown, { counterOfferNgn: 6400 }), false, 'matching the best is not news');
  assert.equal(isUrgentOffer(shown, { counterOfferNgn: 8000 }), false);
});
