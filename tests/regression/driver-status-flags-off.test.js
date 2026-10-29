// Regression (plan 2026-10-28, Phase 1): with DRIVER_STATUS_PUSHES_ENABLED and DRIVER_PAYING_STATUS_ENABLED
// off, every driver-facing consumer event gives the same socket messages and pushes as main.
//
// golden/driver-status-flags-off.json was captured from the code at HEAD (before the change).
//   check:   node scripts/run-with-env.cjs node --test --test-force-exit tests/regression/driver-status-flags-off.test.js
//   capture: REGRESSION_CAPTURE=1 REGRESSION_ROOT=<a checkout of main, built> ...same command
//
// Known, intended differences (flag-independent bug fixes) are listed in INTENDED and asserted on their own.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = process.env.REGRESSION_ROOT || path.resolve(__dirname, '../..');
const GOLDEN = path.resolve(__dirname, 'golden/driver-status-flags-off.json');
const { handleRideEvent } = require(path.join(ROOT, 'apps/api-gateway/dist/kafka/consumer.js'));

const realConsole = { ...console };
test.beforeEach(() => { console.log = console.info = console.warn = console.error = () => {}; });
test.afterEach(() => { Object.assign(console, realConsole); });

function memoryRedis() {
  const store = new Map();
  return {
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async set(k, v) { store.set(k, v); },
    async del(k) { store.delete(k); },
    async setIfNotExists(k, v) { if (store.has(k)) return false; store.set(k, v); return true; },
    async send() { return null; },
    async incr() { return 1; }, async expire() { return 1; },
  };
}
function world(connected) {
  const log = [];
  return {
    log,
    deps: {
      registry: {
        sendToUser: async (u, type, payload) => { log.push({ socket: type, payload }); },
        isUserConnected: async () => connected,
        hasUser: () => connected,
      },
      redisClient: memoryRedis(),
      publisher: {
        publishRideEvent: async (e) => { log.push({ rideEvent: e.eventType }); },
        publishDriverEvent: async () => {}, publishWalletEvent: async () => {},
        publishNotificationEvent: async (e) => {
          if (e.eventType === 'PUSH_SEND') log.push({ push: { title: e.title, body: e.body, data: strip(e.data), priority: e.priority } });
        },
      },
    },
  };
}
const strip = (d) => (d ? JSON.parse(JSON.stringify(d)) : d);
const U = (n) => `00000000-0000-4000-8000-00000000000${n}`;
const T = '2026-10-29T10:00:00.000Z';
const RIDE = U(1), RIDER = U(2), DRIVER = U(3), DRIVER_ID = U(4);
const future = () => new Date(Date.now() + 60000).toISOString();
const EVENTS = {
  rider_paying: { eventType: 'RIDE_RIDER_PAYING', rideId: RIDE, riderId: RIDER, driverUserId: DRIVER, timestamp: T },
  bids_declined: { eventType: 'RIDE_BIDS_DECLINED', rideId: RIDE, riderId: RIDER, driverUserIds: [DRIVER], remainingOffers: 0, timestamp: T },
  assignment_failed_busy: { eventType: 'RIDE_ASSIGNMENT_FAILED', rideId: RIDE, riderId: RIDER, driverId: DRIVER_ID, driverUserId: DRIVER, reason: 'driver_busy', timestamp: T },
  assignment_failed_closed: { eventType: 'RIDE_ASSIGNMENT_FAILED', rideId: RIDE, riderId: RIDER, driverId: DRIVER_ID, driverUserId: DRIVER, reason: 'ride_closed', timestamp: T },
  cancelled_by_rider: { eventType: 'RIDE_CANCELLED', rideId: RIDE, riderId: RIDER, driverId: DRIVER_ID, driverUserId: DRIVER, cancelledBy: 'rider', timestamp: T },
  cancelled_by_driver: { eventType: 'RIDE_CANCELLED', rideId: RIDE, riderId: RIDER, driverId: DRIVER_ID, driverUserId: DRIVER, cancelledBy: 'driver', timestamp: T },
  bid_timeout: { eventType: 'RIDE_BID_TIMEOUT', rideId: RIDE, riderId: RIDER, timestamp: T },
  offer_sent_repriced: () => ({
    eventType: 'RIDE_OFFER_SENT', rideId: RIDE, riderId: RIDER, driverId: DRIVER_ID, driverUserId: DRIVER,
    pickup: { lat: 6.5, lng: 3.3, address: 'Akoka' }, destination: { lat: 6.51, lng: 3.37, address: 'Yaba' }, stops: [],
    fareEstimateNgn: 3000, riderOfferNgn: 3500, suggestedFareNgn: 3000, paymentMethod: 'WALLET', repriced: true,
    expiresAt: future(), bidsCloseAt: future(), timestamp: T,
  }),
};

async function snapshot() {
  const out = {};
  for (const [name, ev] of Object.entries(EVENTS)) {
    for (const connected of [true, false]) {
      const w = world(connected);
      let error = null;
      try { await handleRideEvent(typeof ev === 'function' ? ev() : ev, w.deps, new Map()); } catch (e) { error = String(e.message).slice(0, 80); }
      // order-insensitive: some sends are fire-and-forget
      out[`${name} | driver ${connected ? 'connected' : 'away'}`] = { error, log: w.log.map((l) => JSON.stringify(l).replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, '<time>')).sort() };
    }
  }
  return out;
}

if (process.env.REGRESSION_CAPTURE) {
  test('capture golden', async () => { fs.writeFileSync(GOLDEN, JSON.stringify(await snapshot(), null, 2) + '\n'); });
} else {
  test('flags off: driver-facing events give main\'s socket messages and pushes', async () => {
    const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
    const now = await snapshot();
    assert.deepEqual(Object.keys(now).sort(), Object.keys(golden).sort());
    for (const key of Object.keys(golden)) assert.deepEqual(now[key], golden[key], key);
  });
}
