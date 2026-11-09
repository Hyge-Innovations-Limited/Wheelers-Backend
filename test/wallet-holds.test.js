/**
 * Ride-hold money operations under CONCURRENCY, against a real Postgres.
 *
 * The bug this guards: gateway and wallet-service both release holds on
 * RIDE_CANCELLED; the old read-then-write status check let both apply and
 * riders were refunded twice (lockedNgn went negative in production).
 * Every operation here must be exactly-once no matter how many callers race.
 *
 *   DATABASE_URL=postgresql://postgres:postgres@localhost:55433/wheelers_sandbox \
 *     node --test --test-force-exit test/wallet-holds.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

const { prisma, walletClient } = require('@wheleers/db');
const { calculateRideFees } = require('../packages/config/dist/index.js');

const seeded = { users: [], rides: [] };

async function seedRiderWithWallet(balanceNgn) {
  const user = await prisma.user.create({
    data: { privyDid: `did:test:${randomUUID()}`, role: 'RIDER', name: 'Hold Test Rider' },
  });
  seeded.users.push(user.id);
  const wallet = await prisma.wallet.create({ data: { userId: user.id, balanceNgn } });
  return { user, wallet };
}

async function seedRide(riderId) {
  const ride = await prisma.ride.create({
    data: {
      riderId, status: 'DRIVER_ASSIGNED',
      pickupLat: 6.6, pickupLng: 3.35, pickupAddress: 'Opebi',
      destLat: 6.5, destLng: 3.36, destAddress: 'Surulere',
    },
  });
  seeded.rides.push(ride.id);
  return ride;
}

async function walletState(walletId) {
  const w = await prisma.wallet.findUniqueOrThrow({ where: { id: walletId } });
  return { balance: Number(w.balanceNgn), locked: Number(w.lockedNgn) };
}

test.after(async () => {
  await prisma.transaction.deleteMany({ where: { wallet: { userId: { in: seeded.users } } } });
  await prisma.rideHold.deleteMany({ where: { rideId: { in: seeded.rides } } });
  await prisma.ride.deleteMany({ where: { id: { in: seeded.rides } } });
  await prisma.wallet.deleteMany({ where: { userId: { in: seeded.users } } });
  await prisma.user.deleteMany({ where: { id: { in: seeded.users } } });
  await prisma.$disconnect();
});

test('five concurrent cancels release a hold exactly once', async () => {
  const { user, wallet } = await seedRiderWithWallet(10_000);
  const ride = await seedRide(user.id);
  await walletClient.createRideHold({
    rideId: ride.id, walletId: wallet.id, riderId: user.id, amountNgn: 4_000,
  });
  assert.deepEqual(await walletState(wallet.id), { balance: 6_000, locked: 4_000 });

  const results = await Promise.all(
    Array.from({ length: 5 }, () => walletClient.cancelRideHold(ride.id)),
  );

  const applied = results.filter((r) => r?.applied);
  assert.equal(applied.length, 1, `exactly one release must apply, got ${applied.length}`);
  // THE invariant that was violated in production:
  assert.deepEqual(await walletState(wallet.id), { balance: 10_000, locked: 0 },
    'balance restored once, locked never negative');
});

test('five concurrent settlements pay the driver exactly once', async () => {
  const { user, wallet } = await seedRiderWithWallet(10_000);
  const driver = await prisma.user.create({
    data: { privyDid: `did:test:${randomUUID()}`, role: 'DRIVER', name: 'Hold Test Driver' },
  });
  seeded.users.push(driver.id);
  const ride = await seedRide(user.id);
  await walletClient.createRideHold({
    rideId: ride.id, walletId: wallet.id, riderId: user.id, driverUserId: driver.id, amountNgn: 6_000,
  });

  const results = await Promise.allSettled(
    Array.from({ length: 5 }, () =>
      walletClient.completeRideHoldWithDriverPayout({
        rideId: ride.id, fareNgn: 6_000, driverUserId: driver.id,
      })),
  );

  const succeeded = results.filter((r) => r.status === 'fulfilled' && r.value?.applied);
  assert.equal(succeeded.length, 1, `exactly one settlement must apply, got ${succeeded.length}`);

  assert.deepEqual(await walletState(wallet.id), { balance: 4_000, locked: 0 },
    'rider debited the fare exactly once');
  const driverWallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: driver.id } });
  // The live rate card, so this test checks exactly-once and not a fee formula that has since changed.
  const fees = calculateRideFees(6_000).platformTotalNgn;
  assert.equal(Number(driverWallet.balanceNgn), 6_000 - fees, 'driver credited exactly once');
  const payoutRows = await prisma.transaction.count({
    where: { walletId: driverWallet.id, type: 'DRIVER_PAYOUT', referenceId: ride.id },
  });
  assert.equal(payoutRows, 1, 'one payout transaction row');
});

test('cancel racing settle: exactly one of them wins, money stays consistent', async () => {
  const { user, wallet } = await seedRiderWithWallet(10_000);
  const driver = await prisma.user.create({
    data: { privyDid: `did:test:${randomUUID()}`, role: 'DRIVER', name: 'Race Driver' },
  });
  seeded.users.push(driver.id);
  const ride = await seedRide(user.id);
  await walletClient.createRideHold({
    rideId: ride.id, walletId: wallet.id, riderId: user.id, driverUserId: driver.id, amountNgn: 5_000,
  });

  const [cancelResult, settleResult] = await Promise.allSettled([
    walletClient.cancelRideHold(ride.id),
    walletClient.completeRideHoldWithDriverPayout({ rideId: ride.id, fareNgn: 5_000, driverUserId: driver.id }),
  ]);

  const cancelApplied = cancelResult.status === 'fulfilled' && cancelResult.value?.applied;
  const settleApplied = settleResult.status === 'fulfilled' && settleResult.value?.applied;
  assert.ok(cancelApplied !== settleApplied, 'exactly one of cancel/settle wins — never both, never neither');

  const state = await walletState(wallet.id);
  assert.equal(state.locked, 0, 'no locked residue either way');
  if (cancelApplied) {
    assert.equal(state.balance, 10_000, 'cancel won: full refund');
  } else {
    assert.equal(state.balance, 5_000, 'settle won: fare debited once');
  }
});
