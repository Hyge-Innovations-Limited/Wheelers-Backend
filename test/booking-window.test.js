// A booking in progress waits an hour for the rider, and the hour starts again
// every time they use it. Ten minutes lost the trip of anyone who stopped to
// take a call before tapping Confirm.
//
//   node --test test/booking-window.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const bid = require('../apps/api-gateway/dist/whatsapp-flows/bid-state.js');

function redis() {
  const calls = [];
  const store = new Map();
  return {
    calls,
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async set(k, v, ttl) { calls.push(['set', k, ttl]); store.set(k, v); },
    async del(k) { store.delete(k); },
    async send(...args) { calls.push(args); return 1; },
  };
}
const settle = () => new Promise((r) => setImmediate(r));

test('the trip, the pickup and the step each wait an hour', async () => {
  const r = redis();
  assert.equal(bid.BOOKING_TTL, 3600);
  await bid.storePendingRoute(r, 'u1', { pickupAddress: 'A', destAddress: 'B' });
  await bid.setPendingLocation(r, 'u1', { lat: 6.5, lng: 3.3, address: 'A', savedAt: new Date().toISOString() });
  await bid.setBookingStage(r, 'u1', 'awaiting_trip_confirm');
  assert.deepEqual(r.calls.map((c) => c[2]), [3600, 3600, 3600]);
});

test('using it starts the hour again; nothing to keep when there is nothing there', async () => {
  const r = redis();
  await bid.storePendingRoute(r, 'u2', { pickupAddress: 'A', destAddress: 'B' });
  await bid.setBookingStage(r, 'u2', 'awaiting_price');
  r.calls.length = 0;
  await bid.getPendingRoute(r, 'u2');
  await bid.getBookingStage(r, 'u2');
  await settle();
  assert.deepEqual(r.calls.map((c) => [c[0], c[2]]), [['EXPIRE', '3600'], ['EXPIRE', '3600']]);
  r.calls.length = 0;
  await bid.getPendingRoute(r, 'nobody');
  await settle();
  assert.equal(r.calls.length, 0);
});

test('a Redis without EXPIRE never breaks a booking', async () => {
  const r = redis();
  delete r.send;
  await bid.storePendingRoute(r, 'u3', { pickupAddress: 'A', destAddress: 'B' });
  assert.equal((await bid.getPendingRoute(r, 'u3')).destAddress, 'B');
  await settle();
});
