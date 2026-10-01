// Pricing since 2026-10-01: the ₦375 booking fee is part of the suggested
// fare and Wheelers' first; commission (4%) and VAT (7.5%) are on the
// driver's share; the state levy stays. A settled ride records every line,
// VAT included. Against the local Postgres.
//
//   node scripts/run-with-env.cjs node --test --test-force-exit test/booking-fee-pricing.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { prisma, walletClient } = require('@wheleers/db');
const { calculateSuggestedFare, calculateRideFees, driverRatePerKmNgn, BOOKING_FEE_NGN } = require('../packages/config/dist/index.js');

const seeded = { users: [], rides: [] };

test('10 km: ₦3,750 + ₦375 booking fee = ₦4,125, shown to riders rounded up to ₦4,200', () => {
  assert.equal(BOOKING_FEE_NGN, 375);
  assert.equal(calculateSuggestedFare(10).suggestedFareNgn, 4200);
});

test('the rider sends ₦3,500: driver share ₦3,125 — ₦312.5/km — and every line from it', () => {
  const f = calculateRideFees(3500);
  assert.deepEqual(
    { booking: f.bookingFeeNgn, share: f.driverShareNgn, commission: f.commissionNgn, vat: f.vatNgn, levy: f.stateLevyNgn, paid: f.driverPayoutNgn, platform: f.platformTotalNgn },
    { booking: 375, share: 3125, commission: 125, vat: 234.38, levy: 30, paid: 2735.62, platform: 764.38 },
  );
  assert.equal(f.totalNgn, 3500, 'the rider pays the fare, nothing on top');
  assert.equal(driverRatePerKmNgn(3500, 10), 312.5);
  assert.equal(driverRatePerKmNgn(4000, 10), 362.5, 'it moves with the price');
});

test('a settled ride records booking fee, commission, VAT and levy; the driver is paid the rest', async () => {
  const rider = await prisma.user.create({ data: { privyDid: `did:test:${randomUUID()}`, role: 'RIDER', name: 'Fee Rider' } });
  const driver = await prisma.user.create({ data: { privyDid: `did:test:${randomUUID()}`, role: 'DRIVER', name: 'Fee Driver' } });
  seeded.users.push(rider.id, driver.id);
  const wallet = await prisma.wallet.create({ data: { userId: rider.id, balanceNgn: 10_000 } });
  const ride = await prisma.ride.create({ data: { riderId: rider.id, status: 'DRIVER_ASSIGNED', pickupLat: 6.6, pickupLng: 3.35, pickupAddress: 'Opebi', destLat: 6.5, destLng: 3.36, destAddress: 'Surulere' } });
  seeded.rides.push(ride.id);
  await walletClient.createRideHold({ rideId: ride.id, walletId: wallet.id, riderId: rider.id, driverUserId: driver.id, amountNgn: 3_500 });

  await walletClient.completeRideHoldWithDriverPayout({ rideId: ride.id, fareNgn: 3_500, driverUserId: driver.id });

  const row = await prisma.ride.findUniqueOrThrow({ where: { id: ride.id } });
  assert.equal(Number(row.serviceFeeNgn), 375, 'booking fee');
  assert.equal(Number(row.commissionNgn), 125);
  assert.equal(Number(row.vatNgn), 234.38);
  assert.equal(Number(row.stateLevyNgn), 30);
  assert.equal(Number(row.platformFeeNgn), 764.38);
  const driverWallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: driver.id } });
  assert.equal(Number(driverWallet.balanceNgn), 2735.62);
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
