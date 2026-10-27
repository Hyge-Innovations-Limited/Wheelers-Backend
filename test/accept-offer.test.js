/**
 * The app's accept (ride:accept_offer): a driver's bid that was withdrawn or
 * declined can no longer be booked, the bid row is the price, and two riders
 * cannot take the same driver at once (the claim the WhatsApp accept takes).
 * Against the local Postgres, with a built tree.
 *
 *   node scripts/run-with-env.cjs node --test --test-force-exit test/accept-offer.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

const { prisma, driverBidClient } = require('@wheleers/db');
const { handleRideMessage } = require('../apps/api-gateway/dist/websocket/handlers/ride.handler.js');

const seeded = { users: [], drivers: [], rides: [] };
const published = [];
const publisher = {
  publishRideEvent: async (event) => { published.push(event); },
  publishWalletEvent: async () => undefined,
  publishNotificationEvent: async () => undefined,
};
const memoryRedis = () => {
  const map = new Map();
  return {
    setIfNotExists: async (key, value) => (map.has(key) ? false : (map.set(key, value), true)),
    get: async (key) => map.get(key) ?? null,
    set: async (key, value) => { map.set(key, value); },
    del: async (key) => { map.delete(key); },
  };
};

async function person(role) {
  const user = await prisma.user.create({ data: { privyDid: `did:test:${randomUUID()}`, role, name: `${role} accept` } });
  seeded.users.push(user.id);
  return user;
}

async function onlineDriver() {
  const user = await person('DRIVER');
  const driver = await prisma.driver.create({
    data: { userId: user.id, status: 'ONLINE', lastSeenAt: new Date(), vehicleModel: 'Camry', vehiclePlate: 'KJA482XY' },
  });
  seeded.drivers.push(driver.id);
  return { user, driver };
}

async function searching(riderId) {
  const ride = await prisma.ride.create({
    data: {
      riderId, status: 'MATCHING',
      pickupLat: 6.6018, pickupLng: 3.3515, pickupAddress: '108 Opebi Rd, Ikeja',
      destLat: 6.4969, destLng: 3.3556, destAddress: 'Ijeshatedo, Surulere',
      fareEstimateNgn: 7900, riderOfferNgn: 7900,
    },
  });
  seeded.rides.push(ride.id);
  return ride;
}

const accept = (rider, ride, driver, fare, redis) => handleRideMessage(
  'ride:accept_offer',
  { rideId: ride.id, driverId: driver.driver.id, driverUserId: driver.user.id, agreedFareNgn: fare, paymentMethod: 'wallet_balance' },
  { userId: rider.id, role: 'RIDER' },
  publisher,
  {},
  redis,
);

test.after(async () => {
  await prisma.driverBid.deleteMany({ where: { rideId: { in: seeded.rides } } });
  await prisma.ride.deleteMany({ where: { id: { in: seeded.rides } } });
  await prisma.driver.deleteMany({ where: { id: { in: seeded.drivers } } });
  await prisma.user.deleteMany({ where: { id: { in: seeded.users } } });
  await prisma.$disconnect();
});

test('a bid the driver withdrew (or the rider declined) can no longer be booked', async () => {
  const rider = await person('RIDER');
  const driver = await onlineDriver();
  const ride = await searching(rider.id);
  await driverBidClient.record({ rideId: ride.id, driverId: driver.driver.id, driverUserId: driver.user.id, riderId: rider.id, etaSeconds: 300, amountNgn: 8200 });
  await driverBidClient.markWithdrawn(ride.id, driver.driver.id);
  const answer = await accept(rider, ride, driver, 8200, memoryRedis());
  assert.equal(answer.type, 'ride:accept_offer:rejected');
  assert.equal(answer.payload.reason, 'offer_changed');
  assert.equal(published.filter((e) => e.rideId === ride.id).length, 0, 'nothing booked');
});

test('the open bid is the price, and it must be the price the app showed: a changed offer is refused with the price now, nothing held', async () => {
  const rider = await person('RIDER');
  const driver = await onlineDriver();
  const ride = await searching(rider.id);
  await driverBidClient.record({ rideId: ride.id, driverId: driver.driver.id, driverUserId: driver.user.id, riderId: rider.id, etaSeconds: 300, amountNgn: 9000 });
  // The app still showed ₦7,000: never booked at ₦9,000.
  const answer = await accept(rider, ride, driver, 7000, memoryRedis());
  assert.deepEqual([answer.type, answer.payload.reason, answer.payload.currentFareNgn, answer.payload.driverId], ['ride:accept_offer:rejected', 'offer_changed', 9000, driver.driver.id]);
  assert.equal(await prisma.rideHold.count({ where: { rideId: ride.id } }), 0);
  // At the price shown: on to the wallet (none here), named at the bid's price.
  const atPrice = await accept(rider, ride, driver, 9000, memoryRedis());
  assert.equal(atPrice.payload.reason, 'insufficient_funds');
  assert.equal(atPrice.payload.requiredNgn, 9000);
});

test('a driver another rider is booking at this moment cannot be booked twice', async () => {
  const driver = await onlineDriver();
  const redis = memoryRedis();
  await redis.setIfNotExists(`whatsapp:driver:${driver.driver.id}:accepting`, 'another-ride', 60);
  const rider = await person('RIDER');
  const ride = await searching(rider.id);
  const answer = await accept(rider, ride, driver, 7900, redis);
  assert.equal(answer.type, 'ride:accept_offer:rejected');
  assert.equal(answer.payload.reason, 'driver_unavailable');
});

test('declining one offer tells that driver, and their new price can be booked', async () => {
  const rider = await person('RIDER');
  const driver = await onlineDriver();
  const ride = await searching(rider.id);
  const bid = { rideId: ride.id, driverId: driver.driver.id, driverUserId: driver.user.id, riderId: rider.id, etaSeconds: 300, amountNgn: 8600 };
  await driverBidClient.record(bid);
  const redis = memoryRedis();
  const answer = await handleRideMessage('ride:decline_offer', { rideId: ride.id, driverId: driver.driver.id }, { userId: rider.id, role: 'RIDER' }, publisher, {}, redis);
  assert.equal(answer.payload.declined, true);
  const told = published.find((e) => e.rideId === ride.id && e.eventType === 'RIDE_BIDS_DECLINED');
  assert.deepEqual(told.driverUserIds, [driver.user.id]);
  assert.equal(told.remainingOffers, 0);
  assert.equal((await prisma.driverBid.findFirst({ where: { rideId: ride.id } })).status, 'DECLINED');

  // The driver sends a new price: open again, and it is the price (the old one is refused as changed).
  await driverBidClient.record({ ...bid, amountNgn: 8000 });
  assert.equal((await accept(rider, ride, driver, 8600, redis)).payload.reason, 'offer_changed');
  const again = await accept(rider, ride, driver, 8000, redis);
  assert.equal(again.payload.reason, 'insufficient_funds');
  assert.equal(again.payload.requiredNgn, 8000);
});

test("another rider cannot decline someone else's offer", async () => {
  const owner = await person('RIDER');
  const stranger = await person('RIDER');
  const driver = await onlineDriver();
  const ride = await searching(owner.id);
  await assert.rejects(
    handleRideMessage('ride:decline_offer', { rideId: ride.id, driverId: driver.driver.id }, { userId: stranger.id, role: 'RIDER' }, publisher, {}, memoryRedis()),
    /not yours/,
  );
});
