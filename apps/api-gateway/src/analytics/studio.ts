import type { AnalyticsPack, PackTable } from './pack';

/**
 * The admin Studio's numbers: every chart worked out from the Power BI pack's tables (the same rows as the
 * download, so a number on screen is the number in the file). Each section is small, plain data for one chart.
 */

type Row = PackTable['rows'][number];
const n = (v: Row[string]): number | null => (v === null || v === undefined || v === '' ? null : Number(v));
const s = (v: Row[string]): string => (v === null || v === undefined ? '' : String(v));
const share = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);
const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);
function count<T>(rows: T[], key: (r: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) out[key(r)] = (out[key(r)] ?? 0) + 1;
  return out;
}
/** The band a value falls in: bands are [label, upper bound], the last one catches the rest. */
function band(value: number | null, bands: Array<[string, number]>): string | null {
  if (value === null || !Number.isFinite(value)) return null;
  for (const [label, upper] of bands) if (value < upper) return label;
  return bands[bands.length - 1]![0];
}

const VS_SUGGESTED: Array<[string, number]> = [['More than 20% under', -20], ['10–20% under', -10], ['0–10% under', 0], ['0–10% over', 10.0001], ['10–20% over', 20.0001], ['More than 20% over', Infinity]];
const RAISE: Array<[string, number]> = [['Lowered', 0], ['No change', 0.0001], ['Raised up to 10%', 10.0001], ['Raised 10–20%', 20.0001], ['Raised over 20%', Infinity]];
const GAP: Array<[string, number]> = [['At or under rider price', 0.0001], ['Up to 10% over', 10.0001], ['10–20% over', 20.0001], ['20–40% over', 40.0001], ['More than 40% over', Infinity]];
const FARE: Array<[string, number]> = [['Under ₦3,500', 3500], ['₦3,500–6,000', 6000], ['₦6,000–10,000', 10000], ['₦10,000–15,000', 15000], ['₦15,000 and over', Infinity]];
const WAIT: Array<[string, number]> = [['Offer within 1 min', 60], ['1–2 min', 120], ['2–5 min', 300], ['Over 5 min', Infinity]];
const DELAY: Array<[string, number]> = [['Early or on time', 0.5], ['Up to 5 min late', 5.0001], ['5–10 min late', 10.0001], ['Over 10 min late', Infinity]];
const OFFERS: Array<[string, number]> = [['No offer', 1], ['1 offer', 2], ['2 offers', 3], ['3–4 offers', 5], ['5 or more', Infinity]];
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const MATCHED = new Set(['completed', 'cancelled_after_match']);

export function buildStudio(pack: AnalyticsPack) {
  const t = (name: string) => pack.tables.find((x) => x.name === name)?.rows ?? [];
  const sessions = t('fact_ride_sessions');
  const intents = new Map(t('fact_ride_intents').map((r) => [s(r.intent_id), r]));
  const trips = t('fact_trips');
  const offers = t('fact_driver_offers');
  const shifts = t('fact_driver_shifts');
  const ledger = t('fact_driver_wallet_ledger');
  const payments = t('fact_payments');
  const dates = t('dim_date');
  const dayPart = new Map(t('dim_hour').map((h) => [s(h.hour_key), s(h.day_part)]));
  const dayPartOrder = [...new Map(t('dim_hour').map((h) => [s(h.day_part), Number(h.day_part_sort)])).entries()].sort((a, b) => a[1] - b[1]).map(([name]) => name);
  const weekdayOf = new Map(dates.map((d) => [s(d.date_key), s(d.weekday_name)]));
  const tripById = new Map(trips.map((r) => [s(r.trip_id), r]));

  const matched = (r: Row) => MATCHED.has(s(r.session_outcome_key));
  const completed = (r: Row) => s(r.session_outcome_key) === 'completed';
  const rate = (rows: Row[]) => ({ searches: rows.length, matched: rows.filter(matched).length, completed: rows.filter(completed).length, matchRate: share(rows.filter(matched).length, rows.length), completionRate: share(rows.filter(completed).length, rows.length) });
  const groupBy = (rows: Row[], key: (r: Row) => string | null) => {
    const out = new Map<string, Row[]>();
    for (const r of rows) { const k = key(r); if (k !== null) out.set(k, [...(out.get(k) ?? []), r]); }
    return out;
  };
  const inOrder = <T>(map: Map<string, T>, order: string[]) => order.filter((k) => map.has(k)).map((k) => [k, map.get(k)!] as const);

  /* demand & matching */
  const byDate = groupBy(sessions, (r) => s(r.date_key));
  const demandByDay = dates.map((d) => ({ date: s(d.date), ...rate(byDate.get(s(d.date_key)) ?? []) }));
  const outcomes = count(sessions, (r) => s(r.session_outcome_key) || 'open');
  const byHour = Array.from({ length: 24 }, (_, h) => ({ hour: h, ...rate(sessions.filter((r) => n(r.hour_key) === h)) }));
  const byWeekday = WEEKDAYS.map((w) => {
    const rows = sessions.filter((r) => weekdayOf.get(s(r.date_key)) === w);
    return { weekday: w, total: rows.length, ...count(rows, (r) => s(r.session_outcome_key) || 'open') };
  });
  const offerCount = count(offers, (r) => s(r._ride_id));
  const funnel = [
    { step: 'Searched', count: sessions.length },
    { step: 'Got an offer', count: sessions.filter((r) => (offerCount[s(r.session_id)] ?? 0) > 0).length },
    { step: 'Matched', count: trips.length },
    { step: 'Driver arrived', count: trips.filter((r) => s(r.driver_arrived_at)).length },
    { step: 'Trip started', count: trips.filter((r) => s(r.trip_started_at)).length },
    { step: 'Completed', count: trips.filter((r) => s(r.trip_status) === 'completed').length },
  ];
  const grid = WEEKDAYS.map((w) => ({
    weekday: w,
    cells: dayPartOrder.map((part) => {
      const rows = sessions.filter((r) => weekdayOf.get(s(r.date_key)) === w && dayPart.get(s(r.hour_key)) === part);
      return { dayPart: part, searches: rows.length, matchRate: share(rows.filter(matched).length, rows.length) };
    }),
  }));

  /* prices & bargaining */
  const bandRates = (rows: Row[], value: (r: Row) => number | null, bands: Array<[string, number]>) =>
    inOrder(groupBy(rows, (r) => band(value(r), bands)), bands.map((b) => b[0])).map(([label, rs]) => ({ band: label, ...rate(rs) }));
  const openingVsSuccess = bandRates(sessions, (r) => n(r.initial_vs_suggested_pct), VS_SUGGESTED);
  const priceMoves = bandRates(sessions, (r) => n(r.total_price_change_pct), RAISE);
  const fareSize = bandRates(sessions, (r) => n(r.suggested_fare_ngn), FARE);
  const finalVsSuggested = inOrder(groupBy(trips, (r) => band(n(r.agreed_vs_suggested_pct), VS_SUGGESTED)), VS_SUGGESTED.map((b) => b[0])).map(([label, rs]) => ({ band: label, trips: rs.length }));
  const offerVsSuggested = inOrder(groupBy(offers, (r) => band(n(r.diff_vs_suggested_pct), VS_SUGGESTED)), VS_SUGGESTED.map((b) => b[0])).map(([label, rs]) => ({ band: label, offers: rs.length }));
  const perKm = sessions.filter((r) => n(r.route_distance_km) && n(r.final_rider_price_ngn)).map((r) => ({ km: n(r.route_distance_km)!, priceNgn: n(r.final_rider_price_ngn)!, perKmNgn: Math.round(n(r.final_rider_price_ngn)! / n(r.route_distance_km)!), matched: matched(r) }));
  const finalPrices = sessions.map((r) => n(r.final_rider_price_ngn)).filter((x): x is number => x !== null);
  const roundness = { prices: finalPrices.length, on1000: finalPrices.filter((p) => p % 1000 === 0).length, on500: finalPrices.filter((p) => p % 500 === 0 && p % 1000 !== 0).length, other: finalPrices.filter((p) => p % 500 !== 0).length };

  /* driver offers */
  const statusMix = count(offers, (r) => s(r.offer_status_key) || 'open');
  const fateByGap = inOrder(groupBy(offers, (r) => band(n(r.diff_vs_rider_price_pct), GAP)), GAP.map((b) => b[0])).map(([label, rs]) => ({ band: label, offers: rs.length, ...count(rs, (r) => s(r.offer_status_key) || 'open'), acceptedShare: share(rs.filter((r) => s(r.offer_status_key) === 'accepted').length, rs.length) }));
  const counterSizes = offers.filter((r) => (n(r.diff_vs_rider_price_ngn) ?? 0) > 0).map((r) => n(r.diff_vs_rider_price_ngn)!);
  const counters = { offers: offers.length, atRiderPrice: offers.filter((r) => n(r.diff_vs_rider_price_ngn) === 0).length, above: counterSizes.length, below: offers.filter((r) => (n(r.diff_vs_rider_price_ngn) ?? 0) < 0).length, medianAboveNgn: counterSizes.sort((a, b) => a - b)[Math.floor(counterSizes.length / 2)] ?? null };
  // Offers on screen vs booking: each search by how many offers it got.
  const choiceOverload = bandRates(sessions, (r) => offerCount[s(r.session_id)] ?? 0, OFFERS);
  // What the winning offer was over the rider's price, by the driver's rating and by how far away they were.
  const rating = new Map(t('dim_driver').map((d) => [s(d.driver_id), n(d.current_rating)]));
  const won = offers.filter((r) => s(r.offer_status_key) === 'accepted');
  const premium = (rows: Row[]) => avg(rows.map((r) => n(r.diff_vs_rider_price_pct)).filter((x): x is number => x !== null));
  const RATING: Array<[string, number]> = [['Under 4.5', 4.5], ['4.5–4.8', 4.8], ['4.8 and up', Infinity]];
  const DISTANCE: Array<[string, number]> = [['Under 1 km', 1], ['1–3 km', 3], ['3–5 km', 5], ['5 km and over', Infinity]];
  const premiumByRating = inOrder(groupBy(won, (r) => band(rating.get(s(r._driver_id)) ?? null, RATING)), RATING.map((b) => b[0])).map(([label, rs]) => ({ band: label, won: rs.length, avgPremiumPct: premium(rs) }));
  const premiumByDistance = inOrder(groupBy(won, (r) => band(n(r._distance_km), DISTANCE)), DISTANCE.map((b) => b[0])).map(([label, rs]) => ({ band: label, won: rs.length, avgPremiumPct: premium(rs) }));
  const decision = offers.filter((r) => n(r.rider_response_sec) !== null).map((r) => n(r.rider_response_sec)!);

  /* supply */
  const shiftsByDay = groupBy(shifts, (r) => s(r.date_key));
  const supplyByDay = dates.map((d) => {
    const rs = shiftsByDay.get(s(d.date_key)) ?? [];
    const online = rs.reduce((a, r) => a + (n(r.online_minutes) ?? 0), 0);
    const onTrips = rs.reduce((a, r) => a + (n(r.minutes_on_trips) ?? 0), 0);
    return { date: s(d.date), drivers: new Set(rs.map((r) => s(r.driver_id))).size, onlineHours: Math.round(online / 6) / 10, tripHours: Math.round(onTrips / 6) / 10, utilisation: share(onTrips, online) };
  });

  /* money */
  const done = trips.filter((r) => s(r.trip_status) === 'completed');
  const tripsByDay = groupBy(done, (r) => s(r.trip_ended_at).slice(0, 10));
  const moneyByDay = dates.map((d) => {
    const rs = tripsByDay.get(s(d.date)) ?? [];
    const fares = rs.reduce((a, r) => a + (n(r.agreed_fare_ngn) ?? 0), 0);
    const net = rs.reduce((a, r) => a + (n(r.commission_ngn) ?? 0) + (n(r.booking_fee_ngn) ?? 0), 0);
    return { date: s(d.date), trips: rs.length, faresNgn: Math.round(fares), wheelersNetNgn: Math.round(net) };
  });
  const faresByMethod = [...groupBy(done, (r) => s(r.final_payment_method_key) || 'unknown').entries()].map(([method, rs]) => ({ method, trips: rs.length, faresNgn: Math.round(rs.reduce((a, r) => a + (n(r.agreed_fare_ngn) ?? 0), 0)) }));
  const channelOf = (tripId: string) => s(intents.get(s(tripById.get(tripId)?.session_id))?.channel_key) || 'unknown';
  const netByChannel = [...groupBy(done, (r) => channelOf(s(r.trip_id))).entries()].map(([channel, rs]) => ({ channel, trips: rs.length, netPerTripNgn: rs.length ? Math.round(rs.reduce((a, r) => a + (n(r.commission_ngn) ?? 0) + (n(r.booking_fee_ngn) ?? 0), 0) / rs.length) : null }));
  const walletMovements = [...groupBy(ledger, (r) => s(r.entry_type)).entries()].map(([type, rs]) => ({ type, entries: rs.length, amountNgn: Math.round(rs.reduce((a, r) => a + (n(r.entry_amount_ngn) ?? 0), 0)) }));
  const paymentsByMethod = [...groupBy(payments, (r) => `${s(r.payment_method_key)}|${s(r.payment_type)}`).entries()].map(([k, rs]) => ({ method: k.split('|')[0], type: k.split('|')[1], count: rs.length, amountNgn: Math.round(rs.reduce((a, r) => a + (n(r.payment_amount_ngn) ?? 0), 0)) }));

  /* rider behaviour */
  const byChannel = [...groupBy(sessions, (r) => s(intents.get(s(r.intent_id))?.channel_key) || 'unknown').entries()].map(([channel, rs]) => ({ channel, ...rate(rs) }));
  const sunkTime = bandRates(sessions.filter((r) => n(r.time_to_first_offer_sec) !== null), (r) => n(r.time_to_first_offer_sec), WAIT);
  const peakEnd = inOrder(groupBy(trips.filter((r) => n(r.rider_rating_of_driver) !== null), (r) => band(n(r.pickup_delay_min), DELAY)), DELAY.map((b) => b[0])).map(([label, rs]) => ({ band: label, rated: rs.length, avgRating: avg(rs.map((r) => n(r.rider_rating_of_driver)!)) }));

  /* every search */
  const table = sessions.slice(-500).reverse().map((r) => ({
    session_id: s(r.session_id), created_at: s(r.created_at), outcome: s(r.session_outcome_key), channel: s(intents.get(s(r.intent_id))?.channel_key),
    km: n(r.route_distance_km), suggested_ngn: n(r.suggested_fare_ngn), opening_ngn: n(r.initial_rider_price_ngn), final_ngn: n(r.final_rider_price_ngn),
    agreed_ngn: n(tripById.get(s(r.session_id))?.agreed_fare_ngn), first_offer_sec: n(r.time_to_first_offer_sec), match_sec: n(r.time_to_match_sec),
  }));

  return {
    totals: { searches: sessions.length, matched: sessions.filter(matched).length, completed: done.length, offers: offers.length, matchRate: share(sessions.filter(matched).length, sessions.length) },
    demand: { byDay: demandByDay, outcomes, byHour, byWeekday, funnel, grid, dayParts: dayPartOrder },
    prices: { openingVsSuccess, priceMoves, fareSize, finalVsSuggested, offerVsSuggested, perKm, roundness },
    offers: { statusMix, fateByGap, counters, choiceOverload, premiumByRating, premiumByDistance, decisionSec: { offers: decision.length, avg: avg(decision), median: decision.sort((a, b) => a - b)[Math.floor(decision.length / 2)] ?? null } },
    supply: { byDay: supplyByDay },
    money: { byDay: moneyByDay, faresByMethod, netByChannel, walletMovements, paymentsByMethod },
    riders: { byChannel, sunkTime, peakEnd },
    table,
  };
}
export type Studio = ReturnType<typeof buildStudio>;
