// Driver status pushes (plan 2026-10-28, S1): replay Kafka events through handleRideEvent and the ws handler.
//
//   npm run build && node --test --test-force-exit test/driver-status-pushes.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { handleRideEvent } = require('../apps/api-gateway/dist/kafka/consumer.js');
const { handleAppStateMessage, appBackgroundKey, APP_BACKGROUND_TTL_SECONDS } = require('../apps/api-gateway/dist/websocket/app-state.js');
const { sendPush } = require('../apps/notification-worker/dist/expo-push.js');

const realConsole = { ...console };
test.beforeEach(() => { console.log = console.info = console.warn = console.error = () => {}; });
test.afterEach(() => { Object.assign(console, realConsole); });

function memoryRedis({ failGet = false } = {}) {
  const store = new Map();
  const ttls = new Map();
  return {
    store, ttls,
    async get(k) { if (failGet && k.startsWith('presence:')) throw new Error('redis down'); return store.has(k) ? store.get(k) : null; },
    async set(k, v, ttl) { store.set(k, v); ttls.set(k, ttl); },
    async del(k) { store.delete(k); },
    async setIfNotExists(k, v, ttl) { if (store.has(k)) return false; store.set(k, v); ttls.set(k, ttl); return true; },
    async send() { return null; },
  };
}
function world({ isUserConnected, flag, redis = memoryRedis() }) {
  const toApp = []; const pushes = [];
  return {
    toApp, pushes, redis,
    deps: {
      driverStatusPushes: flag,
      registry: {
        sendToUser: async (userId, type, payload) => { toApp.push({ userId, type, payload }); },
        isUserConnected, hasUser: () => true,
      },
      redisClient: redis,
      publisher: {
        publishRideEvent: async () => {}, publishDriverEvent: async () => {}, publishWalletEvent: async () => {},
        publishNotificationEvent: async (e) => { if (e.eventType === 'PUSH_SEND') pushes.push(e); },
      },
    },
  };
}
const now = () => new Date().toISOString();
const DRIVER = '00000000-0000-4000-8000-0000000000d1';
const paying = (rideId = 'ride-1', timestamp = '2026-10-29T10:00:00.000Z') => ({ eventType: 'RIDE_RIDER_PAYING', rideId, riderId: 'rider-1', driverUserId: DRIVER, timestamp });
const declined = (rideId = 'ride-d', timestamp = '2026-10-29T10:00:00.000Z') => ({ eventType: 'RIDE_BIDS_DECLINED', rideId, riderId: 'rider-1', driverUserIds: [DRIVER], remainingOffers: 0, timestamp });
const repriced = (rideId) => ({
  eventType: 'RIDE_OFFER_SENT', rideId, riderId: 'rider-2', driverId: 'drv-2', driverUserId: DRIVER,
  pickup: { lat: 6.5, lng: 3.3, address: 'Akoka' }, destination: { lat: 6.51, lng: 3.37, address: 'Yaba' }, stops: [],
  fareEstimateNgn: 3000, riderOfferNgn: 3500, suggestedFareNgn: 3000, paymentMethod: 'WALLET', repriced: true,
  expiresAt: new Date(Date.now() + 60000).toISOString(), bidsCloseAt: new Date(Date.now() + 60000).toISOString(), timestamp: now(),
});
const run = (w, ev) => handleRideEvent(ev, w.deps, new Map());
const mine = (w) => w.pushes.filter((p) => p.userId === DRIVER);

test('paying, flag on, no socket: one push, and a redelivered event is still one', async () => {
  const w = world({ isUserConnected: async () => false, flag: true });
  await run(w, paying()); await run(w, paying());
  assert.equal(w.toApp.filter((m) => m.type === 'ride:rider_paying').length, 2, 'socket message unchanged');
  assert.equal(mine(w).length, 1);
  assert.equal(mine(w)[0].data.type, 'ride:rider_paying');
  assert.equal(mine(w)[0].title, 'Rider accepted');
});

test('paying, flag on, socket open and app active: no push', async () => {
  const w = world({ isUserConnected: async () => true, flag: true });
  await run(w, paying());
  assert.equal(mine(w).length, 0);
});

test('paying, flag on, socket open but app reported background: push', async () => {
  const w = world({ isUserConnected: async () => true, flag: true });
  w.redis.store.set(appBackgroundKey(DRIVER), '1');
  await run(w, paying());
  assert.equal(mine(w).length, 1);
});

test('flag off: paying sends no push even with no socket (today)', async () => {
  const w = world({ isUserConnected: async () => false, flag: false });
  await run(w, paying());
  assert.equal(mine(w).length, 0);
});

test('flag off: the background flag is ignored (old behaviour for a repriced request)', async () => {
  const w = world({ isUserConnected: async () => true, flag: false });
  w.redis.store.set(appBackgroundKey(DRIVER), '1');
  await run(w, repriced('ride-bg'));
  assert.equal(mine(w).length, 0);
});

test('flag on: a repriced request reaches a backgrounded driver, not an active one', async () => {
  const bg = world({ isUserConnected: async () => true, flag: true });
  bg.redis.store.set(appBackgroundKey(DRIVER), '1');
  await run(bg, repriced('ride-r1'));
  assert.equal(mine(bg).length, 1);
  const active = world({ isUserConnected: async () => true, flag: true });
  await run(active, repriced('ride-r2'));
  assert.equal(mine(active).length, 0);
});

test('bug fix, flag off: a presence check that throws sends the push', async () => {
  const w = world({ isUserConnected: async () => { throw new Error('redis down'); }, flag: false });
  await run(w, repriced('ride-err'));
  assert.equal(mine(w).length, 1);
});

test('bug fix, flag off: a throwing presence check on a declined bid sends the push', async () => {
  const w = world({ isUserConnected: async () => { throw new Error('redis down'); }, flag: false });
  await run(w, declined());
  assert.equal(mine(w).length, 1);
  assert.equal(mine(w)[0].data.type, 'bid_declined');
});

test('declined, flag off: connected driver gets no push; flag on, backgrounded gets one, deduped', async () => {
  const off = world({ isUserConnected: async () => true, flag: false });
  await run(off, declined());
  assert.equal(mine(off).length, 0);
  const on = world({ isUserConnected: async () => true, flag: true });
  on.redis.store.set(appBackgroundKey(DRIVER), '1');
  await run(on, declined()); await run(on, declined());
  assert.equal(mine(on).length, 1);
  assert.equal(mine(on)[0].data.type, 'bid_declined');
});

test('declined, flag on: a different timestamp is new news and pushes; a redelivery does not', async () => {
  const w = world({ isUserConnected: async () => false, flag: true });
  await run(w, declined('ride-dd', '2026-10-29T10:00:00.000Z'));
  await run(w, declined('ride-dd', '2026-10-29T10:00:00.000Z'));
  assert.equal(mine(w).length, 1);
  await run(w, declined('ride-dd', '2026-10-29T10:05:00.000Z'));
  assert.equal(mine(w).length, 2);
});

test('paying tapped 3 times (3 timestamps): one push, and the socket message every time', async () => {
  const w = world({ isUserConnected: async () => false, flag: true });
  for (const t of ['10:00:00', '10:00:20', '10:00:40']) await run(w, paying('ride-3x', `2026-10-29T${t}.000Z`));
  assert.equal(mine(w).length, 1);
  assert.equal(w.toApp.filter((m) => m.type === 'ride:rider_paying').length, 3);
});

test('a push that fails to publish gives the claim back, so a redelivery tries again', async () => {
  const w = world({ isUserConnected: async () => false, flag: true });
  let fail = true;
  w.deps.publisher.publishNotificationEvent = async (e) => { if (fail) throw new Error('kafka down'); w.pushes.push(e); };
  await run(w, paying('ride-f'));
  assert.equal(mine(w).length, 0);
  fail = false;
  await run(w, paying('ride-f'));
  assert.equal(mine(w).length, 1);
});

test('the dedupe claim throwing still sends the push', async () => {
  const w = world({ isUserConnected: async () => false, flag: true });
  w.redis.setIfNotExists = async () => { throw new Error('redis down'); };
  await run(w, paying('ride-cl'));
  assert.equal(mine(w).length, 1);
});

test('the same event twice at once gives exactly one push', async () => {
  const w = world({ isUserConnected: async () => false, flag: true });
  await Promise.all([run(w, paying('ride-par')), run(w, paying('ride-par'))]);
  assert.equal(mine(w).length, 1);
});

test('the claim lasts 30 s before the publish and 10 minutes after it', async () => {
  const w = world({ isUserConnected: async () => false, flag: true });
  const ttlsAtPublish = [];
  const realPublish = w.deps.publisher.publishNotificationEvent;
  w.deps.publisher.publishNotificationEvent = async (e) => { ttlsAtPublish.push([...w.redis.ttls.values()].pop()); return realPublish(e); };
  await run(w, paying('ride-ttl'));
  assert.equal(ttlsAtPublish[0], 30);
  assert.equal([...w.redis.ttls.entries()].find(([k]) => k.startsWith('push:driver:ride-ttl'))[1], 600);
});

test('flag on: Redis failing on the background read counts as away', async () => {
  const w = world({ isUserConnected: async () => true, flag: true, redis: memoryRedis({ failGet: true }) });
  await run(w, paying());
  assert.equal(mine(w).length, 1);
});

// ---- the ws message ----
test('app:state background stores the flag with a 2 minute TTL; active clears it; junk is refused', async () => {
  const redis = memoryRedis();
  const auth = { userId: DRIVER };
  const r = await handleAppStateMessage('app:state', { state: 'background' }, auth, redis);
  assert.equal(r.type, 'app:state:ok');
  assert.equal(redis.store.get(appBackgroundKey(DRIVER)), '1');
  assert.equal(redis.ttls.get(appBackgroundKey(DRIVER)), APP_BACKGROUND_TTL_SECONDS);
  assert.equal(APP_BACKGROUND_TTL_SECONDS, 120);
  await handleAppStateMessage('app:state', { state: 'active' }, auth, redis);
  assert.equal(redis.store.has(appBackgroundKey(DRIVER)), false);
  await assert.rejects(handleAppStateMessage('app:state', { state: 'sleeping' }, auth, redis));
  assert.equal(await handleAppStateMessage('driver:online', {}, auth, redis), null);
});

test('end to end: app:state background then the event pushes; active then the event does not', async () => {
  const w = world({ isUserConnected: async () => true, flag: true });
  await handleAppStateMessage('app:state', { state: 'background' }, { userId: DRIVER }, w.redis);
  await run(w, paying('ride-e1'));
  assert.equal(mine(w).length, 1);
  await handleAppStateMessage('app:state', { state: 'active' }, { userId: DRIVER }, w.redis);
  await run(w, paying('ride-e2'));
  assert.equal(mine(w).length, 1);
});

// ---- worker: channelId only for devices that declared it ----
test('worker sets channelId only for a device that declared one', async () => {
  const bodies = [];
  const fetch = async (url, init) => { bodies.push(JSON.parse(init.body)); return { ok: true, status: 200, json: async () => ({ data: [{ status: 'error' }, { status: 'error' }, { status: 'error' }] }) }; };
  const d = { fetch, markDelivered: async () => {}, disable: async () => {}, log: () => {}, warn: () => {}, later: () => {} };
  await sendPush(d, 'u', [
    { expoPushToken: 'ExponentPushToken[old]' },
    { expoPushToken: 'ExponentPushToken[null]', androidChannelId: null },
    { expoPushToken: 'ExponentPushToken[new]', androidChannelId: 'rides' },
  ], { title: 't', body: 'b', priority: 'high' });
  const [old, nul, neu] = bodies[0];
  assert.equal('channelId' in old, false);
  assert.equal('channelId' in nul, false);
  assert.equal(neu.channelId, 'rides');
});
