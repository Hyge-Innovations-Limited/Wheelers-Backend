import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { prisma } from '@wheleers/db';
import { PRICING_AREAS, holidayOn, pricingAreaOf, zoneFor } from '@wheleers/config';
import type { AnalyticsFilters } from '@wheleers/db';

/**
 * The analyst's Power BI pack, from our own data: the 30 files of their model (dim_*, fact_*), each with
 * exactly their columns, plus _relationships.csv, their guide (README_POWERBI.md) and NOTES.md, which says
 * what is filled and what we do not record yet (those columns are there, empty, so the model still loads).
 *
 * Rides are the searches of the chosen days (Lagos time); everything else hangs off them. No names, phones
 * or emails: people are their ids.
 */

const PACK_DIR = join(__dirname, '..', '..', 'analytics-pack');
const HEADERS: Record<string, string[]> = JSON.parse(readFileSync(join(PACK_DIR, 'headers.json'), 'utf8'));

type Row = Record<string, string | number | boolean | null | undefined>;

const LAGOS_MS = 3600_000;
/** "2026-10-01 07:04:49", Lagos time, as the pack writes times. */
function at(d: Date | null | undefined): string {
  return d ? new Date(d.getTime() + LAGOS_MS).toISOString().slice(0, 19).replace('T', ' ') : '';
}
function dayOf(d: Date): string {
  return new Date(d.getTime() + LAGOS_MS).toISOString().slice(0, 10);
}
const dateKey = (d: Date | null | undefined) => (d ? dayOf(d).replace(/-/g, '') : '');
const hourOf = (d: Date) => new Date(d.getTime() + LAGOS_MS).getUTCHours();
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const round = (n: number | null, dp = 1) => (n === null || !Number.isFinite(n) ? null : Math.round(n * 10 ** dp) / 10 ** dp);
const secondsBetween = (a: Date | null | undefined, b: Date | null | undefined) => (a && b ? Math.round((b.getTime() - a.getTime()) / 1000) : null);
const minutesBetween = (a: Date | null | undefined, b: Date | null | undefined) => (a && b ? round((b.getTime() - a.getTime()) / 60_000) : null);
const pct = (value: number | null, of: number | null) => (value !== null && of ? round((value / of - 1) * 100) : null);

function cell(v: Row[string]): string {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function csv(file: string, rows: Row[]): string {
  const columns = HEADERS[file];
  if (!columns) throw new Error(`unknown pack file ${file}`);
  return [columns.join(','), ...rows.map((r) => columns.map((c) => cell(r[c])).join(','))].join('\n') + '\n';
}

const CHANNEL: Record<string, string> = { APP: 'app', WHATSAPP: 'whatsapp', MCP: 'claude', UNKNOWN: 'unknown' };
const PAYMENT: Record<string, string> = { WALLET: 'wallet', CASH: 'cash', XLM: 'xlm' };
const OFFER_STATUS: Record<string, string> = {
  ACCEPTED: 'accepted', DECLINED: 'rejected', EXPIRED: 'expired', LOST: 'closed_other_driver_chosen',
  WITHDRAWN: 'withdrawn_by_driver', CANCELLED: 'closed_session_cancelled',
};
const ISLAND = new Set(['lagos-island', 'eti-osa', 'lekki', 'ajah', 'ibeju-lekki']);
const areaKey = (lat: number | null | undefined, lng: number | null | undefined) =>
  lat === null || lat === undefined || lng === null || lng === undefined ? '' : pricingAreaOf(lat, lng)?.key ?? '';

type SessionOutcome = 'completed' | 'cancelled_after_match' | 'cancelled_by_rider' | 'expired_no_match' | '';
function sessionOutcome(r: { status: string; driverId: string | null; cancelledBy: string | null; cancelStage: string | null }): SessionOutcome {
  if (r.status === 'COMPLETED' || r.status === 'DISPUTED') return 'completed';
  if (r.status === 'CANCELLED') {
    if (r.cancelStage && r.cancelStage !== 'BEFORE_MATCH') return 'cancelled_after_match';
    return r.cancelledBy === 'rider' ? 'cancelled_by_rider' : 'expired_no_match';
  }
  return '';
}
const INTENT_OUTCOME: Record<string, string> = {
  completed: 'completed', cancelled_after_match: 'gave_up_after_cancelled_after_match',
  cancelled_by_rider: 'gave_up_after_cancelled_by_rider', expired_no_match: 'gave_up_after_expired_no_match',
};
const RAIN: Record<string, string> = { none: 'clear', light: 'light_rain', heavy: 'heavy_rain' };

export type PackTable = { name: string; columns: string[]; rows: Row[] };
/** files: what goes in the zip's powerbi/ folder. tables: the same 30 tables as rows, for the Excel sheets and the Studio. */
export type AnalyticsPack = { files: Array<{ name: string; data: string }>; tables: PackTable[]; counts: Record<string, number> };

/** A small CSV reader for the pack's own lookup files (quoted cells allowed). Numbers come back as numbers. */
function parseCsv(text: string): { columns: string[]; rows: Row[] } {
  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { record.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      record.push(field); field = '';
      if (record.some((x) => x !== '')) records.push(record);
      record = [];
    } else field += ch;
  }
  if (field !== '' || record.length) { record.push(field); records.push(record); }
  const [columns = [], ...body] = records;
  const value = (v: string): Row[string] => (v === 'TRUE' ? true : v === 'FALSE' ? false : /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v);
  return { columns, rows: body.map((r) => Object.fromEntries(columns.map((c, i) => [c, value(r[i] ?? '')]))) };
}

export async function buildAnalyticsPack(f: Pick<AnalyticsFilters, 'from' | 'to'>, now = new Date()): Promise<AnalyticsPack> {
  const start = new Date(Date.parse(`${f.from}T00:00:00+01:00`));
  const end = new Date(Date.parse(`${f.to}T00:00:00+01:00`) + 86_400_000);

  const rides = await prisma.ride.findMany({
    where: { createdAt: { gte: start, lt: end } },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true, riderId: true, driverId: true, status: true, paymentMethod: true, channel: true, pricingVersion: true,
      pickupLat: true, pickupLng: true, destLat: true, destLng: true, pickupZone: true,
      fareEstimateNgn: true, bookingSuggestedFareNgn: true, firstRiderOfferNgn: true, riderOfferNgn: true, riderOfferChanges: true,
      agreedFareNgn: true, fareFinalNgn: true, serviceFeeNgn: true, commissionNgn: true,
      distanceKm: true, plannedDistanceKm: true, durationSeconds: true,
      cancelStage: true, cancelReason: true, cancelledBy: true,
      createdAt: true, matchedAt: true, arrivedAt: true, startedAt: true, completedAt: true, cancelledAt: true,
    },
  });
  const rideIds = rides.map((r) => r.id);
  const rideById = new Map(rides.map((r) => [r.id, r]));
  const riderIds = [...new Set(rides.map((r) => r.riderId))];

  const [bids, feedback, calls, chats, weather, shifts, disputes, conversations] = await Promise.all([
    prisma.driverBid.findMany({ where: { rideId: { in: rideIds } }, orderBy: { createdAt: 'asc' } }),
    prisma.feedback.findMany({ where: { rideId: { in: rideIds } } }),
    prisma.tripCall.findMany({ where: { rideId: { in: rideIds } }, select: { rideId: true, createdAt: true } }),
    prisma.chatMessage.findMany({ where: { rideId: { in: rideIds } }, select: { rideId: true, createdAt: true } }),
    prisma.weatherReading.findMany({ where: { at: { gte: new Date(start.getTime() - 3 * 3600_000), lt: end } }, orderBy: { at: 'asc' } }),
    prisma.driverShift.findMany({ where: { startedAt: { lt: end }, OR: [{ endedAt: null }, { endedAt: { gte: start } }] }, orderBy: { startedAt: 'asc' } }),
    prisma.dispute.findMany({ where: { createdAt: { gte: start, lt: end } } }),
    prisma.supportConversation.findMany({ where: { createdAt: { gte: start, lt: end } }, select: { id: true, rideId: true, topic: true, status: true, createdAt: true, resolvedAt: true } }),
  ]);
  const driverIds = [...new Set([...rides.map((r) => r.driverId), ...bids.map((b) => b.driverId), ...shifts.map((s) => s.driverId)].filter((x): x is string => Boolean(x)))];
  const [drivers, riders] = await Promise.all([
    prisma.driver.findMany({ where: { id: { in: driverIds } }, select: { id: true, kycStatus: true, rating: true, vehicleMake: true, vehicleModel: true, vehiclePlate: true, vehicleYear: true, userId: true, user: { select: { createdAt: true } } } }),
    prisma.user.findMany({ where: { id: { in: riderIds } }, select: { id: true, createdAt: true } }),
  ]);
  const driverUserIds = drivers.map((d) => d.userId);
  const driverByUser = new Map(drivers.map((d) => [d.userId, d.id]));
  const [ledger, riderMoney] = await Promise.all([
    prisma.transaction.findMany({ where: { createdAt: { gte: start, lt: end }, wallet: { userId: { in: driverUserIds } } }, orderBy: { createdAt: 'asc' }, select: { id: true, type: true, direction: true, amountNgn: true, balanceAfterNgn: true, referenceId: true, createdAt: true, wallet: { select: { userId: true } } } }),
    prisma.transaction.findMany({ where: { createdAt: { gte: start, lt: end }, type: { in: ['RIDE_PAYMENT', 'REFUND'] }, wallet: { userId: { in: riderIds } } }, orderBy: { createdAt: 'asc' }, select: { id: true, type: true, direction: true, amountNgn: true, referenceId: true, createdAt: true } }),
  ]);

  const bidsByRide = new Map<string, typeof bids>();
  for (const b of bids) bidsByRide.set(b.rideId, [...(bidsByRide.get(b.rideId) ?? []), b]);
  const accepted = (rideId: string) => bidsByRide.get(rideId)?.find((b) => b.status === 'ACCEPTED') ?? null;
  const countBefore = (list: Array<{ rideId: string; createdAt: Date }>, rideId: string, before: Date | null) =>
    before ? list.filter((x) => x.rideId === rideId && x.createdAt < before).length : null;
  const rating = (rideId: string, role: 'RIDER' | 'DRIVER') => feedback.find((x) => x.rideId === rideId && x.reviewerRole === role)?.rating ?? null;
  const shiftAt = (driverId: string | null, when: Date | null) =>
    driverId && when ? shifts.find((s) => s.driverId === driverId && s.startedAt <= when && (!s.endedAt || s.endedAt >= when))?.id ?? '' : '';
  const weatherAt = (zone: string | null, when: Date) => {
    const near = weather.filter((w) => (!zone || w.zone === zone) && w.at <= when && when.getTime() - w.at.getTime() <= 3 * 3600_000);
    const last = near[near.length - 1];
    return last ? RAIN[last.rain] ?? '' : '';
  };
  const suggested = (r: (typeof rides)[number]) => num(r.bookingSuggestedFareNgn) ?? num(r.fareEstimateNgn);
  const endedAt = (r: (typeof rides)[number]) => r.completedAt ?? r.cancelledAt ?? null;

  /* ── facts ─────────────────────────────────────────────────────────────── */

  const sessions: Row[] = rides.map((r) => {
    const first = num(r.firstRiderOfferNgn) ?? num(r.riderOfferNgn);
    const final = num(r.riderOfferNgn);
    const firstBid = bidsByRide.get(r.id)?.[0];
    return {
      session_id: r.id, intent_id: r.id, attempt_number: 1, date_key: dateKey(r.createdAt), hour_key: hourOf(r.createdAt),
      created_at: at(r.createdAt), search_started_at: at(r.createdAt), negotiation_ended_at: at(r.matchedAt ?? r.cancelledAt),
      session_ended_at: at(endedAt(r)), session_outcome_key: sessionOutcome(r), end_reason: r.cancelReason ?? '',
      pricing_version_key: `PV${r.pricingVersion}`, weather_key: weatherAt(r.pickupZone, r.createdAt),
      route_distance_km: round(r.plannedDistanceKm ?? r.distanceKm, 2), est_duration_min: r.durationSeconds ? Math.round(r.durationSeconds / 60) : null,
      suggested_fare_ngn: suggested(r), first_price_entered_ngn: first, initial_rider_price_ngn: first,
      initial_vs_suggested_pct: pct(first, suggested(r)), final_rider_price_ngn: final,
      total_price_change_ngn: first !== null && final !== null ? final - first : null, total_price_change_pct: pct(final, first),
      negotiation_rounds: r.riderOfferChanges, time_to_first_offer_sec: secondsBetween(r.createdAt, firstBid?.createdAt),
      time_to_match_sec: secondsBetween(r.createdAt, r.matchedAt), total_session_duration_sec: secondsBetween(r.createdAt, endedAt(r)),
      accepted_offer_id: accepted(r.id)?.id ?? '',
    };
  });

  const intents: Row[] = rides.map((r) => {
    const outcome = sessionOutcome(r);
    const first = num(r.firstRiderOfferNgn) ?? num(r.riderOfferNgn);
    const agreed = num(r.agreedFareNgn);
    return {
      intent_id: r.id, rider_id: r.riderId, channel_key: CHANNEL[r.channel] ?? 'unknown', ride_class_key: 'economy',
      payment_method_key: PAYMENT[r.paymentMethod] ?? '', pickup_area_key: areaKey(r.pickupLat, r.pickupLng), dropoff_area_key: areaKey(r.destLat, r.destLng),
      pickup_lat: r.pickupLat, pickup_lng: r.pickupLng, dropoff_lat: r.destLat, dropoff_lng: r.destLng,
      first_opened_date_key: dateKey(r.createdAt), first_opened_at: at(r.createdAt), intent_resolved_at: at(endedAt(r)), attempt_count: 1,
      intent_outcome_key: INTENT_OUTCOME[outcome] ?? '', total_time_to_resolution_sec: secondsBetween(r.createdAt, endedAt(r)),
      time_to_trip_start_sec: secondsBetween(r.createdAt, r.startedAt), first_opening_price_ngn: first, final_agreed_fare_ngn: agreed,
      total_raise_vs_first_open_pct: pct(agreed, first),
    };
  });

  const trips: Row[] = rides.filter((r) => r.driverId).map((r) => {
    const bid = accepted(r.id);
    const eta = bid ? Math.round(bid.etaSeconds / 60) : null;
    const agreed = num(r.agreedFareNgn) ?? num(r.fareFinalNgn);
    const status = r.status === 'COMPLETED' ? 'completed' : r.status === 'CANCELLED' ? 'cancelled' : r.status === 'DISPUTED' ? 'disputed' : 'in_progress';
    return {
      trip_id: r.id, session_id: r.id, driver_id: r.driverId, offer_id: bid?.id ?? '', shift_id: shiftAt(r.driverId, r.matchedAt),
      assigned_at: at(r.matchedAt), quoted_eta_min: eta, calls_before_pickup: countBefore(calls, r.id, r.arrivedAt ?? r.cancelledAt),
      chat_messages_before_pickup: countBefore(chats, r.id, r.arrivedAt ?? r.cancelledAt), driver_arrived_at: at(r.arrivedAt),
      pickup_delay_min: r.arrivedAt && r.matchedAt && eta !== null ? round((r.arrivedAt.getTime() - r.matchedAt.getTime()) / 60_000 - eta) : null,
      rider_wait_at_pickup_sec: secondsBetween(r.arrivedAt, r.startedAt), trip_started_at: at(r.startedAt), trip_ended_at: at(r.completedAt),
      trip_status: status, cancelled_by: r.status === 'CANCELLED' ? r.cancelledBy ?? '' : '', cancel_reason: r.status === 'CANCELLED' ? r.cancelReason ?? '' : '',
      actual_distance_km: round(r.distanceKm, 2), actual_duration_min: minutesBetween(r.startedAt, r.completedAt),
      agreed_fare_ngn: agreed, agreed_vs_suggested_pct: pct(agreed, suggested(r)), booking_fee_ngn: num(r.serviceFeeNgn),
      final_payment_method_key: PAYMENT[r.paymentMethod] ?? '', payment_status: r.status === 'COMPLETED' ? (r.paymentMethod === 'CASH' ? 'cash_collected' : 'paid') : '',
      commission_ngn: num(r.commissionNgn), rider_rating_of_driver: rating(r.id, 'RIDER'), driver_rating_of_rider: rating(r.id, 'DRIVER'),
    };
  });

  const offers: Row[] = bids.map((b) => {
    const r = rideById.get(b.rideId);
    const amount = Number(b.amountNgn);
    const riderPrice = r ? num(r.riderOfferNgn) : null;
    return {
      offer_id: b.id, sent_at: at(b.createdAt), offered_amount_ngn: amount,
      diff_vs_rider_price_ngn: riderPrice !== null ? amount - riderPrice : null, diff_vs_rider_price_pct: pct(amount, riderPrice),
      diff_vs_suggested_pct: r ? pct(amount, suggested(r)) : null, offer_status_key: OFFER_STATUS[b.status] ?? '', status_at: at(b.resolvedAt),
      rider_response_sec: b.resolvedAt && (b.status === 'ACCEPTED' || b.status === 'DECLINED') ? secondsBetween(b.createdAt, b.resolvedAt) : null,
      // Not in the analyst's columns (so not in the files or sheets): for the admin Studio.
      _ride_id: b.rideId, _driver_id: b.driverId, _distance_km: b.distanceKm,
    };
  });

  const ridesByDriver = new Map<string, typeof rides>();
  for (const r of rides) if (r.driverId) ridesByDriver.set(r.driverId, [...(ridesByDriver.get(r.driverId) ?? []), r]);
  const shiftRows: Row[] = shifts.filter((s) => s.startedAt >= start).map((s) => {
    const until = s.endedAt ?? now;
    const onTrips = (ridesByDriver.get(s.driverId) ?? []).reduce((sum, r) => {
      if (!r.matchedAt || r.matchedAt < s.startedAt || r.matchedAt > until) return sum;
      return sum + Math.max(0, ((r.completedAt ?? r.cancelledAt ?? r.matchedAt).getTime() - r.matchedAt.getTime()) / 60_000);
    }, 0);
    return {
      shift_id: s.id, driver_id: s.driverId, date_key: dateKey(s.startedAt), online_at: at(s.startedAt), offline_at: at(s.endedAt),
      online_minutes: s.endedAt ? Math.round((s.endedAt.getTime() - s.startedAt.getTime()) / 60_000) : null, offline_reason: s.endReason ?? '',
      minutes_on_trips: Math.round(onTrips),
    };
  });

  const ENTRY: Record<string, string> = { DRIVER_PAYOUT: 'trip_earning', WITHDRAWAL: 'withdrawal', PENALTY: 'penalty', REFUND: 'refund', ADJUSTMENT: 'adjustment', PLATFORM_FEE: 'commission', DEPOSIT: 'top_up', PROVIDER_FEE: 'processor_fee', DISPUTE_RESOLUTION: 'dispute', RIDE_PAYMENT: 'ride_payment' };
  const ledgerRows: Row[] = ledger.map((t) => ({
    entry_id: t.id, driver_id: driverByUser.get(t.wallet.userId) ?? '', date_key: dateKey(t.createdAt), entry_created_at: at(t.createdAt),
    funds_available_at: at(t.createdAt), entry_type: ENTRY[t.type] ?? t.type.toLowerCase(),
    entry_amount_ngn: (t.direction === 'DEBIT' ? -1 : 1) * Number(t.amountNgn), trip_id: rideById.has(t.referenceId) ? t.referenceId : '',
    balance_after_ngn: Number(t.balanceAfterNgn),
  }));

  const payments: Row[] = [];
  for (const r of rides) {
    if (r.status !== 'COMPLETED' || r.paymentMethod === 'WALLET') continue;
    payments.push({
      payment_id: `${r.id}:charge`, trip_id: r.id, payment_type: 'charge', payment_attempt_number: 1, payment_method_key: PAYMENT[r.paymentMethod] ?? '',
      payment_amount_ngn: num(r.fareFinalNgn) ?? num(r.agreedFareNgn), attempt_status: 'success', attempted_at: at(r.completedAt), settled_at: at(r.completedAt),
    });
  }
  for (const t of riderMoney) {
    if (!rideById.has(t.referenceId)) continue;
    const refund = t.type === 'REFUND';
    payments.push({
      payment_id: t.id, trip_id: t.referenceId, payment_type: refund ? 'refund' : 'charge', payment_attempt_number: 1, payment_method_key: 'wallet',
      payment_amount_ngn: Number(t.amountNgn), attempt_status: 'success', attempted_at: at(t.createdAt), settled_at: at(t.createdAt),
    });
  }

  const tickets: Row[] = [
    ...disputes.map((d) => ({
      ticket_id: d.id, trip_id: d.rideId, opened_at: at(d.createdAt), support_channel: 'dispute', ticket_category: d.reason,
      ticket_status: d.status.toLowerCase(), resolved_at: at(d.resolvedAt), refund_ngn: num(d.refundNgn),
    })),
    ...conversations.map((c) => ({
      ticket_id: c.id, trip_id: c.rideId ?? '', opened_at: at(c.createdAt), support_channel: 'in_app', ticket_category: c.topic ?? '',
      ticket_status: c.status.toLowerCase(), resolved_at: at(c.resolvedAt),
    })),
  ];

  /* ── dimensions ────────────────────────────────────────────────────────── */

  const dates: Row[] = [];
  for (let t = Date.parse(`${f.from}T00:00:00Z`); t <= Date.parse(`${f.to}T00:00:00Z`); t += 86_400_000) {
    const d = new Date(t);
    const iso = d.toISOString().slice(0, 10);
    const weekday = (d.getUTCDay() + 6) % 7; // Monday 0
    const weekStart = new Date(t - weekday * 86_400_000).toISOString().slice(0, 10);
    const thursday = new Date(t + (3 - weekday) * 86_400_000);
    const isoWeek = Math.ceil(((thursday.getTime() - Date.UTC(thursday.getUTCFullYear(), 0, 1)) / 86_400_000 + 1) / 7);
    const holiday = holidayOn(iso);
    const weekend = weekday >= 5;
    dates.push({
      date_key: iso.replace(/-/g, ''), date: iso, year: d.getUTCFullYear(), month_num: d.getUTCMonth() + 1,
      month_name: d.toLocaleString('en-GB', { month: 'long', timeZone: 'UTC' }), year_month: iso.slice(0, 7), day_of_month: d.getUTCDate(),
      weekday_name: d.toLocaleString('en-GB', { weekday: 'long', timeZone: 'UTC' }), weekday_num: weekday + 1, iso_week: isoWeek, week_start: weekStart,
      is_weekend: weekend, is_public_holiday: Boolean(holiday), holiday_name: holiday ?? '', is_working_day: !weekend && !holiday,
    });
  }

  const areas: Row[] = PRICING_AREAS.map((a) => ({
    area_key: a.key, area_name: a.name, latitude: a.center[0], longitude: a.center[1],
    side_of_lagos: ISLAND.has(a.key) ? 'Island' : 'Mainland', launch_zone: zoneFor(a.center[0], a.center[1]) ?? 'Outside launch zones',
  }));

  const riderRatings = new Map<string, number[]>();
  for (const x of feedback) if (x.reviewerRole === 'DRIVER') riderRatings.set(x.revieweeId, [...(riderRatings.get(x.revieweeId) ?? []), x.rating]);
  const riderRows: Row[] = riders.map((u) => {
    const theirs = rides.filter((r) => r.riderId === u.id);
    const methods = theirs.map((r) => PAYMENT[r.paymentMethod] ?? '').filter(Boolean);
    const preferred = methods.sort((a, b) => methods.filter((m) => m === b).length - methods.filter((m) => m === a).length)[0] ?? '';
    const given = riderRatings.get(u.id);
    return {
      rider_id: u.id, signup_date: dayOf(u.createdAt), signup_channel: CHANNEL[theirs[0]?.channel ?? ''] ?? '',
      rider_rating: given ? round(given.reduce((a, b) => a + b, 0) / given.length, 2) : null, preferred_payment: preferred,
    };
  });
  const driverRows: Row[] = drivers.map((d) => ({
    driver_id: d.id, vehicle_id: d.id, joined_date: dayOf(d.user.createdAt), verification_status: d.kycStatus.toLowerCase(), current_rating: d.rating,
  }));
  const year = Number(dayOf(now).slice(0, 4));
  const vehicles: Row[] = drivers.map((d) => ({
    vehicle_id: d.id, plate_number: d.vehiclePlate ?? '', vehicle_make: d.vehicleMake ?? '', vehicle_model: d.vehicleModel ?? '',
    vehicle_year: d.vehicleYear ?? '', vehicle_class: 'economy', vehicle_age_years: d.vehicleYear ? year - d.vehicleYear : null,
  }));
  const versions: Row[] = [...new Set(rides.map((r) => r.pricingVersion))].sort().map((v) => ({ pricing_version_key: `PV${v}`, notes: `Wheelers pricing version ${v}` }));

  /* ── the files ─────────────────────────────────────────────────────────── */

  const built: Record<string, Row[]> = {
    dim_date: dates, dim_area: areas, dim_rider: riderRows, dim_driver: driverRows, dim_vehicle: vehicles, dim_pricing_version: versions,
    dim_experiment_variant: [],
    fact_ride_intents: intents, fact_ride_sessions: sessions, fact_trips: trips, fact_driver_offers: offers, fact_driver_shifts: shiftRows,
    fact_driver_wallet_ledger: ledgerRows, fact_payments: payments, fact_support_tickets: tickets,
    fact_price_changes: [], fact_request_notifications: [], fact_session_events: [], fact_trip_rating_tags: [],
  };
  const files: Array<{ name: string; data: string }> = [];
  const tables: PackTable[] = [];
  const counts: Record<string, number> = {};
  const staticDir = join(PACK_DIR, 'static');
  const staticFiles = new Set(readdirSync(staticDir).filter((n) => n.endsWith('.csv')).map((n) => n.slice(0, -4)));
  for (const name of Object.keys(HEADERS).sort()) {
    if (staticFiles.has(name)) {
      const data = readFileSync(join(staticDir, `${name}.csv`), 'utf8');
      const parsed = parseCsv(data);
      files.push({ name: `${name}.csv`, data });
      tables.push({ name, columns: HEADERS[name]!, rows: parsed.rows });
      counts[name] = parsed.rows.length;
    } else {
      const rows = built[name] ?? [];
      files.push({ name: `${name}.csv`, data: csv(name, rows) });
      tables.push({ name, columns: HEADERS[name]!, rows });
      counts[name] = rows.length;
    }
  }
  files.push({ name: '_relationships.csv', data: readFileSync(join(PACK_DIR, '_relationships.csv'), 'utf8') });
  files.push({ name: 'README_POWERBI.md', data: readFileSync(join(PACK_DIR, 'README_POWERBI.md'), 'utf8') });
  files.push({ name: 'NOTES.md', data: notes(f, counts) });
  return { files, tables, counts };
}

function notes(f: Pick<AnalyticsFilters, 'from' | 'to'>, counts: Record<string, number>): string {
  const lines = Object.entries(counts).map(([name, n]) => `| ${name}.csv | ${n} |`);
  return `# Wheelers Power BI pack — ${f.from} to ${f.to}

Real Wheelers data for the searches of these days (Lagos time), in the analyst's model: the same 30 files and columns as reference_powerbi.
People are ids only: no names, phones or emails.

## Rows per file
| File | Rows |
|---|---|
${lines.join('\n')}

## Not recorded yet (the columns are there, empty)
- fact_session_events, fact_request_notifications (every ping to each driver, delivered / seen), fact_price_changes, fact_trip_rating_tags, dim_experiment_variant.
- In fact_ride_sessions and fact_ride_intents: one search is one intent for now (search-again attempts are not yet grouped into one need to travel); rider history, drivers online and messaging-cost columns are empty.
- In fact_driver_offers: notification, driver position, expiry and list-position columns.
- In dim_rider / dim_driver: names and phones (left out on purpose), age, device, home area, segment, other platforms.
- Fuel estimates and driver gross / net in fact_trips.

## Our values in the analyst's keys
- Channels: app, whatsapp, claude (bookings made through Claude), unknown.
- Payment methods: wallet, cash, xlm (Stellar) — riders top up the wallet by bank transfer.
- Areas: our pricing areas (area_key is the area's name key, e.g. "yaba"), launch zone from our zones.
- Offer status: our bid states mapped (declined by the rider = rejected; lost to another driver; withdrawn; expired; search cancelled).
- Weather: the rain reading in the pickup zone up to 3 hours before the search.
`;
}
