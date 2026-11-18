import { GROUP_RIDE_LIVE, RIDE, type GroupRideLiveMode } from '@wheleers/config';
import { findGroups, type GroupProposal, type LiveSearch } from './match';

/**
 * The open searches the group-ride service can see, kept from the ride events, and a matching round every
 * few seconds (Timi, 16–17 Nov 2026). One process runs it (the group-ride service is a single pm2 fork),
 * so the list lives in memory and is rebuilt from the database when it starts.
 *
 *   RIDE_REQUESTED                      a search opens (wallet, the route, the People chip, pets)
 *   RIDE_RIDER_COUNTER_OFFER, no driver the rider changed their own price
 *   assigned / cancelled / timed out / started / completed   the search is over
 *
 * GROUP_RIDE_LIVE=dryrun: each round's groups are logged (once per group) and nobody is asked. `onProposal`
 * is where the offer goes when it is switched on (the gateway's part, next).
 */

type RideEvent = { eventType: string; rideId: string; timestamp?: string; [key: string]: unknown };

export interface LiveMatcherDeps {
  mode: GroupRideLiveMode;
  now?: () => number;
  log?: (message: string, details: Record<string, unknown>) => void;
  /** A group to offer (GROUP_RIDE_LIVE=on). */
  onProposal?: (proposal: GroupProposal) => Promise<void>;
}

const CLOSING = new Set(['RIDE_DRIVER_ASSIGNED', 'RIDE_CANCELLED', 'RIDE_BID_TIMEOUT', 'RIDE_STARTED', 'RIDE_COMPLETED']);
/** A search closes this long after the rider last set a price (ride-service's window); kept a little past it. */
const SEARCH_LIFE_MS = (RIDE.BID_TIMEOUT_SECONDS + 30) * 1000;

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const place = (v: unknown) => {
  const p = v as { lat?: unknown; lng?: unknown; address?: unknown } | null;
  const lat = num(p?.lat);
  const lng = num(p?.lng);
  return lat === null || lng === null ? null : { lat, lng, address: typeof p?.address === 'string' ? p.address : '' };
};

/** A RIDE_REQUESTED as a search the matcher can use; null when it cannot be one. */
export function searchFromRequested(event: RideEvent, nowMs: number): (LiveSearch & { priceAtMs: number }) | null {
  const pickup = place(event['pickup']);
  const destination = place(event['destination']);
  const riderId = typeof event['riderId'] === 'string' ? event['riderId'] : null;
  const offerNgn = num(event['riderOfferNgn']);
  if (!pickup || !destination || !riderId || offerNgn === null) return null;
  const stops = Array.isArray(event['stops']) ? event['stops'] : [];
  // A booking with its own stops is not grouped (the stop order would no longer be theirs).
  if (stops.length > 0) return null;
  const route = (event['route'] as { coordinates?: unknown } | undefined)?.coordinates;
  const details = event['tripDetails'] as { passengers?: unknown; pet?: unknown } | undefined;
  const opened = event.timestamp ? Date.parse(event.timestamp) : NaN;
  const openedAtMs = Number.isFinite(opened) ? opened : nowMs;
  return {
    rideId: event.rideId,
    riderId,
    pickup,
    destination,
    route: Array.isArray(route) ? route.map(place).filter((p): p is NonNullable<typeof p> => p !== null).map(({ lat, lng }) => ({ lat, lng })) : [],
    people: num(details?.passengers) ?? 1,
    pet: details?.pet === true,
    paymentMethod: typeof event['paymentMethod'] === 'string' ? event['paymentMethod'] : '',
    offerNgn,
    openedAtMs,
    priceAtMs: openedAtMs,
  };
}

export function createLiveMatcher(deps: LiveMatcherDeps) {
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? ((message, details) => console.log(`[group-ride] ${message}`, details));
  const searches = new Map<string, LiveSearch & { priceAtMs: number }>();
  /** Searches in an offer (or, in dryrun, already logged in a group), until this time. */
  const heldUntil = new Map<string, number>();
  let timer: NodeJS.Timeout | null = null;

  function onRideEvent(event: RideEvent): void {
    if (deps.mode === 'off') return;
    if (event.eventType === 'RIDE_REQUESTED') {
      const search = searchFromRequested(event, now());
      if (search) searches.set(search.rideId, search);
      return;
    }
    if (event.eventType === 'RIDE_RIDER_COUNTER_OFFER' && !event['driverId']) {
      const s = searches.get(event.rideId);
      const price = num(event['counterOfferNgn']);
      if (s && price !== null && price > 0) { s.offerNgn = price; s.priceAtMs = now(); }
      return;
    }
    if (CLOSING.has(event.eventType)) {
      searches.delete(event.rideId);
      heldUntil.delete(event.rideId);
    }
  }

  /** Searches still open when the service starts (from the database). */
  function seed(list: Array<LiveSearch & { priceAtMs?: number }>): void {
    if (deps.mode === 'off') return;
    for (const s of list) searches.set(s.rideId, { ...s, priceAtMs: s.priceAtMs ?? s.openedAtMs });
  }

  /** One matching round: the groups found now (logged in dryrun, offered when on). */
  async function round(): Promise<GroupProposal[]> {
    if (deps.mode === 'off') return [];
    const t = now();
    for (const [id, s] of searches) if (t - s.priceAtMs > SEARCH_LIFE_MS) searches.delete(id);
    for (const [id, until] of heldUntil) if (until <= t) heldUntil.delete(id);
    const groups = findGroups([...searches.values()], new Set(heldUntil.keys()), t);
    for (const g of groups) {
      for (const id of g.rideIds) heldUntil.set(id, t + GROUP_RIDE_LIVE.HOLD_SECONDS * 1000);
      log(deps.mode === 'dryrun' ? 'dryrun: would offer a group ride' : 'offering a group ride', {
        rideIds: g.rideIds,
        riders: g.members.length,
        savedMinutes: Math.round(g.savedSeconds / 60),
        extraMinutes: g.members.map((m) => Math.round(m.extraSeconds / 60)),
        seats: g.members.map((m) => ({ rideId: m.rideId, own: m.offerNgn, seat: m.seatPriceNgn })),
        stops: g.stops.map((s) => `${s.kind === 'pickup' ? 'pick up' : 'drop'} ${s.address || `${s.lat.toFixed(4)},${s.lng.toFixed(4)}`}`),
      });
      if (deps.mode === 'on' && deps.onProposal) {
        await deps.onProposal(g).catch((error) => log('could not offer the group', { rideIds: g.rideIds, error: error instanceof Error ? error.message : String(error) }));
      }
    }
    return groups;
  }

  function start(): void {
    if (deps.mode === 'off' || timer) return;
    timer = setInterval(() => void round().catch(() => undefined), GROUP_RIDE_LIVE.ROUND_SECONDS * 1000);
    timer.unref();
  }

  function stop(): void {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { onRideEvent, seed, round, start, stop, size: () => searches.size };
}
