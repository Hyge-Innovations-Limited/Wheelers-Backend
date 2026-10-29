// "Rider accepted · paying now" (plan 2026-10-28, S2): the state, the events and what the driver's socket hears.
// Events published by the helpers are fed straight back into handleRideEvent, as Kafka would.
//
//   npm run build && node --test --test-force-exit test/driver-paying-status.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { handleRideEvent } = require('../apps/api-gateway/dist/kafka/consumer.js');
const paying = require('../apps/api-gateway/dist/rides/paying-status.js');
const { RideEvent } = require('../packages/kafka-schemas/dist/index.js');

const realConsole = { ...console };
test.beforeEach(() => { console.log = console.info = console.warn = console.error = () => {}; paying.setPayingStatusEnabled(true); });
test.afterEach(() => { Object.assign(console, realConsole); paying.setPayingStatusEnabled(false); });

function memoryRedis() {
  const store = new Map(); const ttls = new Map();
  return {
    store, ttls,
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async set(k, v, ttl) { store.set(k, v); ttls.set(k, ttl); },
    async del(k) { store.delete(k); },
    async setIfNotExists(k, v, ttl) { if (store.has(k)) return false; store.set(k, v); ttls.set(k, ttl); return true; },
    // Redis scripts: the same logic in JS, one step at a time (the real Lua is run against a real Redis in the entry test).
    async send(cmd, script, _n, k, ...a) {
      if (cmd !== 'EVAL') return null;
      if (script === paying.CLOSE_SCRIPT) {
        const [lastKey, raw, since, ex] = a;
        if (store.get(k) !== raw) return 0;
        store.delete(k);
        if (Number(ex) > 0) { store.set(lastKey, since); ttls.set(lastKey, Number(ex)); } else store.delete(lastKey);
        return 1;
      }
      if (script === paying.RATE_SCRIPT) { const n = Number(store.get(k) ?? 0) + 1; store.set(k, String(n)); return n; }
      if (script === paying.OPEN_SCRIPT) {
        const [spellsKey, lastKey, val, ttl, driver, untilMs, threshold, maxSpell, nowMs, , maxSpells, lastPrefix] = a; const old = store.get(k);
        const now = Number(nowMs); const maxMs = Number(maxSpell);
        if (old !== undefined) {
          const o = JSON.parse(old);
          if (o.driverUserId === driver) {
            const cap = o.since + maxMs; const told = o.untilMs ?? o.since + Number(ttl) * 1000;
            const want = Math.min(Number(untilMs), cap); let fresh = old;
            if (want - told > Number(threshold)) { o.untilMs = want; fresh = JSON.stringify(o); }
            const ex = Math.min(Number(ttl), Math.floor((cap - now) / 1000));
            if (ex > 0) { store.set(k, fresh); ttls.set(k, ex); }
            return ['same', fresh, old];
          }
        }
        let startSince = now; let resumed = false;
        const lastRaw = store.get(lastKey);
        if (lastRaw !== undefined && Number(lastRaw) + maxMs - now > 1000) { startSince = Number(lastRaw); resumed = true; }
        if (!resumed) {
          const spells = Number(store.get(spellsKey) ?? 0) + 1; store.set(spellsKey, String(spells));
          if (spells > Number(maxSpells)) return ['refused', old ?? ''];
        }
        if (old !== undefined) {
          const o = JSON.parse(old); const lex = Math.floor((o.since + maxMs - now) / 1000);
          if (lex > 0) { store.set(lastPrefix + o.driverUserId, String(o.since)); ttls.set(lastPrefix + o.driverUserId, lex); }
        }
        const st = JSON.parse(val); st.since = startSince; st.untilMs = Math.min(Number(untilMs), startSince + maxMs);
        const fresh = JSON.stringify(st);
        store.set(k, fresh); ttls.set(k, Math.min(Number(ttl), Math.floor((startSince + maxMs - now) / 1000)));
        store.delete(lastKey);
        return old !== undefined ? ['switched', old, fresh] : ['opened', '', fresh];
      }
      return null;
    },
  };
}
const A = randomUUID(); const B = randomUUID(); const RIDER = randomUUID(); const RIDE = randomUUID();

function world() {
  const toApp = []; const rideEvents = []; const redis = memoryRedis();
  const deps = {
    driverStatusPushes: true,
    registry: { sendToUser: async (userId, type, payload) => { toApp.push({ userId, type, payload }); }, isUserConnected: async () => true, hasUser: () => true },
    redisClient: redis,
    publisher: {
      publishRideEvent: async (e) => {
        RideEvent.parse(e); // the real schema accepts it
        rideEvents.push(e);
        await handleRideEvent(e, deps, new Map()); // as Kafka would hand it back
      },
      publishDriverEvent: async () => {}, publishWalletEvent: async () => {}, publishNotificationEvent: async () => {},
    },
  };
  return { toApp, rideEvents, redis, deps };
}
const heard = (w, userId, type) => w.toApp.filter((m) => m.userId === userId && m.type === type);

test('open: the driver hears ride:rider_paying with payingSince and payingUntil 10 minutes on; the key lives 10 minutes', async () => {
  const w = world();
  assert.equal((await paying.openPaying(w.deps, RIDE, RIDER, A)).result, 'opened');
  const [m] = heard(w, A, 'ride:rider_paying');
  assert.equal(m.payload.rideId, RIDE);
  assert.equal(Date.parse(m.payload.payingUntil) - Date.parse(m.payload.payingSince), 600_000);
  assert.equal(w.redis.ttls.get(`ride:${RIDE}:paying`), 600);
  assert.equal((await paying.readPaying(w.redis, RIDE)).driverUserId, A);
});

test('opening twice for the same driver is one event; closing gives ended once, closing again gives nothing', async () => {
  const w = world();
  await paying.openPaying(w.deps, RIDE, RIDER, A);
  const before = await paying.readPaying(w.redis, RIDE);
  await new Promise((r) => setTimeout(r, 5));
  const again = await paying.openPaying(w.deps, RIDE, RIDER, A);
  assert.equal(again.result, 'unchanged');
  const after = await paying.readPaying(w.redis, RIDE);
  assert.equal(after.since, before.since, 'the card keeps its start');
  assert.equal(after.untilMs, before.untilMs, 'a small move is not stored: the stored end is the last one told');
  assert.equal(again.payingUntil, new Date(after.untilMs).toISOString());
  assert.equal(w.rideEvents.filter((e) => e.eventType === 'RIDE_RIDER_PAYING').length, 1);
  assert.equal(await paying.closePaying(w.deps, RIDE, 'closed', A), true);
  assert.equal(heard(w, A, 'ride:rider_paying_ended').length, 1);
  assert.deepEqual(heard(w, A, 'ride:rider_paying_ended')[0].payload, { rideId: RIDE, reason: 'closed' });
  assert.equal(await paying.closePaying(w.deps, RIDE, 'closed', A), false);
  assert.equal(heard(w, A, 'ride:rider_paying_ended').length, 1);
});

test('A then B: A is told it ended (switched), B is told it began, one driver holds the state', async () => {
  const w = world();
  await paying.openPaying(w.deps, RIDE, RIDER, A);
  assert.equal((await paying.openPaying(w.deps, RIDE, RIDER, B)).result, 'switched');
  assert.equal(heard(w, A, 'ride:rider_paying_ended')[0].payload.reason, 'switched');
  assert.equal(heard(w, B, 'ride:rider_paying').length, 1);
  assert.equal((await paying.readPaying(w.redis, RIDE)).driverUserId, B);
  // closing for A now does nothing: it is B's
  assert.equal(await paying.closePaying(w.deps, RIDE, 'closed', A), false);
});

test('two opens at once for the same driver give one event', async () => {
  const w = world();
  await Promise.all([paying.openPaying(w.deps, RIDE, RIDER, A), paying.openPaying(w.deps, RIDE, RIDER, A)]);
  assert.equal(w.rideEvents.filter((e) => e.eventType === 'RIDE_RIDER_PAYING').length, 1);
});

test('the rider declines the offer: the driver hears declined and the card is ended', async () => {
  const w = world();
  await paying.openPaying(w.deps, RIDE, RIDER, A);
  await handleRideEvent({ eventType: 'RIDE_BIDS_DECLINED', rideId: RIDE, riderId: RIDER, driverUserIds: [A], remainingOffers: 0, timestamp: new Date().toISOString() }, w.deps, new Map());
  assert.equal(heard(w, A, 'ride:bid_declined').length, 1);
  assert.equal(heard(w, A, 'ride:rider_paying_ended')[0].payload.reason, 'declined');
  assert.equal(await paying.readPaying(w.redis, RIDE), null);
});

test("declining ANOTHER driver's offer leaves this driver's paying state alone", async () => {
  const w = world();
  await paying.openPaying(w.deps, RIDE, RIDER, A);
  await handleRideEvent({ eventType: 'RIDE_BIDS_DECLINED', rideId: RIDE, riderId: RIDER, driverUserIds: [B], remainingOffers: 1, timestamp: new Date().toISOString() }, w.deps, new Map());
  assert.equal(heard(w, A, 'ride:rider_paying_ended').length, 0);
  assert.equal((await paying.readPaying(w.redis, RIDE)).driverUserId, A);
});

test('another driver booked: the paying driver is told ended (other_chosen); the booked driver itself just has the state cleared', async () => {
  const w = world();
  await paying.openPaying(w.deps, RIDE, RIDER, A);
  await paying.clearForBooking(w.deps, RIDE, B);
  assert.equal(heard(w, A, 'ride:rider_paying_ended')[0].payload.reason, 'other_chosen');
  const w2 = world();
  await paying.openPaying(w2.deps, RIDE, RIDER, A);
  await paying.clearForBooking(w2.deps, RIDE, A);
  assert.equal(heard(w2, A, 'ride:rider_paying_ended').length, 0, 'booked ends it through ride:offer_accepted');
  assert.equal(await paying.readPaying(w2.redis, RIDE), null);
});

test('cancel and search-end reasons reach the driver', async () => {
  for (const reason of ['cancelled', 'search_ended']) {
    const w = world();
    await paying.openPaying(w.deps, RIDE, RIDER, A);
    await paying.closePaying(w.deps, RIDE, reason);
    assert.equal(heard(w, A, 'ride:rider_paying_ended')[0].payload.reason, reason);
  }
});

test('TTL expiry: the key is gone, so nothing is restored and a close does nothing (the app stops waiting at payingUntil itself)', async () => {
  const w = world();
  await paying.openPaying(w.deps, RIDE, RIDER, A);
  w.redis.store.delete(`ride:${RIDE}:paying`); // Redis expired it
  assert.equal(await paying.readPaying(w.redis, RIDE), null);
  assert.equal(await paying.closePaying(w.deps, RIDE, 'closed'), false);
  assert.equal(heard(w, A, 'ride:rider_paying_ended').length, 0);
});

test('a decline (or failure, cancel, end) starts a fresh spell next time, with its own banner; a rider Back resumes', async () => {
  for (const reason of ['declined', 'failed', 'cancelled', 'search_ended', 'other_chosen']) {
    const w = world();
    await paying.openPaying(w.deps, RIDE, RIDER, A);
    await paying.closePaying(w.deps, RIDE, reason, A);
    assert.equal(w.redis.store.has(paying.payingLastKey(RIDE, A)), false, reason);
  }
  const w = world();
  await paying.openPaying(w.deps, RIDE, RIDER, A);
  await paying.closePaying(w.deps, RIDE, 'closed', A);
  assert.equal(w.redis.store.has(paying.payingLastKey(RIDE, A)), true);
});

test('paying push: a resumed spell sends no second banner; a genuinely new spell does', async () => {
  const w = world();
  const pushes = [];
  w.deps.registry.isUserConnected = async () => false;
  w.deps.publisher.publishNotificationEvent = async (e) => { pushes.push(e); };
  const mineP = () => pushes.filter((p) => p.userId === A).length;
  await paying.openPaying(w.deps, RIDE, RIDER, A);
  await paying.closePaying(w.deps, RIDE, 'closed', A);
  await new Promise((r) => setTimeout(r, 5));
  await paying.openPaying(w.deps, RIDE, RIDER, A); // back inside the same spell: resumed
  assert.equal(mineP(), 1);
  await paying.closePaying(w.deps, RIDE, 'closed', A);
  w.redis.store.delete(paying.payingLastKey(RIDE, A)); // the 20 minutes passed
  await new Promise((r) => setTimeout(r, 5));
  await paying.openPaying(w.deps, RIDE, RIDER, A);
  assert.equal(mineP(), 2, 'a new spell is new news');
});

for (const reason of ['driver_busy', 'ride_closed']) {
  test(`assignment failed (${reason}): the paying driver's card is ended (failed)`, async () => {
    const w = world();
    await paying.openPaying(w.deps, RIDE, RIDER, A);
    await handleRideEvent({ eventType: 'RIDE_ASSIGNMENT_FAILED', rideId: RIDE, riderId: RIDER, driverId: randomUUID(), driverUserId: A, reason, timestamp: new Date().toISOString() }, w.deps, new Map()).catch(() => {});
    assert.equal(heard(w, A, 'ride:rider_paying_ended')[0]?.payload.reason, 'failed');
    assert.equal(await paying.readPaying(w.redis, RIDE), null);
  });
}

test('a stale RIDE_RIDER_PAYING (another driver holds it now) is not shown to its driver', async () => {
  const w = world();
  await paying.openPaying(w.deps, RIDE, RIDER, A);
  await paying.openPaying(w.deps, RIDE, RIDER, B);
  const stale = w.rideEvents.find((e) => e.eventType === 'RIDE_RIDER_PAYING' && e.driverUserId === A);
  w.toApp.length = 0;
  await handleRideEvent(stale, w.deps, new Map());
  assert.equal(heard(w, A, 'ride:rider_paying').length, 0);
});

test('re-opening every 90 s: the driver is told again only when the told end is over 2 minutes behind, and the key never lapses', async () => {
  const w = world();
  const realNow = Date.now; const t0 = realNow();
  try {
    let at = 0;
    Date.now = () => t0 + at * 1000;
    await paying.openPaying(w.deps, RIDE, RIDER, A);
    const told = [];
    for (at = 90; at <= 540; at += 90) {
      const before = heard(w, A, 'ride:rider_paying').length;
      await paying.openPaying(w.deps, RIDE, RIDER, A);
      assert.ok(w.redis.store.has(`ride:${RIDE}:paying`), `still held at ${at}s`);
      assert.equal(w.redis.ttls.get(`ride:${RIDE}:paying`), 600, 'the key life is renewed every time');
      if (heard(w, A, 'ride:rider_paying').length > before) told.push(at);
    }
    assert.deepEqual(told, [180, 360, 540]);
    // what the driver was last told is what is stored
    const last = heard(w, A, 'ride:rider_paying').at(-1).payload.payingUntil;
    assert.equal(last, new Date((await paying.readPaying(w.redis, RIDE)).untilMs).toISOString());
  } finally { Date.now = realNow; }
});

test('a Redis read error on the stale-paying guard still shows the event', async () => {
  const w = world();
  await paying.openPaying(w.deps, RIDE, RIDER, A);
  const ev = w.rideEvents.find((e) => e.eventType === 'RIDE_RIDER_PAYING');
  w.toApp.length = 0;
  const realGet = w.redis.get;
  w.redis.get = async (k) => { if (k === `ride:${RIDE}:paying`) throw new Error('redis down'); return realGet(k); };
  await handleRideEvent(ev, w.deps, new Map());
  assert.equal(heard(w, A, 'ride:rider_paying').length, 1);
});

test('a repeat open that moves the end time by over 2 minutes tells the driver again (socket only); a small move does not', async () => {
  const w = world();
  const pushes = [];
  w.deps.registry.isUserConnected = async () => false;
  w.deps.publisher.publishNotificationEvent = async (e) => { pushes.push(e); };
  await paying.openPaying(w.deps, RIDE, RIDER, A);
  await paying.openPaying(w.deps, RIDE, RIDER, A); // moved by milliseconds
  assert.equal(heard(w, A, 'ride:rider_paying').length, 1);
  // age the stored end time by 3 minutes
  const key = `ride:${RIDE}:paying`;
  const state = JSON.parse(w.redis.store.get(key));
  state.untilMs -= 3 * 60 * 1000;
  w.redis.store.set(key, JSON.stringify(state));
  const again = await paying.openPaying(w.deps, RIDE, RIDER, A);
  const msgs = heard(w, A, 'ride:rider_paying');
  assert.equal(msgs.length, 2);
  assert.equal(msgs[1].payload.payingUntil, again.payingUntil);
  assert.equal(msgs[1].payload.payingSince, msgs[0].payload.payingSince, 'the card keeps its start');
  assert.equal(pushes.filter((p) => p.userId === A).length, 1, 'no second banner');
});

test('rate limit: 20 opens and closes a minute per rider, the 21st is refused', async () => {
  const redis = memoryRedis();
  for (let i = 0; i < 20; i += 1) assert.equal(await paying.withinPayingRate(redis, RIDER), true);
  assert.equal(await paying.withinPayingRate(redis, RIDER), false);
  assert.equal(await paying.withinPayingRate(redis, randomUUID()), true, 'another rider is not affected');
});

test('flag off: a decline sends no ended and touches no state', async () => {
  const w = world();
  await paying.openPaying(w.deps, RIDE, RIDER, A);
  paying.setPayingStatusEnabled(false);
  await handleRideEvent({ eventType: 'RIDE_BIDS_DECLINED', rideId: RIDE, riderId: RIDER, driverUserIds: [A], remainingOffers: 0, timestamp: new Date().toISOString() }, w.deps, new Map());
  assert.equal(heard(w, A, 'ride:rider_paying_ended').length, 0);
  assert.equal((await paying.readPaying(w.redis, RIDE)).driverUserId, A);
});

test('flag off: a RIDE_RIDER_PAYING event carries no payingUntil (today\'s payload)', async () => {
  const w = world();
  await handleRideEvent({ eventType: 'RIDE_RIDER_PAYING', rideId: RIDE, riderId: RIDER, driverUserId: A, timestamp: new Date().toISOString() }, w.deps, new Map());
  assert.deepEqual(heard(w, A, 'ride:rider_paying')[0].payload, { rideId: RIDE });
});

test('payingRemainingMs: on the rider_paying message from the server clock; past gives 0; absent without payingUntil or with the flag off', async () => {
  const w = world();
  const base = { eventType: 'RIDE_RIDER_PAYING', rideId: RIDE, riderId: RIDER, driverUserId: A, timestamp: new Date().toISOString() };
  await paying.openPaying(w.deps, RIDE, RIDER, A);
  const left = heard(w, A, 'ride:rider_paying')[0].payload.payingRemainingMs;
  assert.ok(left > 595_000 && left <= 600_000, `left ${left}`);
  // a past payingUntil: 0 (the guard needs the holder, so make this driver the holder)
  w.toApp.length = 0;
  await handleRideEvent({ ...base, payingSince: new Date(Date.now() - 700_000).toISOString(), payingUntil: new Date(Date.now() - 60_000).toISOString() }, w.deps, new Map());
  assert.equal(heard(w, A, 'ride:rider_paying')[0].payload.payingRemainingMs, 0);
  // no payingUntil: no field
  w.toApp.length = 0;
  await handleRideEvent(base, w.deps, new Map());
  assert.equal('payingRemainingMs' in heard(w, A, 'ride:rider_paying')[0].payload, false);
  // flag off: no field
  paying.setPayingStatusEnabled(false);
  w.toApp.length = 0;
  await handleRideEvent({ ...base, payingUntil: new Date(Date.now() + 60_000).toISOString() }, w.deps, new Map());
  assert.equal('payingRemainingMs' in heard(w, A, 'ride:rider_paying')[0].payload, false);
});
