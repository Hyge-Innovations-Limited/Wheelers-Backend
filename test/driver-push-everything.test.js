// Drivers get a push for every piece of ride news, app open or not (the app
// hides it while on screen): offer accepted, rider didn't pay, trip changed,
// trip done, money in, rider paid.
//
//   npm run build && node scripts/run-with-env.cjs node --test --test-force-exit test/driver-push-everything.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const { handleRideEvent, handleWalletEvent } = require('../apps/api-gateway/dist/kafka/consumer.js');
const bidState = require('../apps/api-gateway/dist/whatsapp-flows/bid-state.js');

const prisma = new PrismaClient();
const made = { users: [], rides: [], drivers: [] };
const realConsole = { ...console };
test.beforeEach(() => { console.log = console.info = console.warn = () => {}; });
test.afterEach(() => { Object.assign(console, realConsole); });
test.after(async () => {
  await prisma.ride.deleteMany({ where: { id: { in: made.rides } } });
  await prisma.driver.deleteMany({ where: { id: { in: made.drivers } } });
  await prisma.wallet.deleteMany({ where: { userId: { in: made.users } } });
  await prisma.user.deleteMany({ where: { id: { in: made.users } } });
  await prisma.$disconnect();
});

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
function world() {
  const pushes = [];
  return {
    pushes,
    deps: {
      // Connected and on screen: the push still goes; the app decides whether to show it.
      registry: { sendToUser: async () => {}, isUserConnected: async () => true, hasUser: () => true },
      redisClient: memoryRedis(),
      publisher: {
        publishRideEvent: async () => {}, publishDriverEvent: async () => {}, publishWalletEvent: async () => {},
        publishNotificationEvent: async (e) => { if (e.eventType === 'PUSH_SEND') pushes.push(e); },
      },
    },
  };
}
const now = () => new Date().toISOString();
const DRIVER = '00000000-0000-4000-8000-0000000000e1';
const RIDER = '00000000-0000-4000-8000-0000000000e2';
const pushed = (w) => w.pushes.map((p) => [p.userId, p.title, p.body, p.data.type]);

async function user(role) {
  const id = randomUUID();
  await prisma.user.create({ data: { id, privyDid: `test:push-everything:${id}`, role, name: `Ada ${role}`, phone: `+23480${Math.floor(10000000 + Math.random() * 89999999)}` } });
  made.users.push(id);
  return id;
}
async function driver() {
  const userId = await user('DRIVER');
  const d = await prisma.driver.create({ data: { userId, kycStatus: 'APPROVED', status: 'ONLINE', vehicleModel: 'Corolla', vehiclePlate: 'KJA1' } });
  made.drivers.push(d.id);
  return { id: d.id, userId };
}

test('offer accepted: "Offer accepted · ₦X", once', async () => {
  const w = world();
  const ev = { eventType: 'RIDE_OFFER_ACCEPTED', rideId: randomUUID(), riderId: RIDER, driverUserId: DRIVER, agreedFareNgn: 4500, paymentMethod: 'WALLET', timestamp: now() };
  await handleRideEvent(ev, w.deps, new Map());
  await handleRideEvent(ev, w.deps, new Map());
  assert.deepEqual(pushed(w), [[DRIVER, 'Offer accepted', '₦4,500', 'ride:offer_accepted']]);
});

test('the rider stopped paying with the request still open: "Rider didn\'t pay", once per ride however often the sheet closes', async () => {
  const w = world();
  const rideId = randomUUID();
  for (const reason of ['closed', 'switched', 'failed', 'closed']) {
    await handleRideEvent({ eventType: 'RIDE_RIDER_PAYING_ENDED', rideId, riderId: RIDER, driverUserId: DRIVER, reason, timestamp: now() }, w.deps, new Map());
  }
  assert.deepEqual(pushed(w), [[DRIVER, "Rider didn't pay", 'Request still open', 'ride:rider_paying_ended']]);
});

test('paying ended because the request is over: no "Rider didn\'t pay" (its own banner says why)', async () => {
  for (const reason of ['declined', 'other_chosen', 'cancelled', 'search_ended']) {
    const w = world();
    await handleRideEvent({ eventType: 'RIDE_RIDER_PAYING_ENDED', rideId: randomUUID(), riderId: RIDER, driverUserId: DRIVER, reason, timestamp: now() }, w.deps, new Map());
    assert.deepEqual(pushed(w), [], reason);
  }
});

test('the rider changes the trip: "Trip changed · To <place> · ₦X"; the driver\'s own change, a stop reached, or a change not made: nothing', async () => {
  const route = (updatedBy, extra = {}) => ({
    eventType: 'RIDE_ROUTE_UPDATED', rideId: 'ride-route', riderId: RIDER, updatedBy,
    destination: { lat: 6.45, lng: 3.43, address: 'Lekki Phase 1' }, stops: [], plannedDistanceKm: 12, plannedDurationSeconds: 1800, timestamp: now(), ...extra,
  });
  const participants = () => new Map([['ride-route', { riderId: RIDER, driverUserId: DRIVER }]]);
  const w = world();
  await handleRideEvent(route('rider', { agreedFareNgn: 6200 }), w.deps, participants());
  assert.deepEqual(pushed(w), [[DRIVER, 'Trip changed', 'To Lekki Phase 1 · ₦6,200', 'ride:route:updated']]);
  for (const ev of [route('driver'), route('system'), route('rider', { reverted: true })]) {
    const quiet = world();
    await handleRideEvent(ev, quiet.deps, participants());
    assert.deepEqual(pushed(quiet), [], `${ev.updatedBy}${ev.reverted ? ' reverted' : ''}`);
  }
});

test('trip done: "Trip done · You earned ₦X" to the driver, once', async () => {
  const riderId = await user('RIDER');
  const d = await driver();
  const ride = await prisma.ride.create({ data: { riderId, driverId: d.id, status: 'COMPLETED', pickupLat: 6.52, pickupLng: 3.38, pickupAddress: 'Akoka', destLat: 6.5, destLng: 3.37, destAddress: 'Yaba', riderOfferNgn: 3000, fareEstimateNgn: 3000 } });
  made.rides.push(ride.id);
  const w = world();
  const done = { eventType: 'RIDE_COMPLETED', rideId: ride.id, riderId, driverId: d.id, driverUserId: d.userId, fareNgn: 3000, distanceKm: 3, durationSeconds: 900, paymentMethod: 'WALLET', completedAt: now(), timestamp: now() };
  await handleRideEvent(done, w.deps, new Map());
  await handleRideEvent(done, w.deps, new Map());
  const mine = w.pushes.filter((p) => p.userId === d.userId);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].title, 'Trip done');
  assert.match(mine[0].body, /^You earned ₦[\d,]+$/);
  assert.equal(mine[0].data.type, 'ride:completed');
});

test('money into a driver\'s wallet: "₦X in your wallet", once per credit; a rider\'s credit sends no driver push', async () => {
  const d = await driver();
  const w = world();
  const credit = (userId, referenceId) => ({ eventType: 'WALLET_CREDITED', userId, walletId: randomUUID(), amountNgn: 2500, newBalanceNgn: 7300, creditType: 'driver_payout', referenceId, timestamp: now() });
  const ref = `ref-${randomUUID()}`;
  await handleWalletEvent(credit(d.userId, ref), w.deps, new Map());
  await handleWalletEvent(credit(d.userId, ref), w.deps, new Map());
  assert.deepEqual(pushed(w), [[d.userId, '₦2,500 in your wallet', 'Balance ₦7,300', 'wallet:updated']]);
  await handleWalletEvent(credit(d.userId, `ref-${randomUUID()}`), w.deps, new Map());
  assert.equal(w.pushes.length, 2, 'a new credit is new news');

  const riderOnly = world();
  await handleWalletEvent(credit(await user('RIDER'), `ref-${randomUUID()}`), riderOnly.deps, new Map());
  assert.deepEqual(pushed(riderOnly), []);
});

test('the WhatsApp rider\'s deposit covers the fare: the driver gets "Rider paid · ₦X", once', async () => {
  const w = world();
  w.deps.whatsappNotifier = { metaAccessToken: 't', metaPhoneNumberId: '1' };
  w.deps.registry.isUserConnected = async () => true;
  const rideId = randomUUID();
  await bidState.storeWhatsappRide(w.deps.redisClient, rideId, { riderId: RIDER, phone: '+2348030000000', pickupAddress: 'Akoka', destinationAddress: 'Yaba', offerNgn: 3000, suggestedFareNgn: 3000, paymentMethod: 'WALLET', createdAt: now() });
  await bidState.setActiveRide(w.deps.redisClient, RIDER, rideId);
  const participants = new Map([[rideId, { riderId: RIDER, driverUserId: DRIVER }]]);
  const credit = { eventType: 'WALLET_CREDITED', userId: RIDER, walletId: randomUUID(), amountNgn: 3000, newBalanceNgn: 3200, creditType: 'refund', referenceId: `ref-${randomUUID()}`, timestamp: now() };
  await handleWalletEvent(credit, w.deps, participants);
  await handleWalletEvent({ ...credit, referenceId: `ref-${randomUUID()}` }, w.deps, participants);
  assert.deepEqual(pushed(w).filter((p) => p[0] === DRIVER), [[DRIVER, 'Rider paid', '₦3,000', 'ride:rider_paid']]);
});
