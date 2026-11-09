#!/usr/bin/env node
// Write out what the pricing model learns from: every price Wheelers showed,
// with how it ended.
//
//   node scripts/run-with-env.cjs node scripts/export-pricing-quotes.mjs            # -> ml/pricing/data/real-quotes.csv
//   node scripts/run-with-env.cjs node scripts/export-pricing-quotes.mjs --days 60  # how far back (default 180)
//
// A rider asks for the same trip's price several times in a row (quote, edit,
// confirm). Those are one row here: the last price they saw. It is matched to
// the ride requested for the same two points within half an hour, if there
// was one, and from that:
//
//   requested   a ride was requested after seeing the price
//   answered    a driver bid on it, or was agreed
//   ride        a driver and the rider agreed (a fare was agreed)
//   paid        that agreed fare
//
// A price shown in the last 45 minutes is left out: its ending is not known
// yet. Read-only. The file has no names, phone numbers or addresses: only
// trip length, time, prices and the four answers above.
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { prisma } = require('@wheleers/db');

const SESSION_MS = 30 * 60_000;
const SETTLE_MS = 45 * 60_000;
export const COLUMNS = ['at', 'km', 'minPerKm', 'hour', 'weekend', 'rush', 'night', 'demand', 'marketEst', 'fare', 'fareOverMarket', 'requested', 'answered', 'ride', 'paid', 'setBy'];

const spot = (lat, lng) => `${lat.toFixed(4)},${lng.toFixed(4)}`;

/** One row for each time a rider asked a trip's price, from the quote log and the rides. */
export async function realQuoteRows({ days = 180, now = new Date() } = {}) {
  const since = new Date(now.getTime() - days * 86400_000);
  const [quotes, rides, bids] = await Promise.all([
    prisma.pricingQuote.findMany({ where: { createdAt: { gte: since }, marketFareNgn: { not: null } }, orderBy: { createdAt: 'asc' } }),
    prisma.ride.findMany({
      where: { createdAt: { gte: since } }, orderBy: { createdAt: 'asc' },
      select: { id: true, createdAt: true, pickupLat: true, pickupLng: true, destLat: true, destLng: true, agreedFareNgn: true },
    }),
    prisma.driverBid.groupBy({ by: ['rideId'], where: { createdAt: { gte: since } }, _count: { _all: true } }),
  ]);
  const bidCount = new Map(bids.map((b) => [b.rideId, b._count._all]));
  const ridesAt = new Map();
  for (const ride of rides) {
    const key = `${spot(ride.pickupLat, ride.pickupLng)}>${spot(ride.destLat, ride.destLng)}`;
    if (!ridesAt.has(key)) ridesAt.set(key, []);
    ridesAt.get(key).push({ ...ride, used: false });
  }

  // Quotes for the same two points, each within half an hour of the one before, are one asking.
  const sessions = [];
  const open = new Map();
  for (const q of quotes) {
    const key = `${spot(q.originLat, q.originLng)}>${spot(q.destLat, q.destLng)}`;
    const last = open.get(key);
    if (last && q.createdAt.getTime() - last.lastAt <= SESSION_MS) {
      last.quote = q; last.lastAt = q.createdAt.getTime();
    } else {
      const session = { key, firstAt: q.createdAt.getTime(), lastAt: q.createdAt.getTime(), quote: q };
      open.set(key, session); sessions.push(session);
    }
  }

  const rows = [];
  for (const s of sessions) {
    if (now.getTime() - s.lastAt < SETTLE_MS) continue;
    const ride = (ridesAt.get(s.key) ?? []).find((r) => !r.used && r.createdAt.getTime() >= s.firstAt - 60_000 && r.createdAt.getTime() <= s.lastAt + SESSION_MS);
    if (ride) ride.used = true;
    const q = s.quote;
    const lagos = new Date(q.createdAt.getTime() + 3600_000);
    const hour = lagos.getUTCHours(); const day = lagos.getUTCDay();
    const fare = Number(q.suggestedFareNgn); const market = Number(q.marketFareNgn);
    if (!(q.distanceKm > 0.3) || !(market > 0) || !(fare > 0)) continue;
    const agreed = ride?.agreedFareNgn != null ? Number(ride.agreedFareNgn) : null;
    rows.push({
      at: q.createdAt.toISOString(), km: q.distanceKm, minPerKm: q.durationSeconds / 60 / q.distanceKm, hour,
      weekend: day === 0 || day === 6 ? 1 : 0, rush: q.rush ? 1 : 0, night: hour >= 22 || hour < 5 ? 1 : 0,
      demand: q.demandFactor, marketEst: market, fare, fareOverMarket: fare / market,
      requested: ride ? 1 : 0,
      answered: ride && ((bidCount.get(ride.id) ?? 0) > 0 || agreed !== null) ? 1 : 0,
      ride: agreed !== null ? 1 : 0,
      paid: agreed ?? '',
      setBy: q.setBy,
    });
  }
  return rows;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const days = args.includes('--days') ? Number(args[args.indexOf('--days') + 1]) : 180;
  const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'ml', 'pricing', 'data', 'real-quotes.csv');
  try {
    const rows = await realQuoteRows({ days });
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, [COLUMNS.join(','), ...rows.map((r) => COLUMNS.map((c) => r[c]).join(','))].join('\n') + '\n');
    const count = (name) => rows.filter((r) => r[name] === 1).length;
    console.log(`${rows.length} askings for a price in the last ${days} days: ${count('requested')} requested, ${count('answered')} answered by a driver, ${count('ride')} agreed.`);
    console.log(`${rows.filter((r) => r.setBy === 'trial').length} of them were shown a trial price.`);
    console.log(`Written to ${out}`);
    console.log(rows.length < 60
      ? 'That is too few to learn from yet (60 are needed for a first correction). Run this again in a while.'
      : 'Copy that file to the machine that trains the model, to the same path, and run: python ml/pricing/train.py --real ml/pricing/data/real-quotes.csv');
  } catch (error) {
    console.error(error); process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}
