import { RIDE } from '@wheleers/config';
import { prisma } from '@wheleers/db';
import type { RedisClient } from '../redis/client';

/**
 * What is happening with a search, said as it is (Timi, 21 Nov 2026). Before, every quiet search ended in "Raise your
 * price", even when no driver was near (more money changes nothing) or drivers were still deciding. Now the rider is
 * told which it is, and a higher price is named only when drivers passed on the price and it is under the usual one.
 * The same facts on the app, the ride page and WhatsApp:
 *
 *   looking    the first seconds: nothing known yet (screens keep "Finding drivers")
 *   none_near  the request reached no driver: "No drivers near you right now"
 *   on_trips   it reached only drivers finishing a trip close by
 *   waiting    drivers have it, no answer yet
 *   passed     most drivers who answered said no, and the price is under the usual one
 *   countered  drivers answered, every price above the rider's
 *   offers     an offer at the rider's price is in: the offers say it all (no line)
 *
 * Kept in Redis beside search-status.ts (both gateway processes see the same):
 *   ride:{rideId}:declined    SET  drivers who said no to this request
 *   ride:{rideId}:finishing   SET  drivers it reached who are finishing a trip
 */

export type SearchSituationKind = 'looking' | 'none_near' | 'on_trips' | 'waiting' | 'passed' | 'countered' | 'offers';

export interface SearchSituation {
  kind: SearchSituationKind;
  /** The one line on screen ("4 drivers have your request"); empty for looking and offers. */
  title: string;
  /** The small line under it. */
  line: string;
  /** If the search closed now, the end screen's title ("4 drivers saw it, none answered."). */
  endTitle: string;
  driversNotified: number;
  declined: number;
  /** What trips like this usually go for (the suggested fare), null when not known. */
  usualNgn: number | null;
  /** passed: a price to offer (between theirs and the usual one); countered: the lowest asked. Else null. */
  suggestNgn: number | null;
  /** Prices for Search again at the end (empty: only the same price makes sense). */
  retryNgn: number[];
}

const KEEP_SECONDS = 2 * 60 * 60;
/** Nothing is said about an empty search in its first seconds: the request is still going out. */
export const LOOKING_MS = 8_000;
const declinedKey = (rideId: string) => `ride:${rideId}:declined`;
const finishingKey = (rideId: string) => `ride:${rideId}:finishing`;
const notifiedKey = (rideId: string) => `ride:${rideId}:notified`;
const closeKey = (rideId: string) => `ride:${rideId}:bids-close-at`;

const naira = (n: number) => `₦${Math.round(n).toLocaleString('en-NG')}`;
const drivers = (n: number) => (n === 1 ? '1 driver' : `${n} drivers`);
const up100 = (n: number) => Math.ceil(n / 100) * 100;

/** A driver said no to the request (declined the card; a card left to lapse is no answer). */
export async function noteDeclined(redis: RedisClient, rideId: string, driverId: string): Promise<void> {
  await redis.send('SADD', declinedKey(rideId), driverId).catch(() => undefined);
  await redis.send('EXPIRE', declinedKey(rideId), String(KEEP_SECONDS)).catch(() => undefined);
}

/** The request reached a driver who is finishing a trip close by (their card says so). */
export async function noteFinishingSent(redis: RedisClient, rideId: string, driverId: string): Promise<void> {
  await redis.send('SADD', finishingKey(rideId), driverId).catch(() => undefined);
  await redis.send('EXPIRE', finishingKey(rideId), String(KEEP_SECONDS)).catch(() => undefined);
}

export interface SituationFacts {
  driversNotified: number;
  finishing: number;
  declined: number;
  offerNgn: number;
  usualNgn: number | null;
  /** The prices of the offers in (a driver's price, or the rider's when they accepted it). */
  asks: number[];
  /** How long the search's clock has run (ms); null when not known. */
  runningMs: number | null;
}

/** The situation from the facts (pure: the screens' tests drive it). */
export function searchSituationFor(f: SituationFacts): SearchSituation {
  const usual = f.usualNgn && f.usualNgn > 0 ? Math.round(f.usualNgn) : null;
  const offer = Math.round(f.offerNgn || 0);
  const under = usual !== null && offer > 0 && offer < usual - 50;
  const base = { driversNotified: f.driversNotified, declined: f.declined, usualNgn: usual, suggestNgn: null as number | null, retryNgn: [] as number[] };
  const asks = f.asks.filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);

  if (asks.length > 0) {
    if (asks[0] <= offer + 0.5) return { ...base, kind: 'offers', title: '', line: '', endTitle: `${asks.length === 1 ? '1 offer' : `${asks.length} offers`} came in.` };
    const lo = asks[0];
    const hi = asks[asks.length - 1];
    const title = `${drivers(asks.length)} asked ${lo === hi ? naira(lo) : `${naira(lo)} – ${naira(hi)}`}`;
    return { ...base, kind: 'countered', title, line: 'Tap one to take it, or match the lowest.', endTitle: `${title}.`, suggestNgn: lo, retryNgn: [lo] };
  }

  if (f.driversNotified <= 0) {
    if (f.runningMs !== null && f.runningMs < LOOKING_MS) return { ...base, kind: 'looking', title: '', line: '', endTitle: 'No drivers came online near you.' };
    return {
      ...base,
      kind: 'none_near',
      title: 'No drivers near you right now',
      line: 'We’ll keep looking and send it to the first driver who comes online near you.',
      endTitle: 'No drivers came online near you.',
    };
  }

  const sawIt = `${drivers(f.driversNotified)} saw it, ${f.driversNotified === 1 ? 'no answer' : 'none answered'}.`;
  if (f.declined >= 2 && f.declined * 2 >= f.driversNotified && under && usual !== null) {
    const suggest = Math.min(usual, Math.max(offer + 100, up100((offer + usual) / 2)));
    const title = `${drivers(f.declined)} passed at ${naira(offer)}`;
    return {
      ...base,
      kind: 'passed',
      title,
      line: `Trips like this usually go for ${naira(usual)}.`,
      endTitle: `${title}.`,
      suggestNgn: suggest,
      retryNgn: [...new Set([suggest, usual])].filter((n) => n > offer),
    };
  }

  if (f.finishing > 0 && f.finishing >= f.driversNotified) {
    return { ...base, kind: 'on_trips', title: 'Drivers near you are on trips', line: 'One finishing close by can take you. We’ve sent it to them.', endTitle: sawIt };
  }

  return {
    ...base,
    kind: 'waiting',
    title: `${drivers(f.driversNotified)} ${f.driversNotified === 1 ? 'has' : 'have'} your request`,
    line: under && usual !== null ? `Trips like this usually go for ${naira(usual)}.` : 'Offers usually come in the first minute or two.',
    endTitle: sawIt,
  };
}

async function count(redis: RedisClient, key: string): Promise<number> {
  const n = await redis.send('SCARD', key).catch(() => 0);
  return typeof n === 'number' ? n : Number(n) || 0;
}

/** The situation of an open search, from Redis (three counts and the clock). */
export async function loadSearchSituation(
  redis: RedisClient,
  rideId: string,
  input: { offerNgn: number; usualNgn: number | null; asks: number[] },
  now = Date.now(),
): Promise<SearchSituation> {
  const [notified, finishing, declined, closes] = await Promise.all([
    count(redis, notifiedKey(rideId)),
    count(redis, finishingKey(rideId)),
    count(redis, declinedKey(rideId)),
    redis.get(closeKey(rideId)).catch(() => null),
  ]);
  const closeAt = closes ? Date.parse(closes) : NaN;
  const runningMs = Number.isFinite(closeAt) ? now - (closeAt - RIDE.BID_TIMEOUT_SECONDS * 1000) : null;
  return searchSituationFor({ driversNotified: notified, finishing, declined, offerNgn: input.offerNgn, usualNgn: input.usualNgn, asks: input.asks, runningMs });
}

/** The same, from the ride's own row and its open offers (any channel: app, ride page, WhatsApp). Null: not found. */
export async function situationForRide(redis: RedisClient, rideId: string, now = Date.now()): Promise<SearchSituation | null> {
  const ride = await prisma.ride.findUnique({
    where: { id: rideId },
    select: { riderOfferNgn: true, bookingSuggestedFareNgn: true, fareEstimateNgn: true, bids: { where: { status: 'PENDING' }, select: { amountNgn: true } } },
  }).catch(() => null);
  if (!ride) return null;
  const usual = Number(ride.bookingSuggestedFareNgn ?? ride.fareEstimateNgn ?? 0) || null;
  return loadSearchSituation(redis, rideId, {
    offerNgn: Number(ride.riderOfferNgn ?? 0),
    usualNgn: usual,
    asks: ride.bids.map((bid) => Number(bid.amountNgn)),
  }, now);
}
