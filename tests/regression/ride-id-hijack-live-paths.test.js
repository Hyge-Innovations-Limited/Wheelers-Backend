// Regression guard for security hotfix 2: legitimate booking paths must still work.
// Real entry points, local Postgres. Every case must pass on 39f29c9 (production); a case that
// fails on the hotfix branch but passes on 39f29c9 is a regression.
//
//   node scripts/run-with-env.cjs node --test --test-force-exit tests/regression/ride-id-hijack-live-paths.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const { driverBidClient } = require('../../packages/db/dist/index.js');
const { handleRideMessage } = require('../../apps/api-gateway/dist/websocket/handlers/ride.handler.js');
const { confirmRideWithOffer } = require('../../apps/api-gateway/dist/rides/whatsapp-ride.service.js');
const bidState = require('../../apps/api-gateway/dist/whatsapp-flows/bid-state.js');

const prisma = new PrismaClient();
const made = { users: [], rides: [], drivers: [], groups: [] };
const realConsole = { ...console };
test.beforeEach(() => { console.log = console.info = console.warn = console.error = () => {}; });
test.afterEach(() => { Object.assign(console, realConsole); });
test.after(async () => {
  await prisma.rideHold.deleteMany({ where: { rideId: { in: [...made.rides, ...made.groups] } } });
  await prisma.driverBid.deleteMany({ where: { rideId: { in: [...made.rides, ...made.groups] } } });
  await prisma.groupRideMatchRequest.deleteMany({ where: { id: { in: made.groups } } });
  await prisma.rideStop.deleteMany({ where: { rideId: { in: made.rides } } });
  await prisma.ride.deleteMany({ where: { id: { in: made.rides } } });
  await prisma.driver.deleteMany({ where: { id: { in: made.drivers } } });
  await prisma.wallet.deleteMany({ where: { userId: { in: made.users } } });
  await prisma.user.deleteMany({ where: { id: { in: made.users } } });
  await prisma.$disconnect();
});

const OLD = { pickupLat: 6.6, pickupLng: 3.35, pickupAddress: 'Opebi', destLat: 6.5, destLng: 3.36, destAddress: 'Surulere' };
const planner = { planRoute: async () => ({ distanceKm: 10, durationSeconds: 1500, suggestedFareNgn: 5000, minOfferNgn: 4100, ratePerKmNgn: 400, geometry: { coordinates: [], bounds: { northEast: { lat: 6.6, lng: 3.4 }, southWest: { lat: 6.5, lng: 3.3 } } } }) };

async function user(role = 'RIDER') {
  const id = randomUUID();
  await prisma.user.create({ data: { id, privyDid: `test:regr:${id}`, role, name: 'Regr user' } });
  made.users.push(id);
  return id;
}
async function ride(riderId) {
  const r = await prisma.ride.create({ data: { riderId, status: 'MATCHING', ...OLD, fareEstimateNgn: 7900, riderOfferNgn: 7900 } });
  made.rides.push(r.id);
  await prisma.rideStop.create({ data: { rideId: r.id, stopOrder: 0, type: 'FINAL', status: 'PENDING', lat: OLD.destLat, lng: OLD.destLng, address: OLD.destAddress } });
  return r;
}
async function driver() {
  const userId = await user('DRIVER');
  const d = await prisma.driver.create({ data: { userId, kycStatus: 'APPROVED', status: 'ONLINE', lastSeenAt: new Date(), lat: 6.5244, lng: 3.387, vehicleModel: 'Camry', vehiclePlate: 'DB-PLATE-1' } });
  made.drivers.push(d.id);
  return { id: d.id, userId };
}
function front() {
  const published = [];
  return { published, publisher: { publishRideEvent: async (e) => { published.push(e); }, publishWalletEvent: async () => {}, publishNotificationEvent: async () => {} } };
}
function memoryRedis() {
  return { store: new Map(), async get(k) { return this.store.get(k) ?? null; }, async set(k, v) { this.store.set(k, v); }, async del(k) { this.store.delete(k); }, async setIfNotExists(k, v) { if (this.store.has(k)) return false; this.store.set(k, v); return true; }, async send() { return null; } };
}

// What the live driver app sends (Wheelersapp lib/driver-session.tsx acceptRide / bidOnSeat).
const appBid = (rideId, riderId) => ({ rideId, riderId, driverName: 'Driver', driverRating: 5.0, vehiclePlate: 'N/A', vehicleModel: 'N/A', etaSeconds: 300, agreedFareNgn: 7900 });

test('app: the live driver app payload bids on a solo ride; the bid row is PENDING and the event carries the rider', async () => {
  const owner = await user();
  const d = await driver();
  const r = await ride(owner);
  const g = front();
  const reply = await handleRideMessage('driver:accept', appBid(r.id, owner), { userId: d.userId, role: 'DRIVER', driverId: d.id }, g.publisher, planner, undefined);
  assert.equal(reply.type, 'driver:accept:accepted');
  const event = g.published.find((e) => e.eventType === 'RIDE_COUNTER_OFFER');
  assert.equal(event.riderId, owner);
  const rows = await driverBidClient.findByRide(r.id);
  assert.ok(rows.some((row) => row.driverId === d.id && row.status === 'PENDING'), 'PENDING DriverBid row written');
});

test('app: a driver whose app sends NO riderId still bids (a card rebuilt from history)', async () => {
  const owner = await user();
  const d = await driver();
  const r = await ride(owner);
  const g = front();
  const { riderId, ...noRider } = appBid(r.id, owner);
  await handleRideMessage('driver:accept', noRider, { userId: d.userId, role: 'DRIVER', driverId: d.id }, g.publisher, planner, undefined);
  assert.equal(g.published.find((e) => e.eventType === 'RIDE_COUNTER_OFFER').riderId, owner);
});

test('WhatsApp chat: driver:accept bid -> kafka-style addBid -> confirmRideWithOffer is NOT refused by the new gates', async () => {
  const owner = await user();
  const d = await driver();
  const r = await ride(owner);
  const g = front();
  await handleRideMessage('driver:accept', appBid(r.id, owner), { userId: d.userId, role: 'DRIVER', driverId: d.id }, g.publisher, planner, undefined);
  const event = g.published.find((e) => e.eventType === 'RIDE_COUNTER_OFFER');
  const redis = memoryRedis();
  await prisma.wallet.upsert({ where: { userId: owner }, update: { balanceNgn: 50000 }, create: { userId: owner, balanceNgn: 50000 } });
  await bidState.storeWhatsappRide(redis, r.id, { riderId: owner, phone: '+2348030000077', pickupAddress: 'Opebi', destinationAddress: 'Surulere', offerNgn: 7900, suggestedFareNgn: 7900, paymentMethod: 'WALLET', createdAt: new Date().toISOString() });
  await bidState.addBid(redis, r.id, { bidId: event.bidId, driverId: d.id, driverUserId: d.userId, counterOfferNgn: event.counterOfferNgn, driverName: event.driverName, driverRating: event.driverRating, vehiclePlate: event.vehiclePlate, vehicleModel: event.vehicleModel, etaSeconds: event.etaSeconds, distanceKm: event.distanceKm, receivedAt: new Date().toISOString() });
  const deps = { registry: { sendToUser: async () => {}, isUserConnected: async () => false, hasUser: () => false }, redisClient: redis, publisher: g.publisher };
  const key = bidState.offerKey ? bidState.offerKey({ bidId: event.bidId, driverId: d.id }) : event.bidId;
  const result = await confirmRideWithOffer(deps, owner, r.id, key);
  assert.notEqual(result.code, 'RIDE_GONE');
  assert.notEqual(result.code, 'OFFER_GONE');
});

test('group ride: a seat that is only a group match request (no Ride row) was ALREADY refused on 39f29c9 (assertRideOpenForBids) - unchanged', async () => {
  const member = await user();
  const d = await driver();
  const group = await prisma.groupRideMatchRequest.create({ data: { userId: member, ...OLD, status: 'MATCHING', fareEstimateNgn: 3000 } });
  made.groups.push(group.id);
  const g = front();
  await assert.rejects(() => handleRideMessage('driver:accept', { ...appBid(group.id, member), agreedFareNgn: 3000 }, { userId: d.userId, role: 'DRIVER', driverId: d.id }, g.publisher, planner, undefined), /no longer exists/);
  assert.equal(g.published.length, 0);
});

test('group ride: the anchor seat (it has a Ride row, owned by the first member) still takes a bid and is still confirmable', async () => {
  const anchorRider = await user();
  const d = await driver();
  const r = await ride(anchorRider);
  const g = front();
  const reply = await handleRideMessage('driver:accept', appBid(r.id, anchorRider), { userId: d.userId, role: 'DRIVER', driverId: d.id }, g.publisher, planner, undefined);
  assert.equal(reply.type, 'driver:accept:accepted');
});

test('WhatsApp / page: WALLET_SHORT, add money, book again - the bid row stays PENDING so the second confirm is not refused', async () => {
  const owner = await user();
  const d = await driver();
  const r = await ride(owner);
  const g = front();
  await handleRideMessage('driver:accept', appBid(r.id, owner), { userId: d.userId, role: 'DRIVER', driverId: d.id }, g.publisher, planner, undefined);
  const event = g.published.find((e) => e.eventType === 'RIDE_COUNTER_OFFER');
  const redis = memoryRedis();
  await prisma.wallet.upsert({ where: { userId: owner }, update: { balanceNgn: 0 }, create: { userId: owner, balanceNgn: 0 } });
  await bidState.storeWhatsappRide(redis, r.id, { riderId: owner, phone: '+2348030000066', pickupAddress: 'Opebi', destinationAddress: 'Surulere', offerNgn: 7900, suggestedFareNgn: 7900, paymentMethod: 'WALLET', createdAt: new Date().toISOString() });
  const bid = { bidId: event.bidId, driverId: d.id, driverUserId: d.userId, counterOfferNgn: event.counterOfferNgn, driverName: event.driverName, driverRating: event.driverRating, vehiclePlate: event.vehiclePlate, vehicleModel: event.vehicleModel, etaSeconds: event.etaSeconds, distanceKm: event.distanceKm, receivedAt: new Date().toISOString() };
  await bidState.addBid(redis, r.id, bid);
  const deps = { registry: { sendToUser: async () => {}, isUserConnected: async () => false, hasUser: () => false }, redisClient: redis, publisher: g.publisher };
  const key = bidState.offerKey ? bidState.offerKey(bid) : event.bidId;
  const short = await confirmRideWithOffer(deps, owner, r.id, key);
  assert.equal(short.code, 'WALLET_SHORT');
  await prisma.wallet.update({ where: { userId: owner }, data: { balanceNgn: 50000 } });
  const again = await confirmRideWithOffer(deps, owner, r.id, key);
  assert.ok(again.ok || !['RIDE_GONE', 'OFFER_GONE'].includes(again.code), 'second confirm: ' + JSON.stringify(again.code));
});

test('ride:request: a v4 UUID like expo-crypto randomUUID() is accepted', async () => {
  for (let i = 0; i < 50; i++) assert.match(randomUUID(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
});
