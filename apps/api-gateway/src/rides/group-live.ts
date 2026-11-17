import { GROUP_RIDE_LIVE, groupRideLiveMode } from '@wheleers/config';
import { prisma } from '@wheleers/db';
import type { GroupRideLiveOfferedEvent } from '@wheleers/kafka-schemas';
import type { RedisClient } from '../redis/client';
import { isSearchEnded } from './booking-lock';

/**
 * Group ride on live searches, the offer (Timi, 16-17 Nov 2026). The group-ride service found riders searching
 * right now who could ride together (GROUP_RIDE_LIVE_OFFERED); here they are held, asked, and the group is formed
 * or dropped, once:
 *
 *   hold      each ride is in one offer at a time (Redis SET NX, across every gateway); all members held, or none
 *   ask       each rider, 20 s: Ride together / No thanks (the hook tells their app, ride page or chat)
 *   answer    the first answer of each rider counts (SET NX); a later tap changes nothing
 *   resolve   exactly once (SET NX), when all have answered or the 20 s are up: 2 or more said yes and are still
 *             searching -> formed (the seats stay held for the booking); otherwise every hold is let go and each
 *             search carries on at the rider's own price, untouched
 *
 * Nothing here moves money or books a driver. A gateway that restarts mid-offer loses only its timer: the holds
 * run out on their own and every search goes on as before.
 */

export type GroupAnswer = 'join' | 'decline';

export interface GroupLiveMember {
  rideId: string;
  riderId: string;
  offerNgn: number;
  seatPriceNgn: number;
  soloSeconds: number;
  extraSeconds: number;
}

export interface GroupLiveOffer {
  offerId: string;
  members: GroupLiveMember[];
  stops: Array<{ rideId: string; kind: 'pickup' | 'dropoff'; lat: number; lng: number; address: string }>;
  totalSeconds: number;
  savedSeconds: number;
  createdAt: string;
  expiresAt: string;
}

export type GroupLiveChange =
  | { kind: 'offered'; offer: GroupLiveOffer }
  | { kind: 'answered'; offer: GroupLiveOffer; rideId: string; answer: GroupAnswer }
  | { kind: 'formed'; offer: GroupLiveOffer; joined: GroupLiveMember[] }
  | { kind: 'dropped'; offer: GroupLiveOffer; reason: 'declined' | 'expired' | 'search_moved_on' };

export class GroupLiveError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
  }
}

type Hook = (change: GroupLiveChange) => Promise<void>;
let hook: Hook | undefined;
export function setGroupLiveHook(next: Hook | undefined): void {
  hook = next;
}
function tell(change: GroupLiveChange): void {
  if (!hook) return;
  void hook(change).catch((error) => console.warn('[group-live] could not tell the riders', { offerId: change.offer.offerId, kind: change.kind, error: error instanceof Error ? error.message : String(error) }));
}

const offerKey = (offerId: string) => `gl:offer:${offerId}`;
const holdKey = (rideId: string) => `gl:hold:${rideId}`;
const answerKey = (offerId: string, rideId: string) => `gl:answer:${offerId}:${rideId}`;
const resolvedKey = (offerId: string) => `gl:resolved:${offerId}`;
/** Said No thanks: not asked again during this search. */
const declinedKey = (rideId: string) => `gl:declined:${rideId}`;
/** How many offers a search has had: at most MAX_ASKS. */
const askedKey = (rideId: string) => `gl:asked:${rideId}`;
const MAX_ASKS = 2;
const SEARCH_KEEP_SECONDS = 15 * 60;
/** How long the seats of a formed group stay held while it is booked. */
const FORMED_HOLD_SECONDS = 10 * 60;
const KEEP_SECONDS = 10 * 60;

/** Delete `key` only while it still holds `value` (another offer's hold is never let go by this one). */
async function releaseIfMine(redis: RedisClient, key: string, value: string): Promise<void> {
  const script = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
  const store = redis as RedisClient & { send?: (...args: string[]) => Promise<unknown> };
  if (typeof store.send === 'function') {
    await store.send('EVAL', script, '1', key, value).catch(() => undefined);
    return;
  }
  if ((await redis.get(key).catch(() => null)) === value) await redis.del(key).catch(() => undefined);
}

/** Set `key` to `value` only while it holds `expected` (a formed group takes over its own offer's holds). */
async function swapIfMine(redis: RedisClient, key: string, expected: string, value: string, ttlSeconds: number): Promise<boolean> {
  const script = "if redis.call('get', KEYS[1]) == ARGV[1] then redis.call('set', KEYS[1], ARGV[2], 'EX', ARGV[3]) return 1 else return 0 end";
  const store = redis as RedisClient & { send?: (...args: string[]) => Promise<unknown> };
  if (typeof store.send === 'function') return Number(await store.send('EVAL', script, '1', key, expected, value, String(ttlSeconds)).catch(() => 0)) === 1;
  if ((await redis.get(key).catch(() => null)) !== expected) return false;
  await redis.set(key, value, ttlSeconds);
  return true;
}

async function countAsk(redis: RedisClient, rideId: string): Promise<void> {
  const store = redis as RedisClient & { send?: (...args: string[]) => Promise<unknown> };
  if (typeof store.send === 'function') {
    const n = Number(await store.send('INCR', askedKey(rideId)).catch(() => 0));
    if (n === 1) await store.send('EXPIRE', askedKey(rideId), String(SEARCH_KEEP_SECONDS)).catch(() => undefined);
    return;
  }
  const n = Number(await redis.get(askedKey(rideId)).catch(() => null)) || 0;
  await redis.set(askedKey(rideId), String(n + 1), SEARCH_KEEP_SECONDS).catch(() => undefined);
}

/**
 * Who may be offered a group ride (Timi, 17 Nov 2026): their wallet already covers their seat (so booking never
 * finds it short), and, while GROUP_RIDE_LIVE_PHONES lists test phones, only those phones.
 */
export function onTestList(phone: string | null | undefined, list: string = process.env['GROUP_RIDE_LIVE_PHONES'] ?? ''): boolean {
  const digits = (value: string) => value.replace(/\D/g, '');
  const allowed = list.split(',').map(digits).filter(Boolean);
  if (allowed.length === 0) return true;
  const mine = digits(phone ?? '');
  return mine.length > 0 && allowed.some((p) => p === mine || (p.length >= 10 && mine.endsWith(p.slice(-10))));
}

async function mayBeOffered(member: { riderId: string; seatPriceNgn: number }): Promise<boolean> {
  const user = await prisma.user.findUnique({ where: { id: member.riderId }, select: { phone: true, wallet: { select: { balanceNgn: true } } } }).catch(() => null);
  if (!user || !onTestList(user.phone)) return false;
  return Number(user.wallet?.balanceNgn ?? 0) >= member.seatPriceNgn;
}

/** Still searching for a driver, the rider's own, by wallet, no stops of its own. */
async function stillSearching(redis: RedisClient, member: { rideId: string; riderId: string }): Promise<boolean> {
  const ride = await prisma.ride.findUnique({
    where: { id: member.rideId },
    select: { riderId: true, status: true, driverId: true, paymentMethod: true, _count: { select: { routeStops: { where: { type: 'INTERMEDIATE' } } } } },
  }).catch(() => null);
  if (!ride || ride.riderId !== member.riderId || ride.driverId) return false;
  if (String(ride.status) !== 'REQUESTED' && String(ride.status) !== 'MATCHING') return false;
  if (String(ride.paymentMethod) !== 'WALLET' || ride._count.routeStops > 0) return false;
  return !(await isSearchEnded(redis, member.rideId).catch(() => false));
}

export async function readOffer(redis: RedisClient, offerId: string): Promise<GroupLiveOffer | null> {
  const raw = await redis.get(offerKey(offerId)).catch(() => null);
  if (!raw) return null;
  try { return JSON.parse(raw) as GroupLiveOffer; } catch { return null; }
}

/** The offer a ride is in now (not a formed group), or null. */
export async function offerForRide(redis: RedisClient, rideId: string): Promise<GroupLiveOffer | null> {
  const held = await redis.get(holdKey(rideId)).catch(() => null);
  if (!held || held.startsWith('group:')) return null;
  return readOffer(redis, held);
}

export async function answerOf(redis: RedisClient, offerId: string, rideId: string): Promise<GroupAnswer | null> {
  const raw = await redis.get(answerKey(offerId, rideId)).catch(() => null);
  return raw === 'join' || raw === 'decline' ? raw : null;
}

/**
 * A group the matcher found. Every member's search is checked and held, or none is (the stops and prices were
 * planned for all of them). Returns the offer asked, or null when it was dropped before anyone was asked.
 */
export async function receiveGroupOffer(
  redis: RedisClient,
  event: GroupRideLiveOfferedEvent,
  opts: { now?: () => number; schedule?: (fn: () => void, ms: number) => void } = {},
): Promise<GroupLiveOffer | null> {
  if (groupRideLiveMode() !== 'on') return null;
  const now = opts.now ?? Date.now;
  const offerId = event.groupId;
  // A rider who said No thanks is not asked again during this search; nobody is asked more than twice.
  for (const member of event.members) {
    if (await redis.get(declinedKey(member.rideId)).catch(() => null)) return null;
    if ((Number(await redis.get(askedKey(member.rideId)).catch(() => null)) || 0) >= MAX_ASKS) return null;
  }
  const held: string[] = [];
  for (const member of event.members) {
    const ok = (await stillSearching(redis, member)) && (await mayBeOffered(member)) && (await redis.setIfNotExists(holdKey(member.rideId), offerId, GROUP_RIDE_LIVE.HOLD_SECONDS).catch(() => false));
    if (!ok) {
      for (const rideId of held) await releaseIfMine(redis, holdKey(rideId), offerId);
      return null;
    }
    held.push(member.rideId);
  }
  for (const member of event.members) await countAsk(redis, member.rideId);
  const at = now();
  const offer: GroupLiveOffer = {
    offerId,
    members: event.members,
    stops: event.stops,
    totalSeconds: event.totalSeconds,
    savedSeconds: event.savedSeconds,
    createdAt: new Date(at).toISOString(),
    expiresAt: new Date(at + GROUP_RIDE_LIVE.OFFER_SECONDS * 1000).toISOString(),
  };
  await redis.set(offerKey(offerId), JSON.stringify(offer), KEEP_SECONDS);
  tell({ kind: 'offered', offer });
  // The 20 s are up (plus a moment for a late tap in flight): decided. A restart loses only this timer.
  const schedule = opts.schedule ?? ((fn, ms) => { setTimeout(fn, ms).unref(); });
  schedule(() => void resolveGroupOffer(redis, offerId, { now }).catch(() => undefined), GROUP_RIDE_LIVE.OFFER_SECONDS * 1000 + 1500);
  return offer;
}

/** A rider's answer. The first counts; the same answer again is fine; a different one later is refused. */
export async function answerGroupOffer(
  redis: RedisClient,
  rideId: string,
  userId: string,
  answer: GroupAnswer,
  opts: { now?: () => number } = {},
): Promise<{ offer: GroupLiveOffer; answer: GroupAnswer }> {
  const now = opts.now ?? Date.now;
  const offer = await offerForRide(redis, rideId);
  const member = offer?.members.find((m) => m.rideId === rideId);
  if (!offer || !member) throw new GroupLiveError('This group ride is no longer on offer.', 409, 'NO_OFFER');
  if (member.riderId !== userId) throw new GroupLiveError('This is not your ride.', 403, 'NOT_YOURS');
  if (now() > Date.parse(offer.expiresAt)) throw new GroupLiveError('Too late: the group ride offer has ended.', 409, 'EXPIRED');
  const first = await redis.setIfNotExists(answerKey(offer.offerId, rideId), answer, KEEP_SECONDS);
  const kept = first ? answer : await answerOf(redis, offer.offerId, rideId);
  if (kept !== answer) throw new GroupLiveError(kept === 'join' ? 'You already said Ride together.' : 'You already said No thanks.', 409, 'ANSWERED');
  if (first) {
    if (answer === 'decline') await redis.set(declinedKey(rideId), '1', SEARCH_KEEP_SECONDS).catch(() => undefined);
    tell({ kind: 'answered', offer, rideId, answer });
    // A pair with one No, or everyone answered: decided now, not at the 20 s.
    const answers = await Promise.all(offer.members.map((m) => answerOf(redis, offer.offerId, m.rideId)));
    const declined = answers.filter((a) => a === 'decline').length;
    if (answers.every((a) => a !== null) || offer.members.length - declined < 2) await resolveGroupOffer(redis, offer.offerId, { now });
  }
  return { offer, answer };
}

/**
 * Decided once (whichever gateway gets here first). Formed: those who said yes and are still searching, 2 or more;
 * their holds become the group's. Otherwise every hold of this offer is let go.
 */
export async function resolveGroupOffer(redis: RedisClient, offerId: string, opts: { now?: () => number } = {}): Promise<GroupLiveChange | null> {
  const now = opts.now ?? Date.now;
  const offer = await readOffer(redis, offerId);
  if (!offer) return null;
  const answers = await Promise.all(offer.members.map((m) => answerOf(redis, offerId, m.rideId)));
  const allAnswered = answers.every((a) => a !== null);
  const declined = answers.filter((a) => a === 'decline').length;
  // Not yet: still time and still possible.
  if (!allAnswered && now() <= Date.parse(offer.expiresAt) && offer.members.length - declined >= 2) return null;
  if (!(await redis.setIfNotExists(resolvedKey(offerId), '1', KEEP_SECONDS).catch(() => false))) return null;

  const saidYes = offer.members.filter((_, i) => answers[i] === 'join');
  const joined: GroupLiveMember[] = [];
  for (const m of saidYes) if (await stillSearching(redis, m)) joined.push(m);
  let change: GroupLiveChange;
  if (joined.length >= 2) {
    const groupHold = `group:${offerId}`;
    const taken: string[] = [];
    for (const m of joined) if (await swapIfMine(redis, holdKey(m.rideId), offerId, groupHold, FORMED_HOLD_SECONDS)) taken.push(m.rideId);
    if (taken.length >= 2) {
      const members = joined.filter((m) => taken.includes(m.rideId));
      change = { kind: 'formed', offer, joined: members };
    } else {
      for (const rideId of taken) await releaseIfMine(redis, holdKey(rideId), groupHold);
      change = { kind: 'dropped', offer, reason: 'search_moved_on' };
    }
  } else {
    change = { kind: 'dropped', offer, reason: saidYes.length >= 2 ? 'search_moved_on' : declined > 0 ? 'declined' : 'expired' };
  }
  // Everyone not in the formed group is free again.
  const inGroup = new Set(change.kind === 'formed' ? change.joined.map((m) => m.rideId) : []);
  for (const m of offer.members) if (!inGroup.has(m.rideId)) await releaseIfMine(redis, holdKey(m.rideId), offerId);
  tell(change);
  return change;
}

/** What one rider sees of the offer (their seat, the others' pickups, the time left, their answer). */
export async function offerViewFor(redis: RedisClient, offer: GroupLiveOffer, rideId: string, names: Map<string, string> = new Map()) {
  const me = offer.members.find((m) => m.rideId === rideId);
  if (!me) return null;
  const pickupOf = (id: string) => offer.stops.find((s) => s.rideId === id && s.kind === 'pickup')?.address.split(',')[0]?.trim() ?? '';
  const answers = await Promise.all(offer.members.map((m) => answerOf(redis, offer.offerId, m.rideId)));
  return {
    offerId: offer.offerId,
    expiresAt: offer.expiresAt,
    ownPriceNgn: me.offerNgn,
    seatPriceNgn: me.seatPriceNgn,
    savedNgn: Math.max(0, me.offerNgn - me.seatPriceNgn),
    extraMinutes: Math.max(1, Math.round(me.extraSeconds / 60)),
    people: offer.members.length,
    answer: answers[offer.members.indexOf(me)] ?? null,
    riders: offer.members.map((m, i) => ({
      you: m.rideId === rideId,
      name: m.rideId === rideId ? 'You' : names.get(m.riderId) ?? 'Rider',
      pickup: pickupOf(m.rideId),
      answer: answers[i] ?? null,
    })),
    stops: offer.stops.map((s) => ({ kind: s.kind, address: s.address, you: s.rideId === rideId })),
  };
}
