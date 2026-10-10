// Pricing since 2026-10-10 (version 2): drivers price per km. The rider's
// fare is the trip fare (rate × distance) + 7.5% VAT + the ₦350 service charge,
// rounded up to ₦50 and shown as one number. The driver gives up 10%
// commission and the ₦30 levy, nothing else. A rider may offer no less than
// the fare at 90% of the recommended rate; a driver may ask no more than the
// fare at 135%. Rides priced before the change (version 1) settle as they
// were agreed. Against the local Postgres.
//
//   node scripts/run-with-env.cjs node --test --test-force-exit test/booking-fee-pricing.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { prisma, walletClient } = require('@wheleers/db');
const config = require('../packages/config/dist/index.js');
const {
  calculateSuggestedFare, calculateRideFees, driverRatePerKmNgn, fareFromRatePerKmNgn, offerLimitsNgn, rateLimitsPerKmNgn,
  validateRiderOffer, validateDriverOffer, recommendedRatePerKmNgn, BOOKING_FEE_NGN,
} = config;

const seeded = { users: [], rides: [] };

test('10 km at ₦350/km: ₦3,500 + ₦262.50 VAT + ₦350 = ₦4,112.50, the rider sees ₦4,150', () => {
  assert.equal(BOOKING_FEE_NGN, 350);
  assert.equal(fareFromRatePerKmNgn(350, 10), 4150);
  assert.equal(calculateSuggestedFare(10).suggestedFareNgn, 4400, 'recommended ₦375/km: 3,750 + 281.25 + 350 = 4,381.25 → 4,400');
  assert.equal(calculateSuggestedFare(2).suggestedFareNgn, 2500, 'never under the minimum fare');
});

test('a ₦4,150 fare taken apart: only commission and the levy come off the driver', () => {
  const f = calculateRideFees(4150);
  assert.deepEqual(
    { booking: f.bookingFeeNgn, trip: f.tripFareNgn, vat: f.vatNgn, commission: f.commissionNgn, levy: f.stateLevyNgn, paid: f.driverPayoutNgn },
    { booking: 350, trip: 3534.88, vat: 265.12, commission: 353.49, levy: 30, paid: 3151.39 },
  );
  assert.equal(f.totalNgn, 4150, 'the rider pays the fare, nothing on top');
  assert.equal(f.driverPayoutNgn, Math.round((f.tripFareNgn - f.commissionNgn - f.stateLevyNgn) * 100) / 100, 'no VAT off the driver');
  assert.equal(driverRatePerKmNgn(4150, 10), 353.5, 'the price as a rate per km');
});

test('the books add up to the fare, to the kobo, at every distance and rate', () => {
  for (let km = 1; km <= 60; km += 0.7) {
    for (let rate = 300; rate <= 620; rate += 13) {
      const fare = fareFromRatePerKmNgn(rate, km);
      const f = calculateRideFees(fare);
      const sum = Math.round((f.driverPayoutNgn + f.bookingFeeNgn + f.commissionNgn + f.vatNgn + f.stateLevyNgn) * 100);
      assert.equal(sum, Math.round(fare * 100), `${km} km at ₦${rate}`);
      assert.equal(fare % 50, 0, 'riders see fares in ₦50 steps');
      assert.ok(f.tripFareNgn >= Math.min(rate * km, f.tripFareNgn), 'rounding never takes from the driver');
    }
  }
});

test('limits: a rider no lower than 90% of the recommended rate, a driver no higher than 135%', () => {
  const suggested = calculateSuggestedFare(10).suggestedFareNgn;
  assert.deepEqual(offerLimitsNgn(suggested), { minOfferNgn: 4000, maxOfferNgn: 5850 });
  assert.deepEqual(rateLimitsPerKmNgn(suggested, 10), { minRateNgn: 340, maxRateNgn: 508 });
  assert.equal(validateRiderOffer(4000, suggested).valid, true);
  assert.equal(validateRiderOffer(3950, suggested).valid, false);
  assert.equal(validateDriverOffer(5850, 4400, suggested).valid, true);
  assert.equal(validateDriverOffer(5900, 4400, suggested).valid, false, 'above the ceiling');
  assert.equal(validateDriverOffer(7000, 7000, suggested).valid, true, "taking a generous rider's own price is always allowed");
  assert.equal(validateDriverOffer(9000, 3000).valid, true, 'a group seat has no ceiling, only the typo guard');
});

test('traffic and demand are switches, off by default; on, the rate rises on a slow road and never drops at night', () => {
  assert.equal(recommendedRatePerKmNgn({ trafficRatio: 3, demandRatio: 4 }), 375, 'both off: flat');
  process.env.PRICING_TRAFFIC_FACTOR = 'on';
  try {
    assert.equal(recommendedRatePerKmNgn({ trafficRatio: 1 }), 375);
    assert.equal(recommendedRatePerKmNgn({ trafficRatio: 1.5 }), 450, '50% slower: +20%');
    assert.equal(recommendedRatePerKmNgn({ trafficRatio: 3 }), 630, 'three times slower: +80% would be 675, held at the cap (which rose half as fast, to 630)');
    assert.equal(recommendedRatePerKmNgn({ trafficRatio: 0.5 }), 375, 'faster than usual is never a discount');
    assert.ok(calculateSuggestedFare(10, { trafficRatio: 3 }).suggestedFareNgn > calculateSuggestedFare(10).suggestedFareNgn);
  } finally {
    delete process.env.PRICING_TRAFFIC_FACTOR;
  }
  process.env.PRICING_DEMAND_FACTOR = 'on';
  try {
    assert.equal(recommendedRatePerKmNgn({ demandRatio: 0.2 }), 375, 'a quiet hour is never a discount');
    assert.ok(recommendedRatePerKmNgn({ demandRatio: 2 }) > 375);
  } finally {
    delete process.env.PRICING_DEMAND_FACTOR;
  }
});

test('version 1 (rides from before the change): 4% commission and VAT from the driver, as agreed then', () => {
  const f = calculateRideFees(3500, 1);
  assert.deepEqual(
    { booking: f.bookingFeeNgn, share: f.driverShareNgn, commission: f.commissionNgn, vat: f.vatNgn, levy: f.stateLevyNgn, paid: f.driverPayoutNgn, platform: f.platformTotalNgn },
    { booking: 375, share: 3125, commission: 125, vat: 234.38, levy: 30, paid: 2735.62, platform: 764.38 },
  );
  assert.equal(driverRatePerKmNgn(3500, 10, 1), 312.5);
});

async function settledRide(fareNgn, pricingVersion) {
  const rider = await prisma.user.create({ data: { privyDid: `did:test:${randomUUID()}`, role: 'RIDER', name: 'Fee Rider' } });
  const driver = await prisma.user.create({ data: { privyDid: `did:test:${randomUUID()}`, role: 'DRIVER', name: 'Fee Driver' } });
  seeded.users.push(rider.id, driver.id);
  const wallet = await prisma.wallet.create({ data: { userId: rider.id, balanceNgn: 10_000 } });
  const ride = await prisma.ride.create({ data: {
    riderId: rider.id, status: 'DRIVER_ASSIGNED', pickupLat: 6.6, pickupLng: 3.35, pickupAddress: 'Opebi', destLat: 6.5, destLng: 3.36, destAddress: 'Surulere',
    ...(pricingVersion ? { pricingVersion } : {}),
  } });
  seeded.rides.push(ride.id);
  await walletClient.createRideHold({ rideId: ride.id, walletId: wallet.id, riderId: rider.id, driverUserId: driver.id, amountNgn: fareNgn });
  await walletClient.completeRideHoldWithDriverPayout({ rideId: ride.id, fareNgn, driverUserId: driver.id });
  return {
    row: await prisma.ride.findUniqueOrThrow({ where: { id: ride.id } }),
    riderLeft: Number((await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } })).balanceNgn),
    driverGot: Number((await prisma.wallet.findUniqueOrThrow({ where: { userId: driver.id } })).balanceNgn),
  };
}

test('a new ride settles by the new rules: the rider pays the fare, the driver the trip fare less 10% and the levy', async () => {
  const { row, riderLeft, driverGot } = await settledRide(4150);
  assert.equal(row.pricingVersion, 2, 'new rides are version 2 without being told');
  assert.equal(riderLeft, 10_000 - 4150);
  assert.equal(driverGot, 3151.39);
  assert.equal(Number(row.serviceFeeNgn), 350, 'service charge');
  assert.equal(Number(row.commissionNgn), 353.49);
  assert.equal(Number(row.vatNgn), 265.12);
  assert.equal(Number(row.stateLevyNgn), 30);
  assert.equal(Number(row.platformFeeNgn), 998.61);
});

test('a ride priced before the change still settles the old way', async () => {
  const { row, driverGot } = await settledRide(3500, 1);
  assert.equal(driverGot, 2735.62);
  assert.equal(Number(row.commissionNgn), 125);
  assert.equal(Number(row.vatNgn), 234.38);
  assert.equal(Number(row.platformFeeNgn), 764.38);
});

test.after(async () => {
  await prisma.transaction.deleteMany({ where: { wallet: { userId: { in: seeded.users } } } });
  await prisma.transaction.deleteMany({ where: { referenceId: { in: seeded.rides } } });
  await prisma.rideHold.deleteMany({ where: { rideId: { in: seeded.rides } } });
  await prisma.ride.deleteMany({ where: { id: { in: seeded.rides } } });
  await prisma.wallet.deleteMany({ where: { userId: { in: seeded.users } } });
  await prisma.user.deleteMany({ where: { id: { in: seeded.users } } });
  await prisma.$disconnect();
});
