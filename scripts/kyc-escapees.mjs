#!/usr/bin/env node
/**
 * Drivers who reached the driver dashboard without passing KYC. The app sent
 * a stored driver straight to the dashboard on reopen, without asking the
 * server. Only an admin ever approves a driver, so their KYC status on the
 * server is still PENDING / SUBMITTED / REJECTED. The fixed app takes them
 * back to verification, and the server now refuses to put them online, take
 * their bids or give them interstate trips.
 *
 *   node scripts/run-with-env.cjs node scripts/kyc-escapees.mjs            → list them (changes nothing)
 *   node scripts/run-with-env.cjs node scripts/kyc-escapees.mjs --confirm  → take them off shift
 *
 * --confirm sets them OFFLINE, turns off nearby ride alerts, closes open
 * shifts and withdraws PENDING bids. It never touches a ride in progress or
 * an interstate departure (those have passengers): they are listed for you.
 * Safe to re-run.
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { PrismaClient } = require('@prisma/client');

const CONFIRM = process.argv.includes('--confirm');
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL missing — run through scripts/run-with-env.cjs'); process.exit(1); }
const prisma = new PrismaClient();

const LIVE_RIDE = ['DRIVER_ASSIGNED', 'DRIVER_EN_ROUTE', 'ARRIVED', 'IN_PROGRESS'];
const LIVE_DEPARTURE = ['SCHEDULED', 'FILLING', 'FULL', 'DISPATCHED', 'IN_TRANSIT'];
const mask = (phone) => (phone ? `${String(phone).slice(0, 4)}•••${String(phone).slice(-3)}` : '—');

try {
  const drivers = await prisma.driver.findMany({
    where: { kycStatus: { not: 'APPROVED' } },
    select: {
      id: true, status: true, kycStatus: true, lastSeenAt: true, standbyEnabled: true,
      user: { select: { name: true, phone: true, email: true, createdAt: true } },
    },
  });
  const ids = drivers.map((d) => d.id);
  const [shifts, bids, rides, departures] = await Promise.all([
    prisma.driverShift.groupBy({ by: ['driverId'], where: { driverId: { in: ids } }, _count: { _all: true } }),
    prisma.driverBid.groupBy({ by: ['driverId', 'status'], where: { driverId: { in: ids } }, _count: { _all: true } }),
    prisma.ride.findMany({ where: { driverId: { in: ids } }, select: { id: true, driverId: true, status: true } }),
    prisma.interstateDeparture.findMany({ where: { driverId: { in: ids } }, select: { id: true, driverId: true, status: true, departureAt: true } }),
  ]);
  const count = (rows, id) => rows.filter((r) => r.driverId === id).reduce((n, r) => n + r._count._all, 0);

  const escaped = drivers.map((d) => ({
    ...d,
    shifts: count(shifts, d.id),
    bids: count(bids, d.id),
    pendingBids: count(bids.filter((b) => b.status === 'PENDING'), d.id),
    rides: rides.filter((r) => r.driverId === d.id),
    departures: departures.filter((x) => x.driverId === d.id),
  })).filter((d) => d.status !== 'OFFLINE' || d.lastSeenAt || d.standbyEnabled || d.shifts || d.bids || d.rides.length || d.departures.length);

  console.log(`${drivers.length} driver account(s) not approved; ${escaped.length} of them used the driver side.\n`);
  for (const d of escaped) {
    console.log(`${(d.user.name ?? '(no name)').padEnd(24).slice(0, 24)} ${mask(d.user.phone).padEnd(12)} KYC ${d.kycStatus.padEnd(9)} now ${d.status.padEnd(8)} shifts ${String(d.shifts).padStart(3)}  bids ${String(d.bids).padStart(3)}  rides ${String(d.rides.length).padStart(3)}  interstate ${d.departures.length}`);
  }

  const liveRides = escaped.flatMap((d) => d.rides.filter((r) => LIVE_RIDE.includes(r.status)).map((r) => ({ ...r, name: d.user.name })));
  const liveDepartures = escaped.flatMap((d) => d.departures.filter((x) => LIVE_DEPARTURE.includes(x.status)).map((x) => ({ ...x, name: d.user.name })));
  if (liveRides.length || liveDepartures.length) {
    console.log('\nNeeds a person (not changed by this script):');
    for (const r of liveRides) console.log(`  ride ${r.id}  ${r.status}  driver ${r.name ?? '—'}`);
    for (const x of liveDepartures) console.log(`  interstate departure ${x.id}  ${x.status}  ${x.departureAt.toISOString()}  driver ${x.name ?? '—'}`);
  }

  const done = escaped.filter((d) => d.status === 'OFFLINE' && !d.standbyEnabled && !d.pendingBids);
  const openShifts = await prisma.driverShift.count({ where: { driverId: { in: escaped.map((d) => d.id) }, endedAt: null } });
  console.log(`\nTo do: ${escaped.length - done.length} to take off shift, ${openShifts} open shift(s), ${escaped.reduce((n, d) => n + d.pendingBids, 0)} pending bid(s).`);

  if (!CONFIRM) {
    console.log('Dry run: nothing changed. Add --confirm to take them off shift.');
  } else {
    const target = escaped.map((d) => d.id);
    const now = new Date();
    const [offline, closed, withdrawn] = await prisma.$transaction([
      // A driver on a live ride keeps ON_RIDE until that ride is dealt with.
      prisma.driver.updateMany({ where: { id: { in: target }, kycStatus: { not: 'APPROVED' }, status: 'ONLINE' }, data: { status: 'OFFLINE' } }),
      prisma.driverShift.updateMany({ where: { driverId: { in: target }, endedAt: null }, data: { endedAt: now, endReason: 'kyc-required' } }),
      prisma.driverBid.updateMany({ where: { driverId: { in: target }, status: 'PENDING' }, data: { status: 'WITHDRAWN', resolvedAt: now } }),
    ]);
    const alerts = await prisma.driver.updateMany({ where: { id: { in: target }, kycStatus: { not: 'APPROVED' }, standbyEnabled: true }, data: { standbyEnabled: false, standbyLat: null, standbyLng: null } });
    console.log(`Done: ${offline.count} set offline, ${closed.count} shift(s) closed, ${withdrawn.count} bid(s) withdrawn, ${alerts.count} nearby alert(s) off.`);
    console.log('They go back to verification the next time they open the app (after the OTA).');
  }
} finally {
  await prisma.$disconnect();
}
