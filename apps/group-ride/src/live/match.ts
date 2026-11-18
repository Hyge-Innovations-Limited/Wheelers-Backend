import { GROUP_RIDE_LIVE, groupSeatPriceNgn } from '@wheleers/config';
import { bearingDegrees, haversineKm, headingDeltaDegrees } from '../algorithms/geo';

/**
 * Group ride on live searches (Timi, 16–17 Nov 2026): which riders, searching for a driver right now, could ride
 * together. Pure (no Redis, no network): the live matcher (live-matcher.ts) feeds it the open searches.
 *
 *   1. Shortlist on a map grid: each search's road (its route, else the straight line) is filed under squares
 *      about 700 m wide. Two searches are compared only if one's pickup is near the other's road.
 *   2. Same way: their headings within 40°. Wallet only, 3 people at most, no pets.
 *   3. Fair: for every stop order (each pickup before that rider's drop-off), each rider's time in the car;
 *      no rider spends more than the bigger of 8 min or 25% of their own trip extra. The shortest fair order wins.
 *   4. Worth it: the group drives at least 5 min less than everyone riding alone.
 *   5. Groups of 3 are built from fair pairs, then chosen by driving saved, then by who has waited longest;
 *      a search is in one group at most.
 *
 * Times are estimates at 20 km/h along the longest rider's road (a stop on it costs nothing extra but the way off
 * and back), else the straight line × 1.4; the same measure for riding alone and together, so the comparison is fair.
 */

export type Point = { lat: number; lng: number };
export type Place = Point & { address: string };

export interface LiveSearch {
  rideId: string;
  riderId: string;
  pickup: Place;
  destination: Place;
  /** The planned road, pickup to destination; empty: the straight line. */
  route: Point[];
  /** People travelling on this booking (the People chip; 1 when not said). */
  people: number;
  pet: boolean;
  paymentMethod: string;
  /** The rider's own price now. */
  offerNgn: number;
  /** When the search opened (ms). */
  openedAtMs: number;
}

export type StopKind = 'pickup' | 'dropoff';
export interface PlannedStop extends Place { rideId: string; kind: StopKind }

export interface GroupMember {
  rideId: string;
  riderId: string;
  offerNgn: number;
  seatPriceNgn: number;
  soloSeconds: number;
  inCarSeconds: number;
  extraSeconds: number;
}

export interface GroupProposal {
  rideIds: string[];
  stops: PlannedStop[];
  members: GroupMember[];
  /** Driving from the first pickup to the last drop-off. */
  totalSeconds: number;
  /** Everyone alone, minus together. */
  savedSeconds: number;
}

const R = GROUP_RIDE_LIVE;

/** Estimated driving between two points, in seconds. */
export function driveSeconds(a: Point, b: Point): number {
  return (haversineKm(a, b) * R.ROAD_FACTOR / R.AVERAGE_KMH) * 3600;
}

export function cellKey(p: Point): string {
  return `${Math.floor(p.lat / R.CELL_DEGREES)}:${Math.floor(p.lng / R.CELL_DEGREES)}`;
}

/** The square of `p` and the 8 around it. */
export function nearbyCells(p: Point): string[] {
  const la = Math.floor(p.lat / R.CELL_DEGREES);
  const ln = Math.floor(p.lng / R.CELL_DEGREES);
  const out: string[] = [];
  for (let i = -1; i <= 1; i += 1) for (let j = -1; j <= 1; j += 1) out.push(`${la + i}:${ln + j}`);
  return out;
}

/** The squares a search's road passes through, from points about 200 m apart. */
export function roadCells(search: Pick<LiveSearch, 'pickup' | 'destination' | 'route'>): Set<string> {
  const line = search.route.length >= 2 ? search.route : [search.pickup, search.destination];
  const cells = new Set<string>();
  for (let i = 0; i < line.length; i += 1) {
    const a = line[i]!;
    cells.add(cellKey(a));
    const b = line[i + 1];
    if (!b) continue;
    const metres = haversineKm(a, b) * 1000;
    const steps = Math.min(500, Math.floor(metres / R.SAMPLE_METRES));
    for (let s = 1; s <= steps; s += 1) {
      const t = s / (steps + 1);
      cells.add(cellKey({ lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t }));
    }
  }
  cells.add(cellKey(search.destination));
  return cells;
}

/** Wallet, a real price, room in the car on their own, no pet. */
export function canGroup(s: LiveSearch): boolean {
  return s.paymentMethod === 'WALLET' && s.offerNgn > 0 && s.people >= 1 && s.people < R.MAX_PEOPLE && !s.pet;
}

function sameWay(a: LiveSearch, b: LiveSearch): boolean {
  return headingDeltaDegrees(bearingDegrees(a.pickup, a.destination), bearingDegrees(b.pickup, b.destination)) <= R.MAX_HEADING_DEGREES;
}

function allowedExtra(soloSeconds: number): number {
  return Math.max(R.MAX_EXTRA_MINUTES * 60, R.MAX_EXTRA_SHARE * soloSeconds);
}

/** Every stop order in which each rider is picked up before they are dropped off. */
function stopOrders(members: LiveSearch[]): PlannedStop[][] {
  const out: PlannedStop[][] = [];
  const walk = (seq: PlannedStop[], picked: Set<string>, dropped: Set<string>) => {
    if (seq.length === members.length * 2) { out.push(seq); return; }
    for (const m of members) {
      if (!picked.has(m.rideId)) {
        walk([...seq, { ...m.pickup, rideId: m.rideId, kind: 'pickup' }], new Set([...picked, m.rideId]), dropped);
      } else if (!dropped.has(m.rideId)) {
        walk([...seq, { ...m.destination, rideId: m.rideId, kind: 'dropoff' }], picked, new Set([...dropped, m.rideId]));
      }
    }
  };
  walk([], new Set(), new Set());
  return out;
}

/* ── distances along the road ───────────────────────────────────────────── */

const KM_PER_DEG = 111.32;
const flatKm = (a: Point, b: Point) => {
  const x = (b.lng - a.lng) * KM_PER_DEG * Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180);
  const y = (b.lat - a.lat) * KM_PER_DEG;
  return Math.hypot(x, y);
};

function lineKm(line: Point[]): number {
  let km = 0;
  for (let i = 1; i < line.length; i += 1) km += flatKm(line[i - 1]!, line[i]!);
  return km;
}

/** Where a point sits against a road: how far along it (km from its start) and how far off it (km). */
export function projectOnto(line: Point[], p: Point): { alongKm: number; offKm: number } {
  let best = { alongKm: 0, offKm: Infinity };
  let before = 0;
  for (let i = 1; i < line.length; i += 1) {
    const a = line[i - 1]!;
    const b = line[i]!;
    const seg = flatKm(a, b);
    // Local flat frame around a: x east, y north, in km.
    const cos = Math.cos(a.lat * Math.PI / 180);
    const bx = (b.lng - a.lng) * KM_PER_DEG * cos, by = (b.lat - a.lat) * KM_PER_DEG;
    const px = (p.lng - a.lng) * KM_PER_DEG * cos, py = (p.lat - a.lat) * KM_PER_DEG;
    const t = seg > 0 ? Math.max(0, Math.min(1, (px * bx + py * by) / (seg * seg))) : 0;
    const off = Math.hypot(px - bx * t, py - by * t);
    if (off < best.offKm) best = { alongKm: before + seg * t, offKm: off };
    before += seg;
  }
  return best;
}

/**
 * How a group's driving is measured: along the longest rider's road (the spine). A stop near the spine costs its
 * distance along it plus the way off and back; going back along the spine, or no road at all, is the straight line
 * times 1.4. Each rider alone drives their own road (or the straight line times 1.4 without one).
 */
function groupGeometry(members: LiveSearch[]) {
  const roadOf = (m: LiveSearch) => (m.route.length >= 2 ? m.route : null);
  const spineMember = [...members].sort((x, y) => lineKm(roadOf(y) ?? [y.pickup, y.destination]) - lineKm(roadOf(x) ?? [x.pickup, x.destination]))[0]!;
  const spineRoad = roadOf(spineMember);
  const spine = spineRoad ?? [spineMember.pickup, spineMember.destination];
  const spineFactor = spineRoad ? 1 : R.ROAD_FACTOR;
  const cache = new Map<string, { alongKm: number; offKm: number }>();
  const at = (p: Point) => {
    const key = `${p.lat},${p.lng}`;
    let hit = cache.get(key);
    if (!hit) cache.set(key, (hit = projectOnto(spine, p)));
    return hit;
  };
  const toSeconds = (km: number) => (km / R.AVERAGE_KMH) * 3600;
  return {
    legSeconds(a: Point, b: Point): number {
      const pa = at(a);
      const pb = at(b);
      if (pb.alongKm + 0.2 < pa.alongKm) return driveSeconds(a, b);
      return toSeconds(Math.max(0, pb.alongKm - pa.alongKm) * spineFactor + (pa.offKm + pb.offKm) * R.ROAD_FACTOR);
    },
    soloSeconds(m: LiveSearch): number {
      const road = roadOf(m);
      return road ? toSeconds(lineKm(road)) : driveSeconds(m.pickup, m.destination);
    },
  };
}

/** The best fair way for these riders to ride together, or null when there is none worth it. */
export function planGroup(members: LiveSearch[]): GroupProposal | null {
  if (members.length < 2 || members.length > R.MAX_RIDERS) return null;
  if (!members.every(canGroup)) return null;
  if (members.reduce((n, m) => n + m.people, 0) > R.MAX_PEOPLE) return null;
  for (let i = 0; i < members.length; i += 1) for (let j = i + 1; j < members.length; j += 1) if (!sameWay(members[i]!, members[j]!)) return null;

  const geo = groupGeometry(members);
  const solo = new Map(members.map((m) => [m.rideId, geo.soloSeconds(m)]));
  let best: { stops: PlannedStop[]; total: number; inCar: Map<string, number> } | null = null;
  for (const stops of stopOrders(members)) {
    const at = new Map<string, { on: number; off: number }>();
    let t = 0;
    for (let i = 0; i < stops.length; i += 1) {
      if (i > 0) t += geo.legSeconds(stops[i - 1]!, stops[i]!);
      const s = stops[i]!;
      const mark = at.get(s.rideId) ?? { on: 0, off: 0 };
      if (s.kind === 'pickup') mark.on = t; else mark.off = t;
      at.set(s.rideId, mark);
    }
    const inCar = new Map([...at].map(([id, m]) => [id, m.off - m.on]));
    const fair = members.every((m) => inCar.get(m.rideId)! - solo.get(m.rideId)! <= allowedExtra(solo.get(m.rideId)!) + 1e-6);
    if (fair && (!best || t < best.total)) best = { stops, total: t, inCar };
  }
  if (!best) return null;
  const soloTotal = [...solo.values()].reduce((a, b) => a + b, 0);
  const saved = soloTotal - best.total;
  if (saved < R.MIN_SAVED_MINUTES * 60) return null;

  const order = [...new Set(best.stops.map((s) => s.rideId))];
  const byId = new Map(members.map((m) => [m.rideId, m]));
  return {
    rideIds: order,
    stops: best.stops,
    totalSeconds: Math.round(best.total),
    savedSeconds: Math.round(saved),
    members: order.map((id) => {
      const m = byId.get(id)!;
      const soloS = solo.get(id)!;
      const inCarS = best!.inCar.get(id)!;
      return {
        rideId: id, riderId: m.riderId, offerNgn: m.offerNgn, seatPriceNgn: groupSeatPriceNgn(m.offerNgn),
        soloSeconds: Math.round(soloS), inCarSeconds: Math.round(inCarS), extraSeconds: Math.max(0, Math.round(inCarS - soloS)),
      };
    }),
  };
}

/**
 * The groups to offer now from the open searches: fair pairs from the grid shortlist, groups of 3 where all three
 * pairs are fair, then the most driving saved first (then who has waited longest); each search in one group at most.
 * `held`: searches already in an offer, left out.
 */
export function findGroups(searches: LiveSearch[], held: ReadonlySet<string> = new Set(), nowMs: number = Date.now()): GroupProposal[] {
  const open = searches.filter((s) => canGroup(s) && !held.has(s.rideId));
  const byId = new Map(open.map((s) => [s.rideId, s]));
  // The grid: square -> searches whose road passes through it.
  const onRoad = new Map<string, Set<string>>();
  for (const s of open) for (const c of roadCells(s)) {
    let set = onRoad.get(c);
    if (!set) onRoad.set(c, (set = new Set()));
    set.add(s.rideId);
  }
  // Pairs: one's pickup near the other's road.
  const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const candidates = new Set<string>();
  for (const s of open) {
    for (const c of nearbyCells(s.pickup)) for (const other of onRoad.get(c) ?? []) {
      if (other !== s.rideId && byId.get(other)!.riderId !== s.riderId) candidates.add(pairKey(s.rideId, other));
    }
  }
  const fairPairs = new Map<string, GroupProposal>();
  const links = new Map<string, Set<string>>();
  for (const key of candidates) {
    const [a, b] = key.split('|') as [string, string];
    const plan = planGroup([byId.get(a)!, byId.get(b)!]);
    if (!plan) continue;
    fairPairs.set(key, plan);
    for (const [x, y] of [[a, b], [b, a]] as const) {
      let set = links.get(x);
      if (!set) links.set(x, (set = new Set()));
      set.add(y);
    }
  }
  const options: GroupProposal[] = [...fairPairs.values()];
  for (const [a, linked] of links) for (const b of linked) {
    if (b <= a) continue;
    for (const c of linked) {
      if (c <= b || !links.get(b)?.has(c)) continue;
      const trio = [byId.get(a)!, byId.get(b)!, byId.get(c)!];
      if (new Set(trio.map((t) => t.riderId)).size < 3) continue;
      const plan = planGroup(trio);
      if (plan) options.push(plan);
    }
  }
  const waited = (p: GroupProposal) => Math.max(...p.rideIds.map((id) => nowMs - byId.get(id)!.openedAtMs));
  options.sort((x, y) => y.savedSeconds - x.savedSeconds || waited(y) - waited(x));
  const taken = new Set<string>();
  const chosen: GroupProposal[] = [];
  for (const p of options) {
    if (p.rideIds.some((id) => taken.has(id))) continue;
    p.rideIds.forEach((id) => taken.add(id));
    chosen.push(p);
  }
  return chosen;
}
