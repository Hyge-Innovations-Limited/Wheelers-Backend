// The rider accepted a driver, then the driver cancelled. The search goes on —
// and nothing of the old one is left standing: the driver's ACCEPTED bid is
// CANCELLED (their app stops showing "Starting your trip…"), the old offers are
// cleared (the rider is not told "1 driver found" for the driver who left), and
// the one cancel message carries "See driver offers" for the new search. A
// rider asking their balance mid-search gets their balance. Against the local
// Postgres.
//
//   node scripts/run-with-env.cjs node --test --test-force-exit test/driver-bail-cleanup.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const { driverBidClient } = require('../packages/db/dist/index.js');
const { handleRideEvent } = require('../apps/api-gateway/dist/kafka/consumer.js');
const { addBid, getBids } = require('../apps/api-gateway/dist/whatsapp-flows/bid-state.js');
const { rideCancelledText } = require('../apps/api-gateway/dist/whatsapp-flows/whatsapp-notifier.js');
const { hasOffersPageMessage } = require('../apps/api-gateway/dist/whatsapp-flows/offers-page-message.js');
const { isBalanceQuestion } = require('../apps/api-gateway/dist/whatsapp/stages/in-ride.js');

const prisma = new PrismaClient();
const made = { users: [], rides: [] };
test.beforeEach(() => { console.log = console.info = console.warn = console.error = () => {}; });

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
async function user(role, phone) {
  const id = randomUUID();
  await prisma.user.create({ data: { id, privyDid: `test:bail:${id}`, role, name: `Test ${role}`, ...(phone ? { phone } : {}) } });
  made.users.push(id);
  return id;
}

test('a driver bails after being accepted: bid CANCELLED, old offers gone, one cancel message with the offers button', async () => {
  const phone = `+234800${Math.floor(1000000 + Math.random() * 8999999)}`;
  const riderId = await user('RIDER', phone);
  const driverUserId = await user('DRIVER');
  const driver = await prisma.driver.create({ data: { userId: driverUserId, kycStatus: 'APPROVED', status: 'ON_RIDE', lat: 6.52, lng: 3.38, lastSeenAt: new Date() } });
  const ride = await prisma.ride.create({ data: { riderId, driverId: driver.id, channel: 'WHATSAPP', status: 'DRIVER_ASSIGNED', pickupLat: 6.5244, pickupLng: 3.387, pickupAddress: 'Akoka', destLat: 6.5095, destLng: 3.3711, destAddress: 'Yaba', riderOfferNgn: 2500, fareEstimateNgn: 2500, distanceKm: 3, paymentMethod: 'WALLET' } });
  made.rides.push(ride.id);
  await driverBidClient.record({ rideId: ride.id, driverId: driver.id, driverUserId, riderId, amountNgn: 2800, etaSeconds: 300 });
  await driverBidClient.markAccepted(ride.id, driver.id);

  const redis = memoryRedis();
  await addBid(redis, ride.id, { driverId: driver.id, driverName: 'Timmy', counterOfferNgn: 2800, etaSeconds: 300 });

  const sentToMeta = [];
  const realFetch = global.fetch;
  global.fetch = async (_url, init) => {
    sentToMeta.push(JSON.parse(init.body));
    return { ok: true, status: 200, text: async () => '', json: async () => ({ messages: [{ id: 'wamid.CANCEL' }] }) };
  };
  const toApp = [];
  const deps = {
    registry: { sendToUser: async (userId, type, payload) => { toApp.push({ userId, type, payload }); }, isUserConnected: async () => false },
    redisClient: redis,
    publisher: { publishRideEvent: async () => {}, publishDriverEvent: async () => {} },
    whatsappNotifier: { metaAccessToken: 't', metaPhoneNumberId: '1' },
    ridePageUrlFor: () => 'https://w.example/widget/ride/ride.html#t=x',
  };
  try {
    await handleRideEvent({ eventType: 'RIDE_CANCELLED', rideId: ride.id, riderId, driverId: driver.id, driverUserId, cancelledBy: 'driver', reason: 'driver_cancelled', timestamp: new Date().toISOString() }, deps, new Map());
  } finally { global.fetch = realFetch; }

  const bid = await prisma.driverBid.findUnique({ where: { rideId_driverId: { rideId: ride.id, driverId: driver.id } } });
  assert.equal(bid.status, 'CANCELLED', 'the driver app will not rebuild "Accepted" from it');
  assert.deepEqual(await getBids(redis, ride.id), [], 'the driver who left is not "1 driver found"');

  const messages = sentToMeta.filter((b) => b.to === phone.replace(/^\+/, ''));
  assert.equal(messages.length, 1, 'one message');
  assert.equal(messages[0].type, 'interactive');
  assert.equal(messages[0].interactive.action.parameters.display_text, 'See driver offers');
  assert.match(messages[0].interactive.body.text, /^\*Your driver had to cancel\.\*/);
  assert.match(messages[0].interactive.body.text, /See driver offers\* below/);
  assert.doesNotMatch(messages[0].interactive.body.text, /driver_cancelled/);
  assert.equal(await hasOffersPageMessage(redis, ride.id), true, 'new offers are counted on it');

  const toDriver = toApp.find((m) => m.userId === driverUserId && m.type === 'ride:cancelled');
  assert.equal(toDriver.payload.cancelledBy, 'driver', 'the app knows it was them (no "rider cancelled" alert)');
});

test('the cancel text never shows a machine reason', () => {
  const text = rideCancelledText({ reason: 'rider_no_show', cancelledBy: 'driver', refundedNgn: 2800, balanceNgn: 2800.13 });
  assert.doesNotMatch(text, /_/);
  assert.match(text, /₦2,800 is back in your wallet/);
});

test('"What\'s my balance" mid-search is a balance question; money moves are not', () => {
  for (const yes of ["What's my balance", 'whats my bal', 'How much do I have in my wallet', 'my wallet?']) assert.equal(isBalanceQuestion(yes), true, yes);
  for (const no of ['withdraw my balance', 'deposit 5000', 'I want to go to Yaba', '3000']) assert.equal(isBalanceQuestion(no), false, no);
});

test.after(async () => {
  await prisma.driverBid.deleteMany({ where: { rideId: { in: made.rides } } }).catch(() => {});
  await prisma.ride.deleteMany({ where: { id: { in: made.rides } } }).catch(() => {});
  await prisma.driver.deleteMany({ where: { userId: { in: made.users } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: made.users } } }).catch(() => {});
  await prisma.$disconnect();
});
