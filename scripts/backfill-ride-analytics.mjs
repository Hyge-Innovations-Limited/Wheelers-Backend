#!/usr/bin/env node
/**
 * Fill the analytics facts on rides that were created before they were recorded:
 * the booking channel, the pickup and destination launch zone, and the split of
 * the platform fee into commission, service fee and state levy.
 *
 *   node scripts/run-with-env.cjs node scripts/backfill-ride-analytics.mjs            → dry run: counts only
 *   node scripts/run-with-env.cjs node scripts/backfill-ride-analytics.mjs --confirm  → write
 *   … --only=zones|channel|fees   one part
 *
 * Safe to re-run. It only fills what is missing (channel UNKNOWN, fee split
 * empty) and re-stamps zones from the coordinates, which never change.
 *
 * CHANNEL is inferred, since nothing recorded it:
 *   1. WhatsApp, when an activity event from the bot, its forms, the deposit flow
 *      or the ride page names the ride;
 *   2. WhatsApp, when the rider messaged the bot in the 30 minutes before booking;
 *   3. otherwise the app. Claude (MCP) bookings before today cannot be told
 *      apart from the app and land there.
 *
 * FEE SPLIT: the stored total is split with whichever rate card reproduces it,
 * the current one (4% + ₦375 service + ₦30 levy) or the one before 26 September
 * (7.5% + ₦200 service + ₦30 levy). The three parts always add up to the stored
 * total. Every backfilled split is marked estimated. Needs a built tree.
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { PrismaClient } = require('@prisma/client');
const { zoneFor, splitPlatformTotal } = require('../packages/config/dist/index.js');

const args = Object.fromEntries(process.argv.slice(2).map((raw) => { const [key, value] = raw.replace(/^--/, '').split('='); return [key, value ?? true]; }));
const CONFIRM = args.confirm === true;
const ONLY = typeof args.only === 'string' ? args.only : null;
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL missing — run through scripts/run-with-env.cjs'); process.exit(1); }
const prisma = new PrismaClient();
const wants = (part) => !ONLY || ONLY === part;

const RATE_CARDS = [
  { name: 'current', rate: 0.04, serviceFeeNgn: 375, stateLevyNgn: 30 },
  { name: 'before 26 Sep', rate: 0.075, serviceFeeNgn: 200, stateLevyNgn: 30 },
];
const round2 = (n) => Math.round(n * 100) / 100;
/** The platform total this rate card would have charged on this fare (capped at the fare, as settlement does). */
const totalUnder = (card, fare) => Math.min(fare, round2(fare * card.rate + card.serviceFeeNgn + card.stateLevyNgn));

async function zones() {
  const rides = await prisma.ride.findMany({ select: { id: true, pickupLat: true, pickupLng: true, destLat: true, destLng: true, pickupZone: true, destZone: true } });
  const changes = rides
    .map((r) => ({ id: r.id, pickupZone: zoneFor(r.pickupLat, r.pickupLng), destZone: zoneFor(r.destLat, r.destLng), was: r }))
    .filter((c) => c.pickupZone !== c.was.pickupZone || c.destZone !== c.was.destZone);
  const tally = {};
  for (const c of changes) tally[c.pickupZone ?? 'outside'] = (tally[c.pickupZone ?? 'outside'] ?? 0) + 1;
  console.log(`zones: ${changes.length} of ${rides.length} rides to (re)stamp, by pickup zone:`, tally);
  if (CONFIRM) for (const c of changes) await prisma.ride.update({ where: { id: c.id }, data: { pickupZone: c.pickupZone, destZone: c.destZone } });
}

async function channel() {
  const [fromEvents, fromMessages] = await Promise.all([
    prisma.$queryRawUnsafe(`
      SELECT DISTINCT r.id FROM "Ride" r
      JOIN "UserActivityEvent" e ON e."rideId" = r.id
      WHERE r.channel = 'UNKNOWN' AND e.source IN ('whatsapp', 'whatsapp_form', 'whatsapp_deposit', 'ride_page')`),
    prisma.$queryRawUnsafe(`
      SELECT DISTINCT r.id FROM "Ride" r
      JOIN "WhatsappMessage" m ON m."userId" = r."riderId"
       AND m."createdAt" BETWEEN r."createdAt" - interval '30 minutes' AND r."createdAt" + interval '1 minute'
      WHERE r.channel = 'UNKNOWN'`),
  ]);
  const whatsapp = new Set([...fromEvents, ...fromMessages].map((row) => row.id));
  const unknown = await prisma.ride.findMany({ where: { channel: 'UNKNOWN' }, select: { id: true } });
  const app = unknown.filter((r) => !whatsapp.has(r.id)).map((r) => r.id);
  console.log(`channel: ${unknown.length} rides unlabelled → ${whatsapp.size} WhatsApp (${fromEvents.length} by activity events, the rest by messages just before booking), ${app.length} app`);
  if (CONFIRM) {
    if (whatsapp.size) await prisma.ride.updateMany({ where: { id: { in: [...whatsapp] }, channel: 'UNKNOWN' }, data: { channel: 'WHATSAPP' } });
    if (app.length) await prisma.ride.updateMany({ where: { id: { in: app }, channel: 'UNKNOWN' }, data: { channel: 'APP' } });
  }
}

async function fees() {
  const rides = await prisma.ride.findMany({
    where: { platformFeeNgn: { not: null }, commissionNgn: null },
    select: { id: true, platformFeeNgn: true, fareFinalNgn: true, agreedFareNgn: true, completedAt: true },
  });
  const byCard = {};
  for (const r of rides) {
    const total = Number(r.platformFeeNgn);
    const fare = Number(r.fareFinalNgn ?? r.agreedFareNgn ?? 0);
    // The rate card that reproduces the stored total; if none does (older formulas), the one in force then.
    const card = RATE_CARDS.find((c) => fare > 0 && Math.abs(totalUnder(c, fare) - total) <= 1)
      ?? (r.completedAt && r.completedAt >= new Date('2026-09-26T03:25:00Z') ? RATE_CARDS[0] : RATE_CARDS[1]);
    byCard[card.name] = (byCard[card.name] ?? 0) + 1;
    const split = splitPlatformTotal(total, card);
    if (CONFIRM) await prisma.ride.update({ where: { id: r.id }, data: { ...split, feeSplitEstimated: true } });
  }
  console.log(`fees: ${rides.length} settled rides without a split, by rate card:`, byCard);
}

console.log(CONFIRM ? 'WRITING' : 'DRY RUN (add --confirm to write)');
if (wants('zones')) await zones();
if (wants('channel')) await channel();
if (wants('fees')) await fees();
await prisma.$disconnect();
