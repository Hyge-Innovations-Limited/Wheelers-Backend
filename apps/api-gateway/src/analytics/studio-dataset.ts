import { prisma, NOT_GROUP_TRIP } from '@wheleers/db';
import { LAUNCH_ZONES, formatTripId } from '@wheleers/config';
import { phoneName, phoneTier, platformLabel, signalLabel } from './phone-models';

/**
 * The Analytics Studio's dataset from real rows (Timi, 18 Nov 2026), in the shape of the Studio page's contract
 * (Wheelers-Frontend lib/studio/schema.ts, StudioDataset; keep the two in step). One session = one ride request; an
 * intent links a rider's retries for the same trip (the next request within 30 minutes to within 300 m of the same
 * drop-off). What we do not record yet is null and named in `notRecorded`, so the page says "Not recorded yet"
 * instead of showing a zero as if it were a fact. No names, phones or addresses: ids are trip ids and short ids.
 *
 * Pings come as compact rows (there are many): [sessionId, driverRating, action, riderVsSuggestedPct, bidVsSuggestedPct,
 * driverPlatform, driverPhoneTier].
 *
 * Devices (Timi, 20 Nov 2026): each request carries the rider's device it came from (Ride.deviceId since 20 Nov;
 * before that the newest device of that kind they had then, deviceRecorded false), each offer the driver's phone, and
 * `devices` is one row per device in them: what it is, how often seen, requests and trips from it.
 */

type Outcome = 'Completed' | 'Cancelled after match' | 'Rider cancelled' | 'Search timed out' | 'Left before search';
type PingAction = 'Countered' | 'Took rider price' | 'Declined' | 'No answer';
type PayMethod = 'Wallet' | 'Cash' | 'Stellar (XLM)';

export interface StudioDatasetLive {
  source: 'live';
  from: string;
  to: string;
  zones: string[];
  notRecorded: string[];
  sessions: Array<Record<string, unknown>>;
  offers: Array<Record<string, unknown>>;
  pingRows: Array<[string, number | null, PingAction, number | null, number | null, string, string]>;
  devices: Array<Record<string, unknown>>;
  priceChanges: Array<{ sessionId: string; direction: 'Raise' | 'Drop'; fromNgn: number; toNgn: number; trigger: string }>;
  payments: Array<{ sessionId: string; date: string; method: PayMethod; success: boolean; amountNgn: number }>;
  shifts: Array<{ date: string; onlineHours: number; tripHours: number }>;
  ledger: Array<{ date: string; type: string; amountNgn: number }>;
}

/** What the Studio shows that is not recorded yet (the page labels these charts). */
export const NOT_RECORDED = [
  'riderType', 'variant', 'onboardedWithPromo', 'abandonStage', 'processorFeeNgn', 'messagingCostNgn', 'profileViewed',
  'pingDelivered', 'pingSeen', 'declineReason', 'carOwnership', 'lastTripEnd', 'paymentFailures', 'promo',
];

const LAGOS_MS = 60 * 60 * 1000;
const lagos = (d: Date) => new Date(d.getTime() + LAGOS_MS);
const dayOf = (d: Date) => lagos(d).toISOString().slice(0, 10);
const hourOf = (d: Date) => lagos(d).getUTCHours();
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const weekdayOf = (d: Date) => WEEKDAYS[(lagos(d).getUTCDay() + 6) % 7];
const dayPartOf = (h: number) => (h <= 5 ? 'Night 00–05' : h <= 9 ? 'Morning 06–09' : h <= 15 ? 'Midday 10–15' : h <= 19 ? 'Evening 16–19' : 'Night 20–23');
const fareSizeOf = (n: number) => (n < 3000 ? 'Under ₦3k' : n < 5000 ? '₦3–5k' : n < 10000 ? '₦5–10k' : n < 15000 ? '₦10–15k' : '₦15k+');
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const secs = (a: Date | null | undefined, b: Date | null | undefined) => (a && b ? Math.max(0, Math.round((b.getTime() - a.getTime()) / 1000)) : null);
const pct1 = (a: number, b: number) => (b > 0 ? Math.round(((a / b) - 1) * 1000) / 10 : null);
const CHANNEL: Record<string, string> = { APP: 'App', WHATSAPP: 'WhatsApp', MCP: 'Claude', UNKNOWN: 'Unknown' };
const METHOD: Record<string, PayMethod> = { WALLET: 'Wallet', CASH: 'Cash', XLM: 'Stellar (XLM)' };
const RAIN: Record<string, string> = { none: 'Clear', light: 'Light rain', heavy: 'Heavy rain' };
const zoneName = (z: string | null) => (z && z !== 'outside' ? z : 'Outside zones');
const FUEL_PER_KM = 120;

function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const r = (x: number) => (x * Math.PI) / 180;
  const h = Math.sin(r(bLat - aLat) / 2) ** 2 + Math.cos(r(aLat)) * Math.cos(r(bLat)) * Math.sin(r(bLng - aLng) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

function outcomeOf(r: { status: string; driverId: string | null; cancelledBy: string | null; cancelReason: string | null }): Outcome | null {
  if (r.status === 'COMPLETED' || r.status === 'DISPUTED') return 'Completed';
  if (r.status !== 'CANCELLED') return null; // still searching or on a trip: not finished, left out
  if (r.driverId) return 'Cancelled after match';
  if (r.cancelledBy === 'rider') return 'Rider cancelled';
  return 'Search timed out';
}

export async function buildStudioDataset(f: { from: string; to: string }): Promise<StudioDatasetLive> {
  const start = new Date(Date.parse(`${f.from}T00:00:00+01:00`));
  const end = new Date(Date.parse(`${f.to}T00:00:00+01:00`) + 86_400_000);

  const rides = await prisma.ride.findMany({
    where: { createdAt: { gte: start, lt: end }, ...NOT_GROUP_TRIP, groupRole: null },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true, tripNumber: true, riderId: true, driverId: true, status: true, paymentMethod: true, channel: true,
      pickupLat: true, pickupLng: true, destLat: true, destLng: true, pickupZone: true, destZone: true,
      fareEstimateNgn: true, bookingSuggestedFareNgn: true, firstRiderOfferNgn: true, riderOfferNgn: true, riderOfferChanges: true,
      agreedFareNgn: true, fareFinalNgn: true, serviceFeeNgn: true, commissionNgn: true, whatsappFeeNgn: true,
      distanceKm: true, plannedDistanceKm: true, driversFoundAtSearch: true, deviceId: true,
      cancelReason: true, cancelledBy: true, createdAt: true, matchedAt: true, arrivedAt: true, startedAt: true, completedAt: true, cancelledAt: true,
    },
  });
  const rideIds = rides.map((r) => r.id);
  const riderIds = [...new Set(rides.map((r) => r.riderId))];

  const [bids, pings, changes, feedback, weather, firstRides, walletPays, shifts] = await Promise.all([
    prisma.driverBid.findMany({ where: { rideId: { in: rideIds } }, orderBy: { createdAt: 'asc' }, select: { id: true, rideId: true, driverId: true, amountNgn: true, etaSeconds: true, distanceKm: true, status: true, createdAt: true, resolvedAt: true, deviceId: true } }),
    prisma.searchPing.findMany({ where: { rideId: { in: rideIds } }, select: { rideId: true, driverId: true, round: true, response: true } }),
    prisma.ridePriceChange.findMany({ where: { rideId: { in: rideIds } }, orderBy: { at: 'asc' } }),
    prisma.feedback.findMany({ where: { rideId: { in: rideIds }, reviewerRole: 'RIDER' }, select: { rideId: true, rating: true } }),
    prisma.weatherReading.findMany({ where: { at: { gte: new Date(start.getTime() - 3 * 3600_000), lt: end } }, orderBy: { at: 'asc' }, select: { zone: true, at: true, rain: true } }),
    prisma.ride.findMany({ where: { riderId: { in: riderIds } }, distinct: ['riderId'], orderBy: { createdAt: 'asc' }, select: { riderId: true, channel: true } }),
    prisma.transaction.findMany({ where: { referenceId: { in: rideIds }, type: 'RIDE_PAYMENT', direction: 'DEBIT' }, select: { referenceId: true, amountNgn: true, createdAt: true } }),
    prisma.driverShift.findMany({ where: { startedAt: { gte: start, lt: end } }, select: { startedAt: true, endedAt: true } }),
  ]);
  const driverIds = [...new Set([...bids.map((b) => b.driverId), ...pings.map((p) => p.driverId)])];
  const drivers = await prisma.driver.findMany({ where: { id: { in: driverIds } }, select: { id: true, rating: true, userId: true } });
  const ratingOf = new Map(drivers.map((d) => [d.id, d.rating === null ? null : Number(d.rating)]));
  const userOfDriver = new Map(drivers.map((d) => [d.id, d.userId]));

  // Devices: every device of these riders and drivers.
  const userDevices = await prisma.userDevice.findMany({ where: { userId: { in: [...riderIds, ...drivers.map((d) => d.userId)] } } });
  type Device = (typeof userDevices)[number];
  const deviceById = new Map(userDevices.map((d) => [d.id, d]));
  const devicesOf = new Map<string, Device[]>();
  for (const d of userDevices) devicesOf.set(d.userId, [...(devicesOf.get(d.userId) ?? []), d]);
  const whatsappRowOf = (userId: string) => devicesOf.get(userId)?.find((d) => d.source === 'whatsapp') ?? null;
  /** The device used: the one recorded, else the newest of that kind the person had by then (an estimate). */
  const deviceUsed = (recordedId: string | null, userId: string | undefined, sources: string[], at: Date): { device: Device | null; recorded: boolean } => {
    const recorded = recordedId ? deviceById.get(recordedId) ?? null : null;
    if (recorded) return { device: recorded, recorded: true };
    for (const source of sources) {
      const mine = (userId ? devicesOf.get(userId) ?? [] : []).filter((d) => d.source === source);
      const byThen = mine.filter((d) => d.firstSeenAt <= at).sort((a, b) => b.firstSeenAt.getTime() - a.firstSeenAt.getTime())[0];
      const any = byThen ?? mine.sort((a, b) => a.firstSeenAt.getTime() - b.firstSeenAt.getTime())[0];
      if (any) return { device: any, recorded: false };
    }
    return { device: null, recorded: false };
  };
  const sourcesFor = (channel: string) => (channel === 'APP' ? ['app'] : channel === 'WHATSAPP' ? ['web', 'whatsapp'] : []);
  const shortId = (id: string | null | undefined) => (id ? id.slice(0, 8) : null);
  const deviceCols = (d: Device | null) => ({
    platform: platformLabel(d),
    phoneMaker: d?.maker ?? null,
    phoneModel: d ? phoneName(d.model, d.maker) : null,
    phoneTier: d ? phoneTier(d) : 'Unknown',
    signal: signalLabel(d?.network),
    appVersion: d?.appVersion ?? null,
    browser: d?.browser ?? null,
  });
  const deviceUse = new Map<string, { owner: 'Rider' | 'Driver'; requests: number; completed: number; bids: number }>();
  const used = (d: Device | null, owner: 'Rider' | 'Driver', add: { requests?: number; completed?: number; bids?: number }) => {
    if (!d) return;
    const u = deviceUse.get(d.id) ?? { owner, requests: 0, completed: 0, bids: 0 };
    u.requests += add.requests ?? 0;
    u.completed += add.completed ?? 0;
    u.bids += add.bids ?? 0;
    deviceUse.set(d.id, u);
  };

  const group = <T extends { rideId: string }>(rows: T[]) => {
    const m = new Map<string, T[]>();
    for (const x of rows) m.set(x.rideId, [...(m.get(x.rideId) ?? []), x]);
    return m;
  };
  const bidsBy = group(bids);
  const pingsBy = group(pings);
  const changesBy = group(changes);
  const ratingBy = new Map(feedback.map((x) => [x.rideId, x.rating]));
  const joinedVia = new Map(firstRides.map((x) => [x.riderId, CHANNEL[x.channel] ?? 'Unknown']));
  const weatherAt = (zone: string | null, when: Date) => {
    let last: (typeof weather)[number] | null = null;
    for (const w of weather) {
      if (w.at > when) break;
      if ((!zone || w.zone === zone) && when.getTime() - w.at.getTime() <= 3 * 3600_000) last = w;
    }
    return last ? RAIN[last.rain] ?? 'Clear' : 'Clear';
  };

  // Retries: the same rider asking again within 30 minutes for (nearly) the same drop-off joins the earlier intent.
  const intentOf = new Map<string, { id: string; attempt: number; firstAt: Date }>();
  const lastByRider = new Map<string, (typeof rides)[number]>();
  for (const r of rides) {
    const prev = lastByRider.get(r.riderId);
    const prevEnd = prev ? prev.cancelledAt ?? prev.completedAt ?? prev.createdAt : null;
    const retry = prev && prev.status === 'CANCELLED' && !prev.driverId && prevEnd && r.createdAt.getTime() - prevEnd.getTime() <= 30 * 60_000
      && haversineKm(prev.destLat, prev.destLng, r.destLat, r.destLng) <= 0.3;
    const parent = retry && prev ? intentOf.get(prev.id)! : null;
    intentOf.set(r.id, parent ? { id: parent.id, attempt: parent.attempt + 1, firstAt: parent.firstAt } : { id: formatTripId(r.tripNumber) ?? r.id, attempt: 1, firstAt: r.createdAt });
    lastByRider.set(r.riderId, r);
  }

  const sessions: StudioDatasetLive['sessions'] = [];
  const offers: StudioDatasetLive['offers'] = [];
  const pingRows: StudioDatasetLive['pingRows'] = [];
  const priceChanges: StudioDatasetLive['priceChanges'] = [];
  const payments: StudioDatasetLive['payments'] = [];
  const paidBy = new Map(walletPays.map((t) => [t.referenceId, t]));

  for (const r of rides) {
    const outcome = outcomeOf(r);
    if (!outcome) continue;
    const id = formatTripId(r.tripNumber) ?? r.id.slice(0, 8);
    const date = dayOf(r.createdAt);
    const hour = hourOf(r.createdAt);
    const suggested = num(r.bookingSuggestedFareNgn) ?? num(r.fareEstimateNgn) ?? 0;
    const opening = num(r.firstRiderOfferNgn) ?? num(r.riderOfferNgn);
    const final = num(r.riderOfferNgn);
    const agreed = num(r.agreedFareNgn);
    const km = Math.round((r.plannedDistanceKm ?? r.distanceKm ?? haversineKm(r.pickupLat, r.pickupLng, r.destLat, r.destLng)) * 10) / 10;
    const rideBids = bidsBy.get(r.id) ?? [];
    const rideChanges = changesBy.get(r.id) ?? [];
    const ridePings = pingsBy.get(r.id) ?? [];
    const accepted = rideBids.find((b) => b.status === 'ACCEPTED') ?? null;
    const acceptAt = accepted?.resolvedAt ?? r.matchedAt ?? null;
    // On the rider's screen when they accepted: offers made before it and not ended before it.
    const onScreen = acceptAt ? rideBids.filter((b) => b.createdAt <= acceptAt && (!b.resolvedAt || b.resolvedAt >= acceptAt)) : [];
    const sorted = [...onScreen].sort((a, b) => Number(a.amountNgn) - Number(b.amountNgn));
    const intent = intentOf.get(r.id)!;
    // The rider's price at a moment: the last change before it, else the opening.
    const priceAt = (when: Date) => {
      let p = opening ?? final ?? 0;
      for (const c of rideChanges) if (c.at <= when) p = c.toNgn;
      return p;
    };
    const roundAt = (when: Date) => 1 + rideChanges.filter((c) => c.at <= when).length;
    const roundStart = (when: Date) => rideChanges.filter((c) => c.at <= when).at(-1)?.at ?? r.createdAt;

    for (const b of rideBids) {
      const price = Number(b.amountNgn);
      const phone = deviceUsed(b.deviceId, userOfDriver.get(b.driverId), ['app'], b.createdAt);
      used(phone.device, 'Driver', { bids: 1 });
      const dc = deviceCols(phone.device);
      const riderPrice = priceAt(b.createdAt);
      const pos = sorted.findIndex((x) => x.id === b.id);
      const status = b.status === 'ACCEPTED' ? 'Accepted' : b.status === 'DECLINED' ? 'Rejected' : b.status === 'LOST' ? 'Lost to other driver'
        : b.status === 'WITHDRAWN' ? 'Withdrawn' : b.status === 'CANCELLED' && outcome === 'Search timed out' ? 'Search timed out' : 'Expired';
      offers.push({
        id: b.id.slice(0, 8), sessionId: id, driverId: b.driverId.slice(0, 8), priceNgn: price, riderPriceNgn: riderPrice,
        gapToRiderPct: pct1(price, riderPrice) ?? 0, gapToSuggestedPct: pct1(price, suggested) ?? 0, round: roundAt(b.createdAt), status,
        listPos: pos >= 0 ? pos + 1 : null, cheapest: pos >= 0 ? pos === 0 : null, premiumNgn: pos >= 0 ? price - Number(sorted[0].amountNgn) : null,
        latencySec: secs(roundStart(b.createdAt), b.createdAt) ?? 0, profileViewed: null,
        driverRating: ratingOf.get(b.driverId) ?? null, pickupKm: b.distanceKm === null ? null : Math.round(b.distanceKm * 10) / 10,
        driverDeviceId: shortId(phone.device?.id), driverPlatform: dc.platform, driverPhoneTier: dc.phoneTier, driverPhoneModel: dc.phoneModel,
        driverAppVersion: dc.appVersion,
      });
    }

    for (const p of ridePings) {
      const bid = rideBids.find((b) => b.driverId === p.driverId) ?? null;
      const riderPrice = p.round <= 1 ? opening ?? 0 : rideChanges[p.round - 2]?.toNgn ?? final ?? 0;
      const action: PingAction = p.response === 'declined' ? 'Declined'
        : p.response === 'bid' && bid ? (Math.abs(Number(bid.amountNgn) - riderPrice) < 1 ? 'Took rider price' : 'Countered') : 'No answer';
      const pingPhone = deviceUsed(bid?.deviceId ?? null, userOfDriver.get(p.driverId), ['app'], r.createdAt).device;
      pingRows.push([id, ratingOf.get(p.driverId) ?? null, action, pct1(riderPrice, suggested), bid ? pct1(Number(bid.amountNgn), suggested) : null, platformLabel(pingPhone), pingPhone ? phoneTier(pingPhone) : 'Unknown']);
    }

    for (const c of rideChanges) {
      const raise = c.toNgn > c.fromNgn;
      const trigger = c.offersOpen === 0 ? 'No offers came in'
        : !raise ? 'Got takers, tried lower'
          : c.lowestOfferNgn !== null && c.toNgn === c.lowestOfferNgn ? 'Matched lowest counter' : 'Offers above their price';
      priceChanges.push({ sessionId: id, direction: raise ? 'Raise' : 'Drop', fromNgn: c.fromNgn, toNgn: c.toNgn, trigger });
    }

    const completed = outcome === 'Completed';
    const method = METHOD[r.paymentMethod] ?? 'Wallet';
    if (completed) {
      const paid = paidBy.get(r.id);
      if (method === 'Wallet' && paid) payments.push({ sessionId: id, date: dayOf(paid.createdAt), method, success: true, amountNgn: Number(paid.amountNgn) });
      else if (method !== 'Wallet') payments.push({ sessionId: id, date: dayOf(r.completedAt ?? r.createdAt), method, success: true, amountNgn: agreed ?? num(r.fareFinalNgn) ?? 0 });
    }
    const riderDevice = deviceUsed(r.deviceId, r.riderId, sourcesFor(r.channel), r.createdAt);
    used(riderDevice.device, 'Rider', { requests: 1, completed: completed ? 1 : 0 });
    const waRow = whatsappRowOf(r.riderId);
    const eta = accepted ? Math.round(accepted.etaSeconds / 60) : null;
    const bookingFee = num(r.serviceFeeNgn) ?? 0;
    const commission = num(r.commissionNgn) ?? 0;
    const whatsappFee = num(r.whatsappFeeNgn) ?? 0;

    sessions.push({
      id, date, hour, weekday: weekdayOf(r.createdAt), dayPart: dayPartOf(hour), channel: CHANNEL[r.channel] ?? 'Unknown', rideClass: 'Economy',
      riderId: r.riderId.slice(0, 8), riderType: null, joinedVia: joinedVia.get(r.riderId) ?? 'Unknown', onboardedWithPromo: null,
      weather: weatherAt(r.pickupZone, r.createdAt), zone: zoneName(r.pickupZone), destZone: zoneName(r.destZone), variant: null, promo: 'No promo',
      intentId: intent.id, attempt: intent.attempt, km, suggestedNgn: suggested, fareSize: fareSizeOf(suggested),
      openingNgn: opening, finalNgn: final, agreedNgn: agreed, outcome, reason: r.cancelReason ?? null, abandonStage: null,
      freeDrivers: r.driversFoundAtSearch ?? null, rounds: 1 + (rideChanges.length || r.riderOfferChanges),
      pinged: ridePings.length ? new Set(ridePings.map((p) => p.driverId)).size : null, offersReceived: rideBids.length,
      firstOfferSec: secs(r.createdAt, rideBids[0]?.createdAt), matchSec: secs(r.createdAt, r.matchedAt),
      decisionSec: accepted && sorted.length ? secs(sorted.map((b) => b.createdAt).sort((a, b) => a.getTime() - b.getTime())[0], acceptAt) : null,
      offersOnScreen: acceptAt ? onScreen.length || null : null,
      minutesToRide: completed && r.startedAt ? Math.round(((r.startedAt.getTime() - intent.firstAt.getTime()) / 60_000) * 10) / 10 : null,
      bookingFeeNgn: bookingFee, commissionNgn: commission, processorFeeNgn: 0, messagingCostNgn: 0, refundNgn: 0,
      wheelersNetNgn: completed ? bookingFee + commission + whatsappFee : 0, fuelNgn: completed ? Math.round(km * FUEL_PER_KM) : 0,
      deviceId: shortId(riderDevice.device?.id), deviceRecorded: riderDevice.recorded, ...deviceCols(riderDevice.device),
      mobileNetwork: waRow?.phoneNetwork ?? 'Unknown', formsOpen: waRow?.formsOpen ?? null,
      trip: r.driverId ? {
        status: completed ? 'Completed' : 'Cancelled after match', cancelledBy: completed ? null : (r.cancelledBy === 'driver' ? 'driver' : 'rider'),
        reason: completed ? null : r.cancelReason ?? null,
        pickupDelayMin: r.arrivedAt && r.matchedAt && eta !== null ? Math.round((r.arrivedAt.getTime() - r.matchedAt.getTime()) / 60_000 - eta) : null,
        fareNgn: agreed ?? 0, paid: completed ? true : null, method: completed ? method : null, rating: ratingBy.get(r.id) ?? null,
      } : null,
    });
  }

  // Supply by day: hours online (shifts started that day) and on trips (matched to ended, rides matched that day).
  const days: string[] = [];
  for (let t = Date.parse(`${f.from}T00:00:00Z`); t <= Date.parse(`${f.to}T00:00:00Z`); t += 86_400_000) days.push(new Date(t).toISOString().slice(0, 10));
  const now = new Date();
  const shiftRows = days.map((date) => ({
    date,
    onlineHours: Math.round(shifts.filter((s) => dayOf(s.startedAt) === date).reduce((h, s) => h + ((s.endedAt ?? now).getTime() - s.startedAt.getTime()) / 3_600_000, 0) * 10) / 10,
    tripHours: Math.round(rides.filter((r) => r.matchedAt && dayOf(r.matchedAt) === date).reduce((h, r) => h + ((r.completedAt ?? r.cancelledAt ?? r.matchedAt!).getTime() - r.matchedAt!.getTime()) / 3_600_000, 0) * 10) / 10,
  }));

  // Drivers' wallets by day (all drivers, date only).
  const driverUsers = (await prisma.driver.findMany({ select: { userId: true } })).map((d) => d.userId);
  const [moves, withdrawals] = await Promise.all([
    prisma.transaction.findMany({ where: { createdAt: { gte: start, lt: end }, type: { in: ['DRIVER_PAYOUT', 'CASH_RIDE_FEE', 'WITHDRAWAL'] }, wallet: { userId: { in: driverUsers } } }, select: { type: true, direction: true, amountNgn: true, createdAt: true } }),
    prisma.withdrawalRequest.findMany({ where: { createdAt: { gte: start, lt: end }, userId: { in: driverUsers } }, select: { status: true, feeNgn: true, requestedAmountNgn: true, createdAt: true } }),
  ]);
  const TYPE: Record<string, string> = { DRIVER_PAYOUT: 'Trip earnings', CASH_RIDE_FEE: 'Cash booking fee owed', WITHDRAWAL: 'Withdrawals' };
  const ledger: StudioDatasetLive['ledger'] = [
    ...moves.map((t) => ({ date: dayOf(t.createdAt), type: TYPE[t.type], amountNgn: (t.direction === 'DEBIT' ? -1 : 1) * Number(t.amountNgn) })),
    ...withdrawals.filter((w) => w.status === 'SETTLED' && w.feeNgn).map((w) => ({ date: dayOf(w.createdAt), type: 'Withdrawal fees', amountNgn: -Number(w.feeNgn) })),
    ...withdrawals.filter((w) => w.status === 'FAILED').map((w) => ({ date: dayOf(w.createdAt), type: 'Failed withdrawals', amountNgn: Number(w.requestedAmountNgn) })),
  ];

  // One row per device in the requests and offers above.
  const devices: StudioDatasetLive['devices'] = [...deviceUse.entries()].map(([deviceId, u]) => {
    const d = deviceById.get(deviceId)!;
    const wa = whatsappRowOf(d.userId);
    return {
      deviceId: shortId(deviceId), owner: u.owner, ownerId: shortId(d.userId), source: d.source, ...deviceCols(d),
      phoneModelCode: d.model ?? null, osVersion: d.osVersion ?? null, ramGb: d.ramGb ?? null, cpuCores: d.cpuCores ?? null,
      screen: d.screen ?? null, mobileNetwork: wa?.phoneNetwork ?? 'Unknown', formsOpen: wa?.formsOpen ?? null,
      firstSeen: d.firstSeenAt.toISOString(), lastSeen: d.lastSeenAt.toISOString(), timesSeen: d.timesSeen,
      requests: u.requests, completed: u.completed, bids: u.bids,
    };
  });

  return {
    source: 'live', from: f.from, to: f.to,
    zones: [...LAUNCH_ZONES.map((z) => z.name), 'Outside zones'],
    notRecorded: NOT_RECORDED,
    sessions, offers, pingRows, priceChanges, payments, shifts: shiftRows, ledger, devices,
  };
}

/**
 * The same dataset as an Excel workbook: one sheet per table (the Studio's data structure, so an analyst's Power BI
 * or pivot reads exactly what the page reads). The page's own "Download Excel" adds one sheet per tab on top.
 */
export async function studioDatasetWorkbook(ds: StudioDatasetLive): Promise<Buffer> {
  const ExcelJS = (await import('exceljs')).default;
  const book = new ExcelJS.Workbook();
  book.creator = 'Wheelers Analytics Studio';
  const sheet = (name: string, rows: Array<Record<string, unknown>>) => {
    const ws = book.addWorksheet(name);
    const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
    ws.columns = columns.map((key) => ({ header: key, key, width: Math.min(28, Math.max(10, key.length + 2)) }));
    ws.getRow(1).font = { bold: true };
    for (const r of rows) ws.addRow(Object.fromEntries(columns.map((c) => [c, r[c] ?? null])));
    ws.views = [{ state: 'frozen', ySplit: 1 }];
  };
  const flat = (s: Record<string, unknown>) => {
    const { trip, ...rest } = s as { trip: Record<string, unknown> | null };
    return { ...rest, ...Object.fromEntries(Object.entries(trip ?? {}).map(([k, v]) => [`trip_${k}`, v])) };
  };
  sheet('Sessions', ds.sessions.map(flat));
  sheet('Offers', ds.offers);
  sheet('Pings', ds.pingRows.map(([sessionId, driverRating, action, riderVsSuggestedPct, bidVsSuggestedPct, driverPlatform, driverPhoneTier]) => ({ sessionId, driverRating, action, riderVsSuggestedPct, bidVsSuggestedPct, driverPlatform, driverPhoneTier })));
  sheet('Devices', ds.devices);
  sheet('Price changes', ds.priceChanges);
  sheet('Payments', ds.payments);
  sheet('Supply by day', ds.shifts);
  sheet('Driver wallets', ds.ledger);
  sheet('Not recorded yet', ds.notRecorded.map((field) => ({ field })));
  return Buffer.from(await book.xlsx.writeBuffer());
}
