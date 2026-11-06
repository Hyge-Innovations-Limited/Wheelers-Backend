/**
 * Wheelers pricing, version 2 (since 2026-10-10).
 *
 * A fare is what the RIDER pays: one number, shown to them with no lines.
 * It is built from the driver's rate per km:
 *
 *   trip fare      = rate per km × distance            ₦350 × 10 km = ₦3,500
 *   + VAT 7.5% of the trip fare                                      ₦262.50
 *   + service charge (Wheelers')                                     ₦350
 *   = the fare, rounded up to ₦50                                    ₦4,150
 *
 * and taken apart the same way when the trip is paid: the booking fee comes
 * off, what is left is trip fare + VAT (so the trip fare is it ÷ 1.075), and
 * from the trip fare the driver gives up 10% commission and the ₦30 Lagos
 * levy. VAT and the booking fee are the rider's cost, never the driver's.
 *
 * Everything is worked from the fare alone, so a rider's own price, a
 * driver's per-km bid and an older app's total bid all settle by one rule.
 * (The few naira of rounding stay in the fare: they raise the trip fare and
 * its VAT a little, so the books always add up to what the rider paid.)
 *
 * Version 1 (rides requested before the switch) is kept below: those rides
 * settle exactly as they were agreed.
 *
 * What a trip is SUGGESTED at is the highest of three numbers (see
 * calculateSuggestedFare): the market floor (what inDrive would charge, plus
 * a premium), the rules (the base rate lifted by traffic and a busy area)
 * and, once switched on, the model. The floor is never undercut.
 */
import { holidayOn } from './calendar';
import { candidateFares, chooseFare, getPricingMlModel, steadyDraw } from './pricing-ml';
import { PRICING_AREAS, pricingAreaOf, type PricingAreaKey } from './pricing-areas';

export type PricingVersion = 1 | 2 | 3 | 4;
export const CURRENT_PRICING_VERSION: PricingVersion = 4;

/**
 * A ride's pricing version as stored or sent (a number, a string, or
 * nothing): 1, 2, 3 or 4. A ride with none was priced before versions were
 * kept, the version 2 rules; anything unknown is today's.
 */
export function pricingVersionOf(value: unknown): PricingVersion {
  if (value === null || value === undefined || value === '') return 2;
  const n = Number(value);
  return n === 1 || n === 2 || n === 3 || n === 4 ? n : CURRENT_PRICING_VERSION;
}

/** The recommended rate per km on a free road. */
export const RATE_PER_KM_NGN = 375;
/** A rider may offer no less than this share of the recommended rate; a driver may ask no more than MAX_COUNTER_SHARE of it. */
export const MIN_OFFER_SHARE = 0.9;
export const MAX_COUNTER_SHARE = 1.5;
/** Old name for the driver ceiling as a rate: 150% of the base rate. */
export const MAX_RATE_PER_KM_NGN = Math.round(RATE_PER_KM_NGN * MAX_COUNTER_SHARE);
/** Wheelers' flat service charge, in every fare, charged to the rider. (Called the booking fee in older code.) */
export const BOOKING_FEE_NGN = 350;
/** Version 1 rides were agreed with a ₦375 booking fee. */
const V1_BOOKING_FEE_NGN = 375;
const bookingFeeOf = (version: PricingVersion) => (version === 1 ? V1_BOOKING_FEE_NGN : BOOKING_FEE_NGN);
/** The booking fee is the platform's part of a suggested fare. (Old name.) */
export const PLATFORM_FEE_NGN = BOOKING_FEE_NGN;
/** Old name: how far below the suggested fare a rider may go. */
export const MIN_OFFER_DISCOUNT = 1 - MIN_OFFER_SHARE;
/**
 * Hard floor on what any ride can cost the rider, regardless of distance.
 * Short trips would otherwise leave the driver nothing for their time.
 */
export const MIN_FARE_NGN = 3300;
/** Fares shown to riders are rounded up to this. */
export const FARE_ROUNDING_INCREMENT = 50;
export const SERVICE_FEE_NGN = BOOKING_FEE_NGN; // the booking fee's old name
/** 5% of the trip fare, from the driver (version 3, from 21 Oct 2026). */
export const COMMISSION_RATE = 0.05;
export const PLATFORM_FEE_RATE = COMMISSION_RATE; // old name
/** Version 2 (10 to 21 Oct 2026): 10% of the trip fare. */
const V2_COMMISSION_RATE = 0.1;
/** Version 3: a flat ₦300 from the driver on every ride, the WhatsApp fee. */
export const WHATSAPP_FEE_NGN = 300;
const commissionRateOf = (version: PricingVersion) => (version === 1 ? V1_COMMISSION_RATE : version === 2 ? V2_COMMISSION_RATE : COMMISSION_RATE);
const whatsappFeeOf = (version: PricingVersion) => (version === 3 ? WHATSAPP_FEE_NGN : 0);
/** 7.5% of the trip fare, added to the rider's fare. */
export const VAT_RATE = 0.075;
export const LAGOS_STATE_FEE_NGN = 30; // ₦30 flat per ride, from the driver

/** Version 1: 4% commission and 7.5% VAT, both taken from the driver's share (fare − booking fee). */
const V1_COMMISSION_RATE = 0.04;

// ── The recommended rate (traffic and demand are switches, off by default) ──

const flag = (name: string) => (process.env[name] ?? '').trim().toLowerCase() === 'on';
/** The recommended rate rises on slow roads: switched on in the admin's pricing settings (or PRICING_TRAFFIC_FACTOR=on). */
export const trafficFactorOn = () => flag('PRICING_TRAFFIC_FACTOR') || pricingSettings.trafficOn;
/** The recommended rate follows demand in the area: the admin's pricing settings (or PRICING_DEMAND_FACTOR=on). */
export const demandFactorOn = () => flag('PRICING_DEMAND_FACTOR') || pricingSettings.demandOn;

// ── Pricing settings (owners edit them in the admin; each service reloads them) ──

/** Another app's fare for a trip, as base + per km + per minute. */
export type MarketFormula = { baseNgn: number; perKmNgn: number; perMinuteNgn: number };

/**
 * The model: a small linear fit of ln(rate per km a trip is agreed at), trained
 * offline from Wheelers' own quotes and bids (scripts/train-pricing-model.mjs).
 * It is a handful of numbers, scored here in a few multiplications.
 */
export type PricingModel = {
  trainedAt: string;
  /** Real agreed trips it was fitted on. */
  rows: number;
  /** True while made-up trips from the simulator still carry part of the fit (fewer than 300 real ones). */
  seeded: boolean;
  intercept: number;
  coef: { lnKm: number; minPerKm: number; lnDemand: number; rush: number; night: number; weekend: number };
};

export type AreaFactors = { pickup: number; dropoff: number };

/** No area factor above this, whatever is saved. */
export const AREA_FACTOR_MAX = 2;

/** The parts of a Lagos day, each of which may carry its own premium. */
export type DayPeriod = 'morning' | 'afternoon' | 'evening' | 'night';
export const DAY_PERIODS: readonly DayPeriod[] = ['morning', 'afternoon', 'evening', 'night'];
/** A premium in naira: fixed when min and max are the same. */
export type PremiumRange = { minNgn: number; maxNgn: number };

/** The highest premium a part of the day may carry, in naira. */
export const PERIOD_PREMIUM_MAX_NGN = 10_000;

/**
 * The price by the clock: a multiplier on the other app's quiet-hour figures
 * for each hour of the day (0–23, Lagos time), one list for weekdays, one for
 * Saturdays (`weekend`, its old name) and one for Sundays and public holidays.
 * A curve saved before Sundays were learned apart has no `sunday`: Sundays
 * then read the Saturday list until the next fit.
 */
export type HourCurve = { weekday: number[]; weekend: number[]; sunday?: number[] };

/** How far over the higher of Linc and inDrive a price may go, unless an owner sets it (npm run pricing ceiling). */
export const CEILING_ABOVE_NGN = 1_000;

/**
 * Where a trip sits for Linc's price (6 Nov: one formula was ±20% per trip). Short trips carry
 * Linc's high base; outer areas are cheap per km; the Island costs more; central is the rest.
 */
export type LincZone = 'short' | 'central' | 'island' | 'outer';
export const LINC_ZONES: readonly LincZone[] = ['short', 'central', 'island', 'outer'];
/** Under this many km a trip is short, wherever it is. */
export const LINC_SHORT_KM = 8;
const LINC_OUTER_AREAS: ReadonlySet<string> = new Set(['alimosho', 'ikorodu', 'ajah', 'epe', 'ibeju-lekki', 'badagry']);
const LINC_ISLAND_AREAS: ReadonlySet<string> = new Set(['eti-osa', 'lekki', 'lagos-island']);

/** The trip's Linc zone: short first, then an outer end, then an Island end, else central. */
export function lincZoneOf(km: number, origin?: { lat: number; lng: number }, destination?: { lat: number; lng: number }): LincZone {
  if (km < LINC_SHORT_KM) return 'short';
  const keys = [origin, destination].map((point) => (point ? pricingAreaOf(point.lat, point.lng)?.key : undefined));
  if (keys.some((key) => key !== undefined && LINC_OUTER_AREAS.has(key))) return 'outer';
  if (keys.some((key) => key !== undefined && LINC_ISLAND_AREAS.has(key))) return 'island';
  return 'central';
}

/** One price read off Linc: the trip, what it cost, when (ISO), and its zone (by its km alone when not said). */
export type LincSample = { km: number; minutes: number; priceNgn: number; at: string; zone?: LincZone };
export const lincSampleZone = (sample: LincSample): LincZone => sample.zone ?? (sample.km < LINC_SHORT_KM ? 'short' : 'central');

/** The Linc prices seen while building the guide (24–26 Oct 2026, Lagos). */
export const LINC_SAMPLES_SEEN: readonly LincSample[] = [
  // Opebi to Ijeshatedo, Saturday midday.
  { km: 20.2, minutes: 37, priceNgn: 9000, at: '2026-10-24T10:40:00Z', zone: 'central' },
  { km: 20.2, minutes: 37, priceNgn: 9200, at: '2026-10-24T11:14:00Z', zone: 'central' },
  { km: 20.2, minutes: 37, priceNgn: 9750, at: '2026-10-24T11:20:00Z', zone: 'central' },
  { km: 20.2, minutes: 37, priceNgn: 9350, at: '2026-10-24T11:23:00Z', zone: 'central' },
  { km: 19.2, minutes: 31, priceNgn: 8100, at: '2026-10-25T08:50:00Z', zone: 'central' },
  // Into Alagbado, Sunday evening.
  { km: 16.6, minutes: 48, priceNgn: 11450, at: '2026-10-25T17:46:00Z', zone: 'outer' },
  { km: 16.6, minutes: 52, priceNgn: 13050, at: '2026-10-25T17:55:00Z', zone: 'outer' },
  // Ikorodu (Orupodi) to Opebi, a weekday night, before its ₦1,000 ride bonus.
  { km: 30, minutes: 54, priceNgn: 12950, at: '2026-11-04T02:30:00Z', zone: 'outer' },
  // Friday evening, read off Linc's WhatsApp (the price the rider pays, after Linc's bonus).
  // Our Linc copy priced these 30% over: it weighed minutes in traffic far too heavily.
  { km: 16.9, minutes: 44, priceNgn: 8145, at: '2026-11-06T18:11:00Z', zone: 'outer' },    // Idimu → Ikeja Along
  { km: 19.2, minutes: 63, priceNgn: 11100, at: '2026-11-06T18:14:00Z', zone: 'island' },  // Lekki Phase 1 → Unilag
  { km: 29.8, minutes: 64, priceNgn: 15450, at: '2026-11-06T18:15:00Z', zone: 'island' },  // Ikeja City Mall → Eko Hotel, VI
];

/**
 * Linc's figures fitted from its prices: least squares on base, per km and
 * per minute, none below 0 (a figure that comes out negative is dropped and
 * the rest fitted again). A price seen at night is taken back to its daytime
 * price first (÷ nightLift), so the figures are the daytime ones. Null with
 * fewer than 3 prices.
 */
/**
 * opts.minutes false: base + per km only. Linc seems to price on distance and barely on time in
 * traffic (6 Nov: Lekki to Unilag, 63 minutes in traffic, was under a per-minute copy by 11%).
 */
export function fitLincFigures(samples: readonly LincSample[], nightLift = 1, opts: { minutes?: boolean } = {}): MarketFormula | null {
  // Short trips carry Linc's high base and have their own zone lift: fitted with the rest they
  // pulled the base up for every trip (a 6.4 km price put Idimu back from ₦9,200 to ₦10,150).
  const rows = samples
    .filter((s) => s.km > 0 && s.minutes > 0 && s.priceNgn > 0 && lincSampleZone(s) !== 'short')
    .map((s) => (isNightHour(lagosHourOf(s.at)) ? { ...s, priceNgn: s.priceNgn / nightLift } : s));
  if (rows.length < 3) return null;
  const solve = (use: [boolean, boolean, boolean]): number[] | null => {
    const cols = [0, 1, 2].filter((i) => use[i]);
    const x = (s: LincSample) => [1, s.km, s.minutes].filter((_, i) => use[i]);
    const n = cols.length;
    const a = Array.from({ length: n }, () => Array(n + 1).fill(0) as number[]);
    for (const s of rows) {
      const v = x(s);
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) a[i]![j]! += v[i]! * v[j]!;
        a[i]![n]! += v[i]! * s.priceNgn;
      }
    }
    for (let i = 0; i < n; i++) {
      let p = i;
      for (let r = i + 1; r < n; r++) if (Math.abs(a[r]![i]!) > Math.abs(a[p]![i]!)) p = r;
      [a[i], a[p]] = [a[p]!, a[i]!];
      if (Math.abs(a[i]![i]!) < 1e-9) return null;
      for (let r = 0; r < n; r++) {
        if (r === i) continue;
        const f = a[r]![i]! / a[i]![i]!;
        for (let c = i; c <= n; c++) a[r]![c]! -= f * a[i]![c]!;
      }
    }
    const out = [0, 0, 0];
    cols.forEach((col, i) => { out[col] = a[i]![n]! / a[i]![i]!; });
    return out;
  };
  let use: [boolean, boolean, boolean] = [true, true, opts.minutes !== false];
  for (let tries = 0; tries < 3; tries++) {
    const fit = solve(use);
    if (!fit) return null;
    const negative = fit.findIndex((v, i) => use[i] && v < 0);
    if (negative === -1) return { baseNgn: Math.round(fit[0]!), perKmNgn: Math.round(fit[1]!), perMinuteNgn: Math.round(fit[2]!) };
    use = use.map((u, i) => u && i !== negative) as [boolean, boolean, boolean];
  }
  return null;
}

/** The Lagos hour of an ISO time (Lagos is UTC+1 all year). */
function lagosHourOf(iso: string): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t + 3_600_000).getUTCHours() : 12;
}

/** Prices in a part of the day before its own Linc lift is learned (fewer: the night lift, or 1). */
export const LINC_PERIOD_MIN_PRICES = 2;

/** A part of the day on a weekday, or on a weekend or holiday: Linc's mornings differ (a Tuesday's +43%, a Saturday's none). */
export type LincSlot = `${'weekday' | 'weekend'}-${DayPeriod}`;
export const LINC_SLOTS: readonly LincSlot[] = (['weekday', 'weekend'] as const).flatMap((day) => DAY_PERIODS.map((p) => `${day}-${p}` as LincSlot));

export function lincSlotOf(at: Date): LincSlot {
  return `${lagosClock(at).weekend ? 'weekend' : 'weekday'}-${dayPeriodOf(at)}`;
}

const lincLiftCache = new WeakMap<object, { lifts: Record<LincSlot, number>; counts: Record<LincSlot, number> }>();
const lincZoneCache = new WeakMap<object, { lifts: Record<LincZone, number>; counts: Record<LincZone, number> }>();
/** A zone's lift is learned from this many of its prices; until then ×1. */
export const LINC_ZONE_MIN_PRICES = 2;

/**
 * Linc's price by zone: for each zone, the middle of how far its prices sat from Linc's figures
 * (after the time of day), from LINC_ZONE_MIN_PRICES of them; until then 1. Between ×0.7 and ×1.5.
 */
export function lincZoneLifts(settings: PricingSettings = pricingSettings): { lifts: Record<LincZone, number>; counts: Record<LincZone, number> } {
  const cached = lincZoneCache.get(settings);
  if (cached) return cached;
  const periods = lincPeriodLifts(settings).lifts;
  const ratios = Object.fromEntries(LINC_ZONES.map((zone) => [zone, [] as number[]])) as Record<LincZone, number[]>;
  for (const sample of settings.lincSamples) {
    const at = new Date(sample.at);
    const guess = lincFareNgn(sample.km, sample.minutes, settings.linc) * (Number.isNaN(at.getTime()) ? 1 : periods[lincSlotOf(at)]);
    if (guess > 0) ratios[lincSampleZone(sample)].push(sample.priceNgn / guess);
  }
  const lifts = {} as Record<LincZone, number>;
  const counts = {} as Record<LincZone, number>;
  for (const zone of LINC_ZONES) {
    const list = ratios[zone].sort((a, b) => a - b);
    counts[zone] = list.length;
    const middle = list.length % 2 ? list[(list.length - 1) / 2]! : ((list[list.length / 2 - 1] ?? 1) + (list[list.length / 2] ?? 1)) / 2;
    lifts[zone] = list.length >= LINC_ZONE_MIN_PRICES ? Math.round(Math.min(1.5, Math.max(0.7, middle)) * 100) / 100 : 1;
  }
  const out = { lifts, counts };
  lincZoneCache.set(settings, out);
  return out;
}

/**
 * Linc's price moves with the time of day and the day (Opebi to Ijeshatedo:
 * ₦7,950 on a Monday night, ₦9,350 on Saturday midday, ₦11,100 on a Tuesday
 * morning). For each part of the day (morning 05–12, afternoon 12–16,
 * evening 16–21, night), on weekdays and on weekends apart, the middle of how
 * far Linc's prices then sat from its figures, from LINC_PERIOD_MIN_PRICES of
 * them; until then 1, and lincNightLift at night. Between ×0.8 and ×1.6.
 * Every Linc price saved teaches its own part of the day.
 */
export function lincPeriodLifts(settings: PricingSettings = pricingSettings): { lifts: Record<LincSlot, number>; counts: Record<LincSlot, number> } {
  const cached = lincLiftCache.get(settings);
  if (cached) return cached;
  const ratios = Object.fromEntries(LINC_SLOTS.map((slot) => [slot, [] as number[]])) as Record<LincSlot, number[]>;
  for (const s of settings.lincSamples) {
    const at = new Date(s.at);
    const guess = lincFareNgn(s.km, s.minutes, settings.linc);
    if (Number.isNaN(at.getTime()) || guess <= 0) continue;
    ratios[lincSlotOf(at)].push(s.priceNgn / guess);
  }
  const lifts = {} as Record<LincSlot, number>;
  const counts = {} as Record<LincSlot, number>;
  for (const slot of LINC_SLOTS) {
    const list = ratios[slot].sort((a, b) => a - b);
    counts[slot] = list.length;
    const fallback = slot.endsWith('night') ? settings.lincNightLift : 1;
    const middle = list.length % 2 ? list[(list.length - 1) / 2]! : ((list[list.length / 2 - 1] ?? fallback) + (list[list.length / 2] ?? fallback)) / 2;
    lifts[slot] = list.length >= LINC_PERIOD_MIN_PRICES ? Math.round(Math.min(1.6, Math.max(0.8, middle)) * 100) / 100 : fallback;
  }
  const out = { lifts, counts };
  lincLiftCache.set(settings, out);
  return out;
}

/** What Linc would charge for a trip, on its fitted (daytime) figures. */
export const lincFareNgn = (km: number, minutes: number, f: MarketFormula) => f.baseNgn + f.perKmNgn * km + f.perMinuteNgn * minutes;

/** Linc's price before its ride bonus, from the price it shows (lincBonusPercent; the shown price when 0). */
export function lincFullPriceNgn(shownNgn: number, settings: Pick<PricingSettings, 'lincBonusPercent' | 'lincBonusCapNgn'> = pricingSettings): number {
  if (!(settings.lincBonusPercent > 0)) return shownNgn;
  return Math.min(shownNgn / (1 - settings.lincBonusPercent / 100), shownNgn + settings.lincBonusCapNgn);
}

/** Which list of the curve a day reads: Saturdays are busy into the evening, Sundays and holidays quiet. */
export type DayKind = 'weekday' | 'saturday' | 'sunday';

/** The 24 multipliers for a kind of day. */
export function curveDay(curve: HourCurve, kind: DayKind): number[] {
  if (kind === 'weekday') return curve.weekday;
  return kind === 'saturday' ? curve.weekend : curve.sunday ?? curve.weekend;
}

/** The curve's multiplier at a moment, Lagos time. */
export function curveValueAt(curve: HourCurve, at: Date): number {
  const { hour, dayKind } = lagosClock(at);
  return curveDay(curve, dayKind)[hour] ?? 1;
}
/**
 * At most this far under the other app's quiet-hour figures: an hour really
 * cheaper there (late at night, say) may come down, but only on enough prices
 * (hour-curve.ts) and never more than 10%.
 */
export const HOUR_CURVE_MIN = 0.9;
/** At most this far above the quiet-hour figures on a weekday, however many prices say otherwise: an hour can never run away. */
export const HOUR_CURVE_MAX = 1.15;
/**
 * The same on a weekend or holiday, and at night. Higher: Saturday evenings
 * were measured costing more on the other app than any weekday hour, and a
 * weekend hour held at +15% left us ₦1,500 under it; nights were under too.
 * Reached only on prices, at most 15% a night.
 */
export const WEEKEND_HOUR_CURVE_MAX = 1.6;

/** Night, Lagos time: 22:00 to 05:00. Fewer drivers out, and the other apps charge more. */
export const isNightHour = (hour: number) => hour >= 22 || hour < 5;

/** Where a night hour starts before prices teach it: the other apps charge more at night, so it never starts at the quiet rate. */
export const NIGHT_START = 1.15;

/** The high-end reading of the other app: at most this far over our guess, and learned from this many of its prices. */
export const MARKET_HIGH_MAX = 1.3;
export const MARKET_HIGH_MIN_PRICES = 5;

/**
 * The high end of the other app's prices, from how far each sat from our
 * guess (price ÷ guess): the top tenth (nearest rank), never under 1 nor over
 * MARKET_HIGH_MAX. Null with fewer than MARKET_HIGH_MIN_PRICES.
 */
export function marketHighFrom(ratios: number[]): number | null {
  const ok = ratios.filter((r) => Number.isFinite(r) && r > 0.4 && r < 3).sort((a, b) => a - b);
  if (ok.length < MARKET_HIGH_MIN_PRICES) return null;
  const top = ok[Math.min(ok.length - 1, Math.ceil(0.9 * ok.length) - 1)]!;
  return Math.round(Math.min(MARKET_HIGH_MAX, Math.max(1, top)) * 100) / 100;
}

export type Rain = 'none' | 'light' | 'heavy';
/** Where the rain lift starts, and the most it may be learned to. */
export const RAIN_START = 1.15;
export const RAIN_LIFT_MAX = 1.6;

/** The most an hour may reach: weekdays' daytime +15%, weekends, holidays and nights +60%. */
export const hourCurveMax = (weekend: boolean, hour?: number) =>
  weekend || (hour !== undefined && isNightHour(hour)) ? WEEKEND_HOUR_CURVE_MAX : HOUR_CURVE_MAX;
/** The live surge may never be set to lift a price past this, whatever is saved. */
export const SURGE_MAX_LIMIT = 2;
/** Nor to take more than this off, whatever is saved: a quiet market lowers a price, it never gives rides away. */
export const SURGE_MIN_LIMIT = 0.8;

export type PricingSettings = {
  /** Never suggest less than the market fare + the premium. */
  marketFloorOn: boolean;
  /** How far above the market fare the floor sits, in naira per trip. */
  premiumNgn: number;
  /**
   * A premium of its own for a part of the day (dayPeriodOf), in place of
   * premiumNgn then: a fixed amount (min = max) or a range the trip's
   * conditions place it in (premiumFor). A part not named here takes premiumNgn.
   */
  periodPremiums: Partial<Record<DayPeriod, PremiumRange>>;
  /** inDrive's fare outside rush hours, and in them (weekdays 07–10 and 16–20, Lagos time). */
  quiet: MarketFormula;
  rush: MarketFormula;
  /**
   * The price by the clock. On: the other app's fare is its quiet-hour
   * figures times this hour's multiplier (hourCurve), in place of the
   * rush/quiet pair. The gateway learns the curve again each night from what
   * trips cost (npm run pricing curve).
   */
  hourCurveOn: boolean;
  hourCurve: HourCurve | null;
  /** When the curve was last learned. */
  hourCurveFittedAt: string | null;
  /**
   * Holidays priced as weekends beyond the calendar's own (calendar.ts): days
   * declared on the day, such as an Eid moved by the moon (YYYY-MM-DD, Lagos).
   * `notHolidays` takes a calendar day off, when the guess was wrong.
   */
  holidays: string[];
  notHolidays: string[];
  /**
   * Rain: while it rains at the pickup (weather.ts reads each zone every 15
   * minutes), the other app's fare is taken to be rainLift times higher,
   * heavy rain 10% more again. rainLift is learned each night from prices
   * seen in the rain (hour-curve.ts); it starts at 1.15.
   */
  rainOn: boolean;
  rainLift: number;
  rainLiftFittedAt: string | null;
  /**
   * The live surge: our own riders against our own drivers, and how drivers
   * bid, move the other app's fare: up to surgeMax times when busy, down to
   * surgeMin times when quiet (drivers online and idle, nobody asking, or
   * drivers bidding under offers). The gateway measures it every two
   * minutes (npm run pricing surge). surgeMin 1: it only ever lifts.
   */
  surgeOn: boolean;
  surgeMax: number;
  surgeMin: number;
  trafficOn: boolean;
  demandOn: boolean;
  /** Off: the model's number is only recorded beside each quote (shadow). On: it may lift the fare. */
  modelOn: boolean;
  model: PricingModel | null;
  /** The rules and the model may lift a fare to at most this many times the floor. 1: never past the floor. */
  liftCap: number;
  /**
   * With the model on, the most it may take off today's price for a trip, in
   * naira. (Never more than a tenth of the fare either, so a short trip is
   * not cut by as much as a long one.)
   */
  maxDiscountNgn: number;
  /**
   * With the model on, the least a price may sit above the other app's fare:
   * a cut stops here. It is also the most a rider may then bargain away, so
   * an offer never goes under the other app.
   */
  modelPremiumNgn: number;
  /**
   * How far under the suggested fare a rider may offer, in naira: the
   * minimum offer is the suggested fare less this (never under the minimum
   * fare). 0 goes back to the older rule: a tenth off, and with the floor on
   * no more than the premium.
   */
  minOfferGapNgn: number;
  /** What a completed ride is worth to Wheelers beyond what it earns on it: the higher, the readier the model is to cut. */
  rideValueNgn: number;
  /**
   * The parts of Lagos where drivers are few and come back empty (Ikorodu,
   * Epe, Ibeju-Lekki, Badagry): a trip picked up there is multiplied by its
   * pickup factor, one dropped off there by its drop-off factor, the larger
   * of the two. 1 is no change. Set with npm run pricing area.
   */
  areas: Record<PricingAreaKey, AreaFactors>;
  /**
   * With the model on, the share of trips shown a price OTHER than the
   * model's pick: one of the other prices inside the same limits. Without
   * these the model only ever sees what happens at its own prices and can
   * never learn whether another would have done better. 0 switches it off.
   */
  trialShare: number;
  /**
   * A flat amount added to every suggested price after everything else has
   * worked it out (the floor, the curve, the surge, the premium, the model).
   * Part of the fare, so the driver keeps it less the usual commission. 0: none.
   */
  extraNgn: number;
  /**
   * A share of the other app's fare added on top (5 = 5%), with the flat
   * extra: it grows as the fare grows (traffic, the hour, a weekend, rain,
   * the surge), so we stay ahead of a rising market instead of by a fixed
   * amount. 0: none.
   */
  marginPercent: number;
  /**
   * The other app's high end, as a share of our guess: the same trip costs
   * different amounts there minute to minute (₦7,500 to ₦8,800 for one 20 km
   * trip). No price is ever suggested under it: a floor, not a lift, so with
   * the margin and the extra already above it nothing changes. Learned each
   * night (pricing.client, learnHourCurve) as the top tenth of how far its
   * real prices sat from our guess, from MARKET_HIGH_MIN_PRICES of them; 1
   * until then; at most MARKET_HIGH_MAX; 15% a night.
   */
  marketHigh: number;
  marketHighFittedAt: string | null;
  /**
   * Linc as the guide (off until switched on): the price is what Linc would
   * charge for the trip, Linc's figures on Google's live minutes, times our
   * own live surge and rain, plus lincAboveNgn; never under the other app's
   * high end. The flat extra and the margin, stand-ins for Linc, are then
   * not added. Linc charges by the minute, nearly not by the km: fitted from
   * its prices on 24–26 Oct, ₦1,150 + ₦36 a km + ₦202 a minute.
   */
  lincOn: boolean;
  linc: MarketFormula;
  /** Where we sit against Linc's price for the trip: 0 the same, 500 ₦500 above, -300 under. */
  lincAboveNgn: number;
  /**
   * Linc's price by zone (short, central, island, outer), each zone's lift learned from its own
   * prices (lincZoneLifts). Off until enough prices are tagged with their zone (npm run pricing linc zones on).
   */
  lincZonesOn: boolean;
  /**
   * How far above Linc's price we aim, in percent (8: Linc ×1.08), before lincAboveNgn.
   * A percentage, not a flat sum: ₦500 is 10% on a short trip and 4% on a long one.
   */
  lincAbovePercent: number;
  /**
   * The most over Linc's price a fare may be, in percent (12): the ceiling is never under
   * Linc ×(1 + this), so the aim above stands on long trips. Null: the ₦ ceiling alone.
   */
  lincMaxAbovePercent: number | null;
  /**
   * Linc's ride bonus, in percent of its full price, at most lincBonusCapNgn (6 Nov: 10%, ₦1,000;
   * "₦3,420 · ₦380 bonus" is ₦3,800 before the bonus). Its prices are saved as shown, after the
   * bonus; with this set, Linc's price for a trip (the guide and the ceiling) is its full price.
   * 0: the price as shown.
   */
  lincBonusPercent: number;
  lincBonusCapNgn: number;
  /** How much more Linc charges at night (22:00–05:00): ₦7,950 at 23:03 where its daytime figures said ₦6,758. */
  lincNightLift: number;
  /** Linc prices read off its app (npm run pricing linc sample), what its figures are fitted from. */
  lincSamples: LincSample[];
  /**
   * The ceiling: no price more than this over the higher of what Linc and
   * inDrive would charge for the trip (their figures on the live minutes, the
   * hour, our surge and rain; not our own area lift). The lifts multiply (an
   * outer area, the night, the high end) and nothing else stops them: 30 km
   * from Ikorodu at night was ₦17,850 where the apps asked ₦13–15k. It beats
   * every lift, the high end included. null: off.
   */
  ceilingAboveNgn: number | null;
};

/** A cut is never more than this share of the fare. */
const MODEL_MAX_DISCOUNT_SHARE = 0.1;

/**
 * With nothing saved, pricing is the plain rate per km. The figures for the
 * other app come from two real quotes (15.5 km in 23 min on a clear road,
 * ₦5,800; 16 km in 33 min, ₦7,200), which is thin: they are meant to be
 * replaced with regularly sampled ones. The pricing model was trained with
 * these (ml/pricing/world.py).
 */
export const DEFAULT_PRICING_SETTINGS: PricingSettings = {
  marketFloorOn: false,
  premiumNgn: 300,
  periodPremiums: {},
  quiet: { baseNgn: 500, perKmNgn: 268, perMinuteNgn: 50 },
  rush: { baseNgn: 575, perKmNgn: 308, perMinuteNgn: 58 },
  hourCurveOn: false,
  hourCurve: null,
  hourCurveFittedAt: null,
  holidays: [],
  notHolidays: [],
  rainOn: true,
  rainLift: RAIN_START,
  rainLiftFittedAt: null,
  surgeOn: false,
  surgeMax: 1.4,
  surgeMin: 0.9,
  trafficOn: false,
  demandOn: false,
  modelOn: false,
  model: null,
  liftCap: 1.5,
  maxDiscountNgn: 700,
  modelPremiumNgn: 150,
  minOfferGapNgn: 850,
  rideValueNgn: 500,
  trialShare: 0.1,
  extraNgn: 0,
  marginPercent: 0,
  marketHigh: 1,
  marketHighFittedAt: null,
  lincOn: false,
  // Fitted from LINC_SAMPLES_SEEN (npm run pricing linc fit), 6 Nov: was ₦1,150 + ₦36/km + ₦202/min,
  // nearly all minutes, which priced slow trips 30% over Linc.
  linc: { baseNgn: 2088, perKmNgn: 81, perMinuteNgn: 147 },
  lincZonesOn: false,
  lincAboveNgn: 0,
  lincAbovePercent: 0,
  lincMaxAbovePercent: null,
  lincBonusPercent: 0,
  lincBonusCapNgn: 1000,
  lincNightLift: 1.15,
  lincSamples: [...LINC_SAMPLES_SEEN],
  ceilingAboveNgn: CEILING_ABOVE_NGN,
  // A first guess from one real afternoon (Ikorodu: other apps ₦16k+, us ₦10k).
  // Tune with real prices: npm run pricing sample … AREA, then npm run pricing area-fit.
  areas: {
    ikorodu: { pickup: 1.65, dropoff: 1.5 },
    epe: { pickup: 1.7, dropoff: 1.5 },
    'ibeju-lekki': { pickup: 1.5, dropoff: 1.35 },
    badagry: { pickup: 1.7, dropoff: 1.5 },
    // Inside Lagos: the standard until real prices there say otherwise (npm run pricing sample … AREA, area-fit).
    maryland: { pickup: 1, dropoff: 1 },
    ikeja: { pickup: 1, dropoff: 1 },
    surulere: { pickup: 1, dropoff: 1 },
    lekki: { pickup: 1, dropoff: 1 },
    ajah: { pickup: 1, dropoff: 1 },
    // Every other local government: the standard until set or learned.
    agege: { pickup: 1, dropoff: 1 },
    'ajeromi-ifelodun': { pickup: 1, dropoff: 1 },
    alimosho: { pickup: 1, dropoff: 1 },
    'amuwo-odofin': { pickup: 1, dropoff: 1 },
    apapa: { pickup: 1, dropoff: 1 },
    'eti-osa': { pickup: 1, dropoff: 1 },
    'ifako-ijaiye': { pickup: 1, dropoff: 1 },
    kosofe: { pickup: 1, dropoff: 1 },
    mushin: { pickup: 1, dropoff: 1 },
    ojo: { pickup: 1, dropoff: 1 },
    'oshodi-isolo': { pickup: 1, dropoff: 1 },
    shomolu: { pickup: 1, dropoff: 1 },
    'lagos-mainland': { pickup: 1, dropoff: 1 },
    'lagos-island': { pickup: 1, dropoff: 1 },
  },
};

/**
 * What a server with no saved settings prices with: the live settings of
 * 4 Nov 2026 (npm run pricing), with the ceiling. DEFAULT_PRICING_SETTINGS
 * stays the plain starting point the tests build on; a new database (another
 * server, a restore that lost the row) starts here instead, so moving servers
 * does not quietly change prices. Learned parts (the hour curve, Linc's
 * lifts) are learned again from its own prices.
 */
const UP_TO_500: PremiumRange = { minNgn: 0, maxNgn: 500 };
export const LIVE_PRICING_BASELINE: Partial<PricingSettings> = {
  marketFloorOn: true,
  premiumNgn: 1000,
  periodPremiums: { morning: UP_TO_500, afternoon: UP_TO_500, evening: UP_TO_500, night: UP_TO_500 },
  quiet: { baseNgn: 500, perKmNgn: 301, perMinuteNgn: 28 },
  rush: { baseNgn: 575, perKmNgn: 293, perMinuteNgn: 58 },
  hourCurveOn: true,
  rainOn: true,
  surgeOn: true,
  surgeMax: 1.15,
  surgeMin: 0.9,
  trafficOn: true,
  demandOn: true,
  modelOn: false,
  trialShare: 0,
  minOfferGapNgn: 900,
  extraNgn: 1400,
  marginPercent: 3,
  marketHigh: 1.17,
  lincOn: true,
  lincAboveNgn: 0,
  ceilingAboveNgn: CEILING_ABOVE_NGN,
  areas: {
    ...DEFAULT_PRICING_SETTINGS.areas,
    ikorodu: { pickup: 1.2, dropoff: 1.15 },
    epe: { pickup: 1.7, dropoff: 1.5 },
    'ibeju-lekki': { pickup: 1.5, dropoff: 1.35 },
    badagry: { pickup: 1.7, dropoff: 1.5 },
    alimosho: { pickup: 1.15, dropoff: 1.2 },
  },
};

let pricingSettings: PricingSettings = DEFAULT_PRICING_SETTINGS;

export function getPricingSettings(): PricingSettings {
  return pricingSettings;
}

const finite = (value: unknown, fallback: number, min: number, max: number): number => {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

function formulaFrom(value: unknown, fallback: MarketFormula): MarketFormula {
  const v = (value ?? {}) as Partial<MarketFormula>;
  return {
    baseNgn: finite(v.baseNgn, fallback.baseNgn, 0, 20_000),
    perKmNgn: finite(v.perKmNgn, fallback.perKmNgn, 0, 5_000),
    perMinuteNgn: finite(v.perMinuteNgn, fallback.perMinuteNgn, 0, 1_000),
  };
}

function areasFrom(value: unknown, fallback: PricingSettings['areas']): PricingSettings['areas'] {
  const saved = (value ?? {}) as Partial<Record<PricingAreaKey, Partial<AreaFactors>>>;
  const out = {} as PricingSettings['areas'];
  for (const { key } of PRICING_AREAS) {
    const v = saved[key] ?? {};
    out[key] = {
      pickup: finite(v.pickup, fallback[key].pickup, 1, AREA_FACTOR_MAX),
      dropoff: finite(v.dropoff, fallback[key].dropoff, 1, AREA_FACTOR_MAX),
    };
  }
  return out;
}

function periodPremiumsFrom(value: unknown): PricingSettings['periodPremiums'] {
  const saved = (value ?? {}) as Record<string, unknown>;
  const out: PricingSettings['periodPremiums'] = {};
  const clamp = (n: number) => Math.min(PERIOD_PREMIUM_MAX_NGN, Math.max(0, Math.round(n)));
  for (const period of DAY_PERIODS) {
    const v = saved[period];
    if (v === null || v === undefined) continue;
    // A plain number (saved before ranges existed) is a fixed amount.
    if (typeof v === 'number' || typeof v === 'string') {
      const n = Number(v);
      if (Number.isFinite(n)) out[period] = { minNgn: clamp(n), maxNgn: clamp(n) };
      continue;
    }
    const r = v as { minNgn?: unknown; maxNgn?: unknown };
    const min = Number(r.minNgn);
    const max = Number(r.maxNgn ?? r.minNgn);
    if (!Number.isFinite(min) || !Number.isFinite(max)) continue;
    out[period] = { minNgn: clamp(Math.min(min, max)), maxNgn: clamp(Math.max(min, max)) };
  }
  return out;
}

function hourCurveFrom(value: unknown): HourCurve | null {
  const v = value as Partial<HourCurve> | null | undefined;
  const list = (x: unknown, weekend: boolean) =>
    Array.isArray(x) && x.length === 24 && x.every((n) => Number.isFinite(Number(n)))
      ? x.map((n, hour) => Math.round(Math.min(hourCurveMax(weekend, hour), Math.max(HOUR_CURVE_MIN, Number(n))) * 100) / 100)
      : null;
  const weekday = list(v?.weekday, false);
  const weekend = list(v?.weekend, true);
  const sunday = list(v?.sunday, true);
  return weekday && weekend ? { weekday, weekend, ...(sunday ? { sunday } : {}) } : null;
}

function modelFrom(value: unknown): PricingModel | null {
  const v = value as PricingModel | null | undefined;
  if (!v || typeof v !== 'object' || !Number.isFinite(v.intercept) || !v.coef) return null;
  const c = v.coef as Record<string, unknown>;
  return {
    trainedAt: String(v.trainedAt ?? ''),
    rows: finite(v.rows, 0, 0, 1e9),
    seeded: v.seeded === true,
    intercept: Number(v.intercept),
    coef: {
      lnKm: finite(c.lnKm, 0, -5, 5), minPerKm: finite(c.minPerKm, 0, -5, 5), lnDemand: finite(c.lnDemand, 0, -5, 5),
      rush: finite(c.rush, 0, -5, 5), night: finite(c.night, 0, -5, 5), weekend: finite(c.weekend, 0, -5, 5),
    },
  };
}

/** Whatever was saved, made safe to price with: every number in range, anything missing at its default. */
/** A list of Lagos dates (YYYY-MM-DD): real dates only, each once, in order, the last 60. */
function datesFrom(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const real = value.filter((d): d is string => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d);
  return [...new Set(real)].sort().slice(-60);
}

export function normalizePricingSettings(value: unknown): PricingSettings {
  const v = (value ?? {}) as Partial<PricingSettings>;
  const d = DEFAULT_PRICING_SETTINGS;
  return {
    marketFloorOn: v.marketFloorOn === true,
    premiumNgn: finite(v.premiumNgn, d.premiumNgn, 0, 5_000),
    periodPremiums: periodPremiumsFrom(v.periodPremiums),
    quiet: formulaFrom(v.quiet, d.quiet),
    rush: formulaFrom(v.rush, d.rush),
    hourCurveOn: v.hourCurveOn === true,
    hourCurve: hourCurveFrom(v.hourCurve),
    hourCurveFittedAt: typeof v.hourCurveFittedAt === 'string' ? v.hourCurveFittedAt.slice(0, 40) : null,
    holidays: datesFrom(v.holidays),
    notHolidays: datesFrom(v.notHolidays),
    // On unless switched off: without readings it changes nothing.
    rainOn: v.rainOn !== false,
    rainLift: Math.round(finite(v.rainLift, d.rainLift, 1, RAIN_LIFT_MAX) * 100) / 100,
    rainLiftFittedAt: typeof v.rainLiftFittedAt === 'string' ? v.rainLiftFittedAt.slice(0, 40) : null,
    surgeOn: v.surgeOn === true,
    surgeMax: finite(v.surgeMax, d.surgeMax, 1, SURGE_MAX_LIMIT),
    surgeMin: finite(v.surgeMin, d.surgeMin, SURGE_MIN_LIMIT, 1),
    trafficOn: v.trafficOn === true,
    demandOn: v.demandOn === true,
    modelOn: v.modelOn === true,
    model: modelFrom(v.model),
    liftCap: finite(v.liftCap, d.liftCap, 1, 3),
    maxDiscountNgn: finite(v.maxDiscountNgn, d.maxDiscountNgn, 0, 3_000),
    modelPremiumNgn: finite(v.modelPremiumNgn, d.modelPremiumNgn, 0, 5_000),
    minOfferGapNgn: finite(v.minOfferGapNgn, d.minOfferGapNgn, 0, 5_000),
    rideValueNgn: finite(v.rideValueNgn, d.rideValueNgn, 0, 10_000),
    trialShare: finite(v.trialShare, d.trialShare, 0, 0.5),
    // Whole ₦50s, as every price is.
    extraNgn: Math.round(finite(v.extraNgn, d.extraNgn, 0, 5_000) / 50) * 50,
    marginPercent: Math.round(finite(v.marginPercent, d.marginPercent, 0, 50) * 10) / 10,
    marketHigh: Math.round(finite(v.marketHigh, d.marketHigh, 1, MARKET_HIGH_MAX) * 100) / 100,
    marketHighFittedAt: typeof v.marketHighFittedAt === 'string' ? v.marketHighFittedAt.slice(0, 40) : null,
    lincOn: v.lincOn === true,
    linc: {
      baseNgn: finite((v.linc as Partial<MarketFormula> | undefined)?.baseNgn, d.linc.baseNgn, 0, 10_000),
      perKmNgn: finite((v.linc as Partial<MarketFormula> | undefined)?.perKmNgn, d.linc.perKmNgn, 0, 2_000),
      perMinuteNgn: finite((v.linc as Partial<MarketFormula> | undefined)?.perMinuteNgn, d.linc.perMinuteNgn, 0, 2_000),
    },
    lincAboveNgn: Math.round(finite(v.lincAboveNgn, d.lincAboveNgn, -3_000, 5_000) / 50) * 50,
    lincAbovePercent: Math.round(finite(v.lincAbovePercent, d.lincAbovePercent, -20, 30) * 10) / 10,
    lincMaxAbovePercent: v.lincMaxAbovePercent === null || (v.lincMaxAbovePercent === undefined && d.lincMaxAbovePercent === null)
      ? null
      : Math.round(finite(v.lincMaxAbovePercent, d.lincMaxAbovePercent ?? 12, 0, 50) * 10) / 10,
    lincBonusPercent: Math.round(finite(v.lincBonusPercent, d.lincBonusPercent, 0, 50) * 10) / 10,
    lincBonusCapNgn: Math.round(finite(v.lincBonusCapNgn, d.lincBonusCapNgn, 0, 10_000) / 50) * 50,
    lincNightLift: Math.round(finite(v.lincNightLift, d.lincNightLift, 1, 1.6) * 100) / 100,
    lincZonesOn: typeof v.lincZonesOn === 'boolean' ? v.lincZonesOn : d.lincZonesOn,
    lincSamples: Array.isArray(v.lincSamples)
      ? (v.lincSamples as unknown[]).flatMap((x) => {
        const s = x as Partial<LincSample>;
        const km = Number(s.km); const minutes = Number(s.minutes); const priceNgn = Number(s.priceNgn);
        return km > 0 && km < 300 && minutes > 0 && minutes < 600 && priceNgn > 0 && priceNgn < 500_000 && typeof s.at === 'string'
          ? [{ km, minutes, priceNgn: Math.round(priceNgn), at: s.at.slice(0, 40), ...(LINC_ZONES.includes(s.zone as LincZone) ? { zone: s.zone } : {}) }]
          : [];
      }).slice(-300)
      : [...d.lincSamples],
    // Saved as null when switched off; never saved (settings from before it): the default.
    ceilingAboveNgn: v.ceilingAboveNgn === null
      ? null
      : Math.round(finite(v.ceilingAboveNgn, CEILING_ABOVE_NGN, 0, 10_000) / 50) * 50,
    areas: areasFrom(v.areas, d.areas),
  };
}

/** The trained tree model can set prices: there is one in this build and an owner has switched the model on. */
function mlPricingOn(): boolean {
  return pricingSettings.modelOn && pricingSettings.marketFloorOn && getPricingMlModel() !== null;
}

/** Each service calls this with what the database holds (and again whenever it changes). */
export function setPricingSettings(value: unknown): PricingSettings {
  pricingSettings = normalizePricingSettings(value);
  return pricingSettings;
}

/**
 * Lagos is UTC+1 all year. `weekend` is Saturday, Sunday or a public holiday
 * (calendar.ts, with the days settings add or take off): a holiday's roads
 * and prices are a weekend's (no rush hours, the weekend side of the hour
 * curve), and prices seen on one teach the weekend. `night` is 22:00–05:00.
 * `dayKind` is the list of the curve it reads: a holiday reads Sunday's.
 */
export function lagosClock(at: Date): { hour: number; weekend: boolean; dayKind: DayKind; holiday: string | null; night: boolean; date: string } {
  const local = new Date(at.getTime() + 60 * 60 * 1000);
  const day = local.getUTCDay();
  const date = local.toISOString().slice(0, 10);
  const hour = local.getUTCHours();
  const holiday = holidayOn(date, pricingSettings.holidays, pricingSettings.notHolidays);
  const dayKind: DayKind = day === 0 || holiday !== null ? 'sunday' : day === 6 ? 'saturday' : 'weekday';
  return { hour, weekend: dayKind !== 'weekday', dayKind, holiday, night: isNightHour(hour), date };
}

/** The other app's quiet-hour figures for a trip: what the hour curve multiplies. */
export function quietMarketFareNgn(distanceKm: number, minutes: number, settings: PricingSettings = pricingSettings): number {
  const f = settings.quiet;
  return f.baseNgn + f.perKmNgn * distanceKm + f.perMinuteNgn * minutes;
}

/**
 * A curve that changes nothing at first: 1 in quiet hours, and in rush hours
 * what the rush figures already charge over the quiet ones for a typical trip
 * (15 km, 40 minutes). Where a new curve starts learning from, and where an
 * hour with too few prices of its own rests.
 *
 * A Saturday hour starts where the same weekday hour does. It used to start
 * at 1 everywhere (a weekend was never rush), which priced a Saturday evening
 * like a quiet Wednesday afternoon: ₦1,500 under the other app. A Sunday or
 * holiday has no rush: it starts at 1, which priced a Sunday 09:50 like a
 * Monday's rush (₦10,000 against Linc's ₦8,100) when it copied the weekday.
 * Night hours (22:00–05:00) start at NIGHT_START: the other apps charge more
 * at night.
 */
export function seedHourCurve(settings: PricingSettings = pricingSettings): HourCurve {
  const quiet = quietMarketFareNgn(15, 40, settings);
  const r = settings.rush;
  const rushShare = Math.min(HOUR_CURVE_MAX, Math.max(HOUR_CURVE_MIN, (r.baseNgn + r.perKmNgn * 15 + r.perMinuteNgn * 40) / quiet));
  const rushHour = (h: number) => (h >= 7 && h < 10) || (h >= 16 && h < 20);
  const start = (h: number) => Math.round((isNightHour(h) ? NIGHT_START : rushHour(h) ? rushShare : 1) * 100) / 100;
  return {
    weekday: Array.from({ length: 24 }, (_, h) => start(h)),
    weekend: Array.from({ length: 24 }, (_, h) => start(h)),
    sunday: Array.from({ length: 24 }, (_, h) => (isNightHour(h) ? NIGHT_START : 1)),
  };
}

/** This hour's multiplier on the other app's quiet-hour figures, or null with the curve off. */
export function hourFactorAt(at: Date = new Date()): number | null {
  const curve = pricingSettings.hourCurve;
  if (!pricingSettings.hourCurveOn || !curve) return null;
  return curveValueAt(curve, at);
}

/** Lagos time: morning 05–12, afternoon 12–16, evening 16–21, night 21–05. */
export function dayPeriodOf(at: Date = new Date()): DayPeriod {
  const { hour } = lagosClock(at);
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 16) return 'afternoon';
  if (hour >= 16 && hour < 21) return 'evening';
  return 'night';
}

/** How far above the other app the floor sits at this time, with nothing known of the trip: a range gives its middle. */
export function premiumAt(at: Date = new Date()): number {
  const range = pricingSettings.periodPremiums[dayPeriodOf(at)];
  if (!range) return pricingSettings.premiumNgn;
  return roundToFifty((range.minNgn + range.maxNgn) / 2);
}

const roundToFifty = (n: number) => Math.round(n / 50) * 50;

/** What the trip's conditions say about its premium, and where in the range that put it. */
export type TripPremium = {
  premiumNgn: number;
  period: DayPeriod;
  /** 0 = the bottom of the part of the day's range, 1 = the top. Null: a fixed amount, or the general premium. */
  position: number | null;
};

/**
 * The premium for one trip. With a range for the part of the day, the trip's
 * conditions place it in the range:
 *
 *   heavy traffic (Google's time against an empty road) .... 45%
 *   a busy pickup area (requests against drivers) .......... 30%
 *   an outer area (Ikorodu, Epe…) .......................... 15%
 *   the weekend ............................................ 10%
 *
 * starting a little above the bottom, plus a small turn of its own drawn from
 * the trip's key (its ends and the half hour), so trips on the same road do
 * not all sit on one number. More traffic never lowers it. The same trip
 * asked again in the half hour gets the same amount; whole ₦50s, never
 * outside the range.
 */
export function premiumFor(factors: RateFactors, areaFactor = 1): TripPremium {
  const at = factors.at ?? new Date();
  const period = dayPeriodOf(at);
  const range = pricingSettings.periodPremiums[period];
  if (!range) return { premiumNgn: pricingSettings.premiumNgn, period, position: null };
  if (range.maxNgn <= range.minNgn) return { premiumNgn: range.minNgn, period, position: null };
  const unit = (n: number) => Math.min(1, Math.max(0, n));
  const traffic = factors.trafficRatio !== undefined && Number.isFinite(factors.trafficRatio) ? unit((factors.trafficRatio - 1) / 0.8) : 0;
  const busy = unit((demandFactorOf(factors) - 1) / 0.5);
  const outer = areaFactor > 1 ? 1 : 0;
  const weekend = lagosClock(at).weekend ? 1 : 0;
  const score = 0.45 * traffic + 0.3 * busy + 0.15 * outer + 0.1 * weekend;
  const turn = factors.trialKey ? (steadyDraw(`${factors.trialKey}#premium`) - 0.5) * 0.2 : 0;
  const position = unit(0.15 + 0.85 * score + turn);
  const premiumNgn = Math.min(range.maxNgn, Math.max(range.minNgn, roundToFifty(range.minNgn + position * (range.maxNgn - range.minNgn))));
  return { premiumNgn, period, position: Math.round(position * 1000) / 1000 };
}

/** Weekdays 07:00–10:00 and 16:00–20:00, Lagos time. */
export function isRushHour(at: Date = new Date()): boolean {
  const { hour, weekend } = lagosClock(at);
  return !weekend && ((hour >= 7 && hour < 10) || (hour >= 16 && hour < 20));
}

/** With no trip time to hand (a fare rebuilt from distance alone), a Lagos road is taken at 24 km/h. */
const ASSUMED_MINUTES_PER_KM = 2.5;

/**
 * What the other app would charge for this trip now, as far as its sampled
 * figures say: with the hour curve on, its quiet-hour figures times this
 * hour's multiplier; otherwise its rush or quiet figures.
 */
export function marketFareNgn(distanceKm: number, durationSeconds: number | undefined, at: Date = new Date()): number {
  const minutes = durationSeconds !== undefined && Number.isFinite(durationSeconds) && durationSeconds > 0
    ? durationSeconds / 60
    : distanceKm * ASSUMED_MINUTES_PER_KM;
  const hourFactor = hourFactorAt(at);
  if (hourFactor !== null) return round2(quietMarketFareNgn(distanceKm, minutes) * hourFactor);
  const f = isRushHour(at) ? pricingSettings.rush : pricingSettings.quiet;
  return round2(f.baseNgn + f.perKmNgn * distanceKm + f.perMinuteNgn * minutes);
}

/** The model's rate per km for a trip, or null when there is no model (or the trip has no length). */
export function modelRatePerKmNgn(distanceKm: number, factors: RateFactors = {}): number | null {
  const model = pricingSettings.model;
  if (!model || !(distanceKm > 0)) return null;
  const at = factors.at ?? new Date();
  const { hour, weekend } = lagosClock(at);
  const minutes = factors.durationSeconds && factors.durationSeconds > 0 ? factors.durationSeconds / 60 : distanceKm * ASSUMED_MINUTES_PER_KM;
  const demand = demandFactorOf(factors);
  const ln = model.intercept
    + model.coef.lnKm * Math.log(distanceKm)
    + model.coef.minPerKm * (minutes / distanceKm)
    + model.coef.lnDemand * Math.log(demand)
    + model.coef.rush * (isRushHour(at) ? 1 : 0)
    + model.coef.night * (hour >= 22 || hour < 5 ? 1 : 0)
    + model.coef.weekend * (weekend ? 1 : 0);
  const rate = Math.exp(ln);
  // A model can be wrong; it is never allowed to be absurd.
  return Number.isFinite(rate) ? Math.round(Math.min(3 * RATE_PER_KM_NGN, Math.max(0.5 * RATE_PER_KM_NGN, rate))) : null;
}

/** Share of the rate that pays for distance; the rest pays for the driver's time and grows with traffic. */
const TRAFFIC_DISTANCE_SHARE = 0.6;
const TRAFFIC_FACTOR_MAX = 2.6;
const DEMAND_SENSITIVITY = 0.3;
const DEMAND_FACTOR_MAX = 1.8;
/** What riders usually pay elsewhere, per km; the recommended rate stays within sight of it. Review monthly. */
export const MARKET_RATE_PER_KM_NGN = 300;
const MARKET_CAP = 1.5;

export type RateFactors = {
  /** Travel time now ÷ travel time on an empty road, for this route (Google gives both). 1 = no traffic. */
  trafficRatio?: number;
  /** Requests ÷ drivers online in the pickup area, against the usual for that hour. 1 = normal. */
  demandRatio?: number;
  /**
   * The demand multiplier already worked out for the pickup area (1 to 1.8),
   * moved in small steps by the gateway's busyness job. Used in place of demandRatio.
   */
  demandFactor?: number;
  /** The trip's travel time (Google's, live when traffic is on): the other app charges by the minute. */
  durationSeconds?: number;
  /** When the quote is for. Now, unless a test says otherwise. */
  at?: Date;
  /** Where the trip starts and ends: an outer area (Ikorodu, Epe…) lifts the price. */
  origin?: { lat: number; lng: number };
  destination?: { lat: number; lng: number };
  /**
   * The live surge for the pickup area (1 = none), measured by the gateway
   * from our own riders, drivers and bids. Used only with the surge switched on.
   */
  surgeFactor?: number;
  /** Rain at the pickup now (weather.ts): none, light or heavy. Unknown is none. */
  rain?: Rain;
  /**
   * Names this trip for a while (its two ends and the half hour): whether it
   * is shown a trial price, and which, and its own small turn within a part
   * of the day's premium range, are decided from this alone, so asking again
   * for the same trip gives the same answer. Without it no trial price is
   * shown, and there is no turn.
   */
  trialKey?: string;
};

/** D: the demand multiplier for a trip, 1 when the switch is off or the area is not busy. */
function demandFactorOf(factors: RateFactors): number {
  if (!demandFactorOn()) return 1;
  if (factors.demandFactor !== undefined && Number.isFinite(factors.demandFactor)) {
    return Math.min(DEMAND_FACTOR_MAX, Math.max(1, factors.demandFactor));
  }
  const demand = factors.demandRatio;
  return demand !== undefined && Number.isFinite(demand) && demand > 1
    ? Math.min(1 + DEMAND_SENSITIVITY * Math.log(demand), DEMAND_FACTOR_MAX)
    : 1;
}

/**
 * The live surge for a trip: 1 with the switch off or nothing measured, never
 * under surgeMin, never past surgeMax. At weekends, on holidays, at night and
 * in the rain it only lifts: the surge reads our own riders, and ours are few
 * then even when the other apps are busy, so a quiet discount there would
 * take us under them.
 */
export function surgeFactorOf(factors: RateFactors): number {
  if (!pricingSettings.surgeOn) return 1;
  const s = factors.surgeFactor;
  if (s === undefined || !Number.isFinite(s) || s <= 0) return 1;
  const clock = lagosClock(factors.at ?? new Date());
  const noDiscount = clock.weekend || clock.night || (factors.rain !== undefined && factors.rain !== 'none');
  const least = noDiscount ? Math.max(1, pricingSettings.surgeMin) : pricingSettings.surgeMin;
  return Math.min(pricingSettings.surgeMax, Math.max(least, s));
}

/** Heavy rain over light: a little more again. */
const HEAVY_RAIN_EXTRA = 1.1;
/**
 * The hour, the surge and the rain together never lift the other app's
 * quiet-hour figures past this: a Saturday night in a storm is dear, not
 * three times the price.
 */
export const COMBINED_LIFT_MAX = 2.2;

/** The rain multiplier for a trip: 1 with the switch off or no rain. */
export function rainFactorOf(factors: Pick<RateFactors, 'rain'>): number {
  if (!pricingSettings.rainOn || !factors.rain || factors.rain === 'none') return 1;
  const lift = factors.rain === 'heavy' ? pricingSettings.rainLift * HEAVY_RAIN_EXTRA : pricingSettings.rainLift;
  return Math.round(Math.min(RAIN_LIFT_MAX, lift) * 100) / 100;
}

/** The demand multiplier a requests-to-drivers ratio comes to (1 = normal), whatever the switch says. */
export function demandFactorForRatio(ratio: number): number {
  return Number.isFinite(ratio) && ratio > 1 ? Math.min(1 + DEMAND_SENSITIVITY * Math.log(ratio), DEMAND_FACTOR_MAX) : 1;
}

/**
 * The recommended rate per km for a trip. Flat ₦375 unless a factor is
 * switched on:
 *   traffic  T = 0.6 + 0.4 × (time now ÷ time on an empty road), at most 2.6:
 *            only the time part of a driver's cost grows, so a road three
 *            times slower costs 80% more, not 200%.
 *   demand   D = 1 + 0.3 × ln(demand), never below 1 (a quiet hour, the
 *            night included, is never a discount) and at most 1.8.
 * The cap rises with traffic (1.5 × the market rate on a clear road), so a
 * slow road is still priced for; an unexplained jump is not.
 */
export function recommendedRatePerKmNgn(factors: RateFactors = {}): number {
  const ratio = factors.trafficRatio;
  const T = trafficFactorOn() && ratio !== undefined && Number.isFinite(ratio) && ratio > 1
    ? Math.min(TRAFFIC_DISTANCE_SHARE + (1 - TRAFFIC_DISTANCE_SHARE) * ratio, TRAFFIC_FACTOR_MAX)
    : 1;
  const D = demandFactorOf(factors);
  const cap = Math.max(RATE_PER_KM_NGN, MARKET_CAP * MARKET_RATE_PER_KM_NGN * (1 + 0.5 * (T - 1)));
  return Math.round(Math.min(RATE_PER_KM_NGN * T * D, cap));
}

export type SuggestedFare = {
  distanceKm: number;
  suggestedFareNgn: number;
  minOfferNgn: number;
  maxOfferNgn: number;
  /** The suggested fare as the driver's rate per km. */
  ratePerKmNgn: number;
  /** What set the fare. "trial": a price near the model's, shown on a small share of trips so there is something to learn from. */
  setBy: 'floor' | 'rules' | 'model' | 'trial' | 'linc' | 'ceiling';
  /** The other app's fare for this trip, and the floor it gives (that + the premium). Null with the floor off. */
  marketFareNgn: number | null;
  floorFareNgn: number | null;
  /** The base rate lifted by traffic and a busy area, as a fare. */
  rulesFareNgn: number;
  /** The model's fare. Recorded even when the model is not allowed to set the price. Null with no model. */
  modelFareNgn: number | null;
  /** The outer area that lifted the price (Ikorodu, Epe…) and by how much; 1 and null elsewhere. */
  areaFactor: number;
  area: PricingAreaKey | null;
  /** This hour's multiplier on the other app's quiet-hour figures (null with the curve off), and the live surge applied (1 = none). */
  hourFactor: number | null;
  surgeFactor: number;
  /** The rain lift applied (1 = dry, or rain off). */
  rainFactor: number;
  /** The percentage margin on the other app's fare (1.03 = 3%; 1 = none). */
  marginFactor: number;
  /** The other app's high end for this trip: never suggested under it. Null with the floor off. */
  /** What Linc would charge for the trip (with our surge and rain), when the Linc guide is on; else null. */
  lincNgn: number | null;
  /** The trip's Linc zone (short, central, island, outer), whose lift is in lincNgn. */
  lincZone: LincZone;
  highEndNgn: number | null;
  /** The most this trip may cost: the higher of Linc and inDrive for it, + ceilingAboveNgn. Null when off or the minutes are unknown. */
  ceilingNgn: number | null;
  /** The premium over the other app this trip's floor carries, and why. Null with the floor off. */
  premium: TripPremium | null;
};

export type RidePriceBreakdown = {
  distanceKm: number;
  suggestedFareNgn: number;
  minOfferNgn: number;
  ratePerKmNgn: number;
};

// ── Fare ↔ trip fare ↔ rate per km ─────────────────────────────────────────

/** The fare a rider pays for a trip fare: + VAT + booking fee, rounded up to ₦50, never under the minimum fare. */
export function fareFromTripFareNgn(tripFareNgn: number): number {
  const raw = Math.max(0, tripFareNgn) * (1 + VAT_RATE) + BOOKING_FEE_NGN;
  return Math.max(MIN_FARE_NGN, roundUpToIncrement(round2(raw), FARE_ROUNDING_INCREMENT));
}

/** The fare a rider pays when the driver's rate is `ratePerKmNgn` over `distanceKm`. */
export function fareFromRatePerKmNgn(ratePerKmNgn: number, distanceKm: number): number {
  return fareFromTripFareNgn(round2(ratePerKmNgn * distanceKm));
}

/**
 * The trip fare inside a fare: what the driver's rate, commission and VAT are
 * worked from. (Version 1: the fare after the booking fee, the driver's share.)
 */
export function tripFareNgn(fareNgn: number, version: PricingVersion = CURRENT_PRICING_VERSION): number {
  const afterFee = Math.max(0, round2(fareNgn - bookingFeeOf(version)));
  return version === 1 ? afterFee : round2(afterFee / (1 + VAT_RATE));
}

/** Old name: the driver's part of a fare before commission. */
export function driverShareNgn(fareNgn: number, version: PricingVersion = CURRENT_PRICING_VERSION): number {
  return tripFareNgn(fareNgn, version);
}

/**
 * What a fare is worth to the driver per km: the trip fare over the trip's
 * distance, to one decimal. It moves with the price: every rider price,
 * counter and bid has its own. Null when the distance is unknown.
 */
export function driverRatePerKmNgn(
  fareNgn: number,
  distanceKm: number | null | undefined,
  version: PricingVersion = CURRENT_PRICING_VERSION,
): number | null {
  if (distanceKm === null || distanceKm === undefined || !Number.isFinite(distanceKm) || distanceKm <= 0) return null;
  return Math.round((tripFareNgn(fareNgn, version) / distanceKm) * 10) / 10;
}

// ── The suggested fare and the limits on offers ───────────────────────────

/**
 * The area factor for a trip: the pickup area's pickup factor or the drop-off
 * area's drop-off factor, whichever is larger. 1 inside the rest of Lagos.
 */
export function areaFactorOf(factors: Pick<RateFactors, 'origin' | 'destination'>): { factor: number; area: PricingAreaKey | null } {
  const from = factors.origin ? pricingAreaOf(factors.origin.lat, factors.origin.lng) : null;
  const to = factors.destination ? pricingAreaOf(factors.destination.lat, factors.destination.lng) : null;
  const pickup = from ? pricingSettings.areas[from.key].pickup : 1;
  const dropoff = to ? pricingSettings.areas[to.key].dropoff : 1;
  if (pickup <= 1 && dropoff <= 1) return { factor: 1, area: null };
  return pickup >= dropoff ? { factor: pickup, area: from!.key } : { factor: dropoff, area: to!.key };
}

export function calculateSuggestedFare(distanceKm: number, factors: RateFactors = {}): SuggestedFare {
  if (!Number.isFinite(distanceKm) || distanceKm < 0) {
    throw new TypeError('distanceKm must be a finite number >= 0');
  }

  const settings = pricingSettings;
  // Ikorodu, Epe, Ibeju-Lekki, Badagry: what other apps charge there, and our own rate, are both higher.
  const { factor: areaFactor, area } = areaFactorOf(factors);
  const rulesFareNgn = roundUpToIncrement(fareFromRatePerKmNgn(recommendedRatePerKmNgn(factors), distanceKm) * areaFactor, FARE_ROUNDING_INCREMENT);
  const modelRate = modelRatePerKmNgn(distanceKm, factors);
  const modelFareNgn = modelRate === null ? null : fareFromRatePerKmNgn(modelRate, distanceKm);

  // The floor: what the other app charges for this trip (by the hour, and
  // lifted by our own live surge), plus the premium. Nothing is ever
  // suggested below it.
  // The hour (in marketFareNgn), the surge and the rain, together at most COMBINED_LIFT_MAX.
  const hourLift = hourFactorAt(factors.at ?? new Date()) ?? 1;
  const rainFactor = rainFactorOf(factors);
  const surgeFactor = surgeFactorOf(factors);
  const lift = Math.min(surgeFactor * rainFactor, COMBINED_LIFT_MAX / Math.max(1, hourLift));
  const marketFare = settings.marketFloorOn && distanceKm > 0
    ? marketFareNgn(distanceKm, factors.durationSeconds, factors.at) * areaFactor * lift
    : null;
  const premium = premiumFor(factors, areaFactor);
  // A share of the other app's fare on top, growing with it; then the premium.
  const marginFactor = 1 + settings.marginPercent / 100;
  const floorFareNgn = marketFare === null
    ? null
    : Math.max(MIN_FARE_NGN, roundUpToIncrement(marketFare * marginFactor + premium.premiumNgn, FARE_ROUNDING_INCREMENT));

  // The rules and the model may only lift it, and only so far: at most
  // liftCap × the floor (or × our own plain rate, where that is the higher).
  // A liftCap of 1 holds every trip to the floor itself, long fast ones
  // included: never more than the other app + the premium.
  const plainFareNgn = fareFromRatePerKmNgn(RATE_PER_KM_NGN, distanceKm) * areaFactor;
  const liftLimit = floorFareNgn === null
    ? Infinity
    : settings.liftCap <= 1
      ? floorFareNgn
      : roundUpToIncrement(Math.max(floorFareNgn, plainFareNgn) * settings.liftCap, FARE_ROUNDING_INCREMENT);
  let suggestedFareNgn = floorFareNgn ?? rulesFareNgn;
  let setBy: SuggestedFare['setBy'] = floorFareNgn === null ? 'rules' : 'floor';
  const rules = Math.min(rulesFareNgn, liftLimit);
  if (rules > suggestedFareNgn) { suggestedFareNgn = rules; setBy = 'rules'; }

  // The trained model, when this build has one and the floor is on (it reads
  // a price against the other app's). It looks at prices a little either
  // side of today's: at most maxDiscountNgn and a tenth of the fare away,
  // never closer to the other app than modelPremiumNgn and never past the
  // lift limit, and names the one worth most. Its price is always recorded;
  // it is only SHOWN once an owner has switched the model on.
  const ml = getPricingMlModel();
  let modelFare = modelFareNgn;
  if (ml && distanceKm > 0 && floorFareNgn !== null && marketFare !== null) {
    const at = factors.at ?? new Date();
    const { hour, weekend } = lagosClock(at);
    const minutes = factors.durationSeconds !== undefined && Number.isFinite(factors.durationSeconds) && factors.durationSeconds > 0
      ? factors.durationSeconds / 60
      : distanceKm * ASSUMED_MINUTES_PER_KM;
    const marketEstNgn = marketFare;
    const base = suggestedFareNgn;
    const cut = Math.min(settings.maxDiscountNgn, MODEL_MAX_DISCOUNT_SHARE * base);
    const least = roundUpToIncrement(marketEstNgn + settings.modelPremiumNgn, FARE_ROUNDING_INCREMENT);
    const range = {
      lowestNgn: Math.min(base, Math.max(least, base - cut, MIN_FARE_NGN)),
      baseNgn: base,
      highestNgn: Math.max(base, Math.min(liftLimit, base + cut)),
    };
    const choice = chooseFare(
      ml,
      { km: distanceKm, minutes, hour, weekend, rush: isRushHour(at), demand: demandFactorOf(factors), marketEstNgn },
      range,
      // What Wheelers keeps of a ride: the booking fee and the WhatsApp fee flat, and the commission.
      { serviceChargeNgn: BOOKING_FEE_NGN + WHATSAPP_FEE_NGN, commissionRate: COMMISSION_RATE, vatRate: VAT_RATE, rideValueNgn: settings.rideValueNgn },
    );
    modelFare = Math.max(MIN_FARE_NGN, choice.fareNgn);
    if (settings.modelOn && modelFare !== suggestedFareNgn) { suggestedFareNgn = modelFare; setBy = 'model'; }
    // A small share of trips are shown one of the OTHER prices in the same
    // range, so the model can later learn what a different price would have
    // done. Decided from the trip's own key: the same trip, asked again, gets the same price.
    if (settings.modelOn && settings.trialShare > 0 && factors.trialKey && steadyDraw(factors.trialKey) < settings.trialShare) {
      // Only prices between the lowest allowed and today's: a trial never costs a rider more than they would have paid without the model.
      const others = [...new Set(candidateFares(ml, range))].filter((fare) => fare >= MIN_FARE_NGN && fare <= base && fare !== modelFare);
      if (others.length > 0) {
        suggestedFareNgn = others[Math.floor(steadyDraw(`${factors.trialKey}#which`) * others.length)]!;
        setBy = 'trial';
      }
    }
  } else if (settings.modelOn && modelFareNgn !== null) {
    // No trained model in this build: the small fitted one may lift a fare, never lower it.
    const model = Math.min(modelFareNgn, liftLimit);
    if (model > suggestedFareNgn) { suggestedFareNgn = model; setBy = 'model'; }
  }
  // Linc as the guide, when on and the trip's minutes are known: what Linc
  // would charge (its figures on the live minutes, times our own surge and
  // rain), plus lincAboveNgn, in place of everything above and the extra.
  const tripMinutes = factors.durationSeconds !== undefined && Number.isFinite(factors.durationSeconds) && factors.durationSeconds > 0
    ? factors.durationSeconds / 60
    : null;
  // What Linc would charge for the trip: the guide when it is on, and half of the ceiling either way.
  const lincZone = lincZoneOf(distanceKm, factors.origin, factors.destination);
  const lincTripNgn = distanceKm > 0 && tripMinutes !== null
    ? Math.round(lincFullPriceNgn(lincFareNgn(distanceKm, tripMinutes, settings.linc) * lincPeriodLifts(settings).lifts[lincSlotOf(factors.at ?? new Date())] * (settings.lincZonesOn ? lincZoneLifts(settings).lifts[lincZone] : 1), settings) * surgeFactor * rainFactor)
    : null;
  const lincNgn = settings.lincOn ? lincTripNgn : null;
  if (lincNgn !== null) {
    suggestedFareNgn = Math.max(MIN_FARE_NGN, roundUpToIncrement(lincNgn * (1 + settings.lincAbovePercent / 100) + settings.lincAboveNgn, FARE_ROUNDING_INCREMENT));
    setBy = 'linc';
  } else {
    // Last of all: the flat extra, on top of whatever the above came to.
    suggestedFareNgn += settings.extraNgn;
  }
  // Never under the other app's high end (a trial price excepted: it is never above today's anyway).
  // The area lift and the high end both say "the other app charges more here":
  // the larger of the two counts, never both multiplied.
  const marketPlainNgn = marketFare === null ? null : marketFare / areaFactor;
  const highEndNgn = marketPlainNgn === null
    ? null
    : roundUpToIncrement(marketPlainNgn * Math.max(areaFactor, settings.marketHigh), FARE_ROUNDING_INCREMENT);
  if (highEndNgn !== null && suggestedFareNgn < highEndNgn && setBy !== 'trial') {
    suggestedFareNgn = highEndNgn;
    setBy = 'floor';
  }
  // Last of all, the ceiling: never more than ceilingAboveNgn over the higher of Linc and inDrive for this trip.
  const marketTop = Math.max(lincTripNgn ?? 0, tripMinutes !== null ? marketPlainNgn ?? 0 : 0);
  // With Linc's band on (lincMaxAbovePercent), the ceiling is never under Linc ×(1 + that): the aim
  // over Linc (lincAbovePercent) stands on long trips, where ₦1,000 is a small share.
  const lincBandTopNgn = settings.lincMaxAbovePercent !== null && lincTripNgn !== null && lincTripNgn > 0
    ? roundUpToIncrement(lincTripNgn * (1 + settings.lincMaxAbovePercent / 100), FARE_ROUNDING_INCREMENT)
    : 0;
  const ceilingNgn = settings.ceilingAboveNgn !== null && marketTop > 0
    ? Math.max(MIN_FARE_NGN, roundUpToIncrement(marketTop + settings.ceilingAboveNgn, FARE_ROUNDING_INCREMENT), lincBandTopNgn)
    : null;
  if (ceilingNgn !== null && suggestedFareNgn > ceilingNgn) {
    suggestedFareNgn = ceilingNgn;
    setBy = 'ceiling';
  }
  const limits = offerLimitsNgn(suggestedFareNgn);

  return {
    distanceKm,
    suggestedFareNgn,
    minOfferNgn: limits.minOfferNgn,
    maxOfferNgn: limits.maxOfferNgn,
    ratePerKmNgn: distanceKm > 0 ? Math.round(tripFareNgn(suggestedFareNgn) / distanceKm) : recommendedRatePerKmNgn(factors),
    setBy,
    marketFareNgn: marketFare,
    floorFareNgn,
    rulesFareNgn,
    modelFareNgn: modelFare,
    areaFactor,
    area,
    hourFactor: hourFactorAt(factors.at ?? new Date()),
    surgeFactor: marketFare === null ? 1 : surgeFactor,
    rainFactor: marketFare === null ? 1 : rainFactor,
    marginFactor: marketFare === null ? 1 : Math.round(marginFactor * 1000) / 1000,
    highEndNgn,
    lincNgn,
    lincZone,
    ceilingNgn,
    premium: marketFare === null ? null : premium,
  };
}

/** The one line under a price that says why it is up: the biggest lift, and what it added. */
export type PriceReason = { label: 'Busy in this area' | 'Raining'; extraNgn: number };

/** A surge this far over 1 is worth a line. */
const BUSY_SURGE_MIN = 1.05;

/**
 * Why this trip's price is up, if anything notable lifted it: a busy pickup
 * area (the live surge) or rain. The bigger lift wins;
 * what it added is rounded to ₦50 and is always above 0. Null when nothing did.
 *
 * Surge and rain are worked out by pricing the same trip again without them
 * (so whatever the price is set by, the difference is the real one).
 */
export function priceReasonOf(distanceKm: number, factors: RateFactors, fare: SuggestedFare): PriceReason | null {
  if (!Number.isFinite(distanceKm) || distanceKm <= 0) return null;
  const found: PriceReason[] = [];
  const add = (label: PriceReason['label'], extra: number) => {
    const extraNgn = Math.round(extra / 50) * 50;
    if (Number.isFinite(extraNgn) && extraNgn > 0) found.push({ label, extraNgn });
  };

  if (surgeFactorOf(factors) > BUSY_SURGE_MIN) {
    const without = calculateSuggestedFare(distanceKm, { ...factors, surgeFactor: 1 });
    add('Busy in this area', fare.suggestedFareNgn - without.suggestedFareNgn);
  }
  if (rainFactorOf(factors) > 1) {
    const without = calculateSuggestedFare(distanceKm, { ...factors, rain: 'none' });
    add('Raining', fare.suggestedFareNgn - without.suggestedFareNgn);
  }

  // The hour of the day is never named ("Rush hour"): only a busy area and rain.
  if (found.length === 0) return null;
  return found.reduce((best, reason) => (reason.extraNgn > best.extraNgn ? reason : best));
}

/**
 * The limits on a trip, from its suggested fare: a rider may offer no less
 * than the fare at 90% of the recommended rate, and a driver may ask no more
 * than the fare at 150% of it. Worked from the suggested fare's own trip fare,
 * so they move with it (traffic included) and need no distance.
 *
 * With the market floor on, a rider may also bargain away no more than the
 * premium: the suggested fare is never under the other app's fare + the
 * premium, so an offer of the suggested fare − the premium is never under
 * the other app's fare.
 */
export function offerLimitsNgn(suggestedFareNgn: number): { minOfferNgn: number; maxOfferNgn: number } {
  const recommendedTripFare = tripFareNgn(suggestedFareNgn);
  // The minimum sits a set amount under the suggested fare (₦850 unless
  // changed), so a rider always sees the same room to bargain whatever the
  // trip costs. It never goes under the minimum fare, nor above the suggested
  // fare on a trip that is already at the minimum.
  if (pricingSettings.minOfferGapNgn > 0) {
    const byGap = roundUpToIncrement(suggestedFareNgn - pricingSettings.minOfferGapNgn, FARE_ROUNDING_INCREMENT);
    return {
      minOfferNgn: Math.min(Math.max(byGap, MIN_FARE_NGN), Math.max(suggestedFareNgn, MIN_FARE_NGN)),
      maxOfferNgn: fareFromTripFareNgn(recommendedTripFare * MAX_COUNTER_SHARE),
    };
  }
  const byShare = fareFromTripFareNgn(recommendedTripFare * MIN_OFFER_SHARE);
  // With the trained model on, a price may already be as close to the other
  // app as modelPremiumNgn, so that is all a rider may then bargain away.
  const room = mlPricingOn() ? Math.min(premiumAt(), pricingSettings.modelPremiumNgn) : premiumAt();
  const byPremium = pricingSettings.marketFloorOn
    ? roundUpToIncrement(suggestedFareNgn - room, FARE_ROUNDING_INCREMENT)
    : 0;
  return {
    minOfferNgn: Math.min(Math.max(byShare, byPremium, MIN_FARE_NGN), Math.max(suggestedFareNgn, MIN_FARE_NGN)),
    maxOfferNgn: fareFromTripFareNgn(recommendedTripFare * MAX_COUNTER_SHARE),
  };
}

/** The same limits as rates per km, for the driver's "your rate" box. Null when the distance is unknown. */
export function rateLimitsPerKmNgn(
  suggestedFareNgn: number,
  distanceKm: number | null | undefined,
): { minRateNgn: number; maxRateNgn: number } | null {
  if (distanceKm === null || distanceKm === undefined || !Number.isFinite(distanceKm) || distanceKm <= 0) return null;
  const recommendedRate = tripFareNgn(suggestedFareNgn) / distanceKm;
  return {
    minRateNgn: Math.ceil(recommendedRate * MIN_OFFER_SHARE),
    maxRateNgn: Math.floor(recommendedRate * MAX_COUNTER_SHARE),
  };
}

export function validateRiderOffer(
  offerNgn: number,
  suggestedFareNgn: number,
): { valid: boolean; minOfferNgn: number; reason?: string } {
  const { minOfferNgn } = offerLimitsNgn(suggestedFareNgn);

  if (!Number.isFinite(offerNgn) || offerNgn <= 0) {
    return { valid: false, minOfferNgn, reason: 'Offer must be a positive number.' };
  }

  if (offerNgn < minOfferNgn) {
    return {
      valid: false,
      minOfferNgn,
      // On short trips the floor is what binds, not the share: say so.
      reason:
        minOfferNgn === MIN_FARE_NGN
          ? `Minimum fare is ${MIN_FARE_NGN} NGN for any ride.`
          : `The lowest offer for this trip is ${minOfferNgn.toLocaleString('en-NG')} NGN.`,
    };
  }

  return { valid: true, minOfferNgn };
}

/**
 * The highest fare a driver may ask on a trip of this distance at the base
 * rate (old callers that only know the distance). Infinity when the distance
 * is unknown: an unknown trip length must not block a bid.
 */
export function resolveMaxOfferNgn(distanceKm: number | undefined): number {
  if (distanceKm === undefined || !Number.isFinite(distanceKm) || distanceKm <= 0) {
    return Number.POSITIVE_INFINITY;
  }
  return fareFromRatePerKmNgn(RATE_PER_KM_NGN * MAX_COUNTER_SHARE, distanceKm);
}

/** A bid this many times the rider's price is a typo, not an offer. */
export const DRIVER_BID_TYPO_MULTIPLE = 10;

/**
 * A driver's bid, as the fare the rider would pay. It may be anything up to
 * the fare at 150% of the recommended rate; and taking the rider's own price
 * is always allowed, however high (a rider may offer more than the ceiling).
 * Without a suggested fare to measure against (a group seat), only a typo is
 * refused.
 */
export function validateDriverOffer(
  offerNgn: number,
  riderOfferNgn: number,
  suggestedFareNgn?: number,
): { valid: boolean; minOfferNgn: number; maxOfferNgn: number; reason?: string } {
  const typoCeiling = Math.max(MIN_FARE_NGN, Math.round(riderOfferNgn) * DRIVER_BID_TYPO_MULTIPLE);
  const maxOfferNgn = suggestedFareNgn && suggestedFareNgn > 0
    ? Math.min(typoCeiling, Math.max(offerLimitsNgn(suggestedFareNgn).maxOfferNgn, Math.round(riderOfferNgn)))
    : typoCeiling;
  if (!Number.isFinite(offerNgn) || offerNgn <= 0 || Math.round(offerNgn) !== offerNgn) {
    return { valid: false, minOfferNgn: 1, maxOfferNgn, reason: 'Bid must be a whole amount in naira.' };
  }
  if (offerNgn > maxOfferNgn) {
    return {
      valid: false,
      minOfferNgn: 1,
      maxOfferNgn,
      reason: `That is above the highest price for this trip (${maxOfferNgn.toLocaleString('en-NG')} NGN). Lower your rate and send it again.`,
    };
  }
  return { valid: true, minOfferNgn: 1, maxOfferNgn };
}

// ── Taking a fare apart ───────────────────────────────────────────────────

export type RideFeeBreakdown = {
  /** What the rider pays. */
  fareNgn: number;
  /** Wheelers' flat booking fee. */
  bookingFeeNgn: number;
  /** The trip fare: the driver's rate × distance. (Version 1: the fare after the booking fee. Version 4: the fare after the WhatsApp fee, what VAT, the levy and commission are taken from.) */
  driverShareNgn: number;
  /** Same figure under its new name. */
  tripFareNgn: number;
  /** 5% of the trip fare, from the driver. (Version 2: 10%; version 1: 4%.) */
  commissionNgn: number;
  /** ₦300 flat on every ride. (Versions 1 and 2: none. Version 4: off the fare before anything else.) */
  whatsappFeeNgn: number;
  /** 7.5% of the trip fare, paid by the rider inside the fare. (Versions 1 and 4: taken from the driver's share.) */
  vatNgn: number;
  stateLevyNgn: number;
  /** Everything that is not the driver's: booking fee + commission + WhatsApp fee + VAT + levy. */
  platformTotalNgn: number;
  driverPayoutNgn: number;
  /** What the rider pays: the fare, nothing on top. */
  totalNgn: number;
  pricingVersion: PricingVersion;
  /** Old names: the commission, and the booking fee. */
  platformFeeNgn: number;
  serviceFeeNgn: number;
};

/**
 * fareNgn = the agreed fare: what the rider pays. Version 4 (now, from
 * 2026-11-03): no booking fee. The ₦300 WhatsApp fee comes off the fare; VAT
 * 7.5%, the ₦30 levy and 5% commission are all taken from what is left, and the
 * driver is paid the rest (₦3,300 → 3,000 − 225 − 30 − 150 = ₦2,595). Prices
 * are built as in version 3; only the split changed. Version 3 (2026-10-21 to
 * 11-03): the booking fee comes off; the rest is trip fare + its 7.5%
 * VAT; the driver is paid the trip fare less 5% commission, the ₦300
 * WhatsApp fee and the ₦30 levy. Version 2 (2026-10-10 to 21): the same with
 * 10% commission and no WhatsApp fee. Version 1 (before 2026-10-10): booking
 * fee off, then 4% commission, 7.5% VAT and the levy all from the driver's share.
 */
export function calculateRideFees(fareNgn: number, version: PricingVersion = CURRENT_PRICING_VERSION): RideFeeBreakdown {
  const fare = round2(fareNgn);
  const bookingFeeNgn = version === 4 ? 0 : Math.min(bookingFeeOf(version), Math.max(0, fare));
  const afterFee = round2(fare - bookingFeeNgn);

  let share: number;
  let commissionNgn: number;
  let vatNgn: number;
  let stateLevyNgn = LAGOS_STATE_FEE_NGN;
  let whatsappFeeNgn = whatsappFeeOf(version);
  /** What the driver's own deductions come out of. */
  let driverBase: number;
  /** The deductions that are the driver's, in the order they shrink on a fare too small to carry them. */
  let driverLines: number;

  if (version === 1) {
    share = afterFee;
    commissionNgn = round2(share * V1_COMMISSION_RATE);
    vatNgn = round2(share * VAT_RATE);
    driverBase = share;
    driverLines = round2(commissionNgn + vatNgn + stateLevyNgn);
  } else if (version === 4) {
    whatsappFeeNgn = Math.min(WHATSAPP_FEE_NGN, Math.max(0, fare));
    share = round2(fare - whatsappFeeNgn);
    vatNgn = round2(share * VAT_RATE);
    commissionNgn = round2(share * COMMISSION_RATE);
    driverBase = share;
    driverLines = round2(vatNgn + stateLevyNgn + commissionNgn);
  } else {
    share = round2(afterFee / (1 + VAT_RATE));
    vatNgn = round2(afterFee - share); // the two always add up to what is left after the booking fee
    commissionNgn = round2(share * commissionRateOf(version));
    driverBase = share;
    driverLines = round2(commissionNgn + whatsappFeeNgn + stateLevyNgn);
  }

  // A fare too small to carry every line (a ride settled short) must never
  // make the driver pay to work: the levy, then the WhatsApp fee (versions 2
  // and 3; in version 4 it came off the fare first), then the commission, then
  // (in versions 1 and 4) VAT shrink until the lines fit and the payout is zero.
  let over = round2(driverLines - driverBase);
  if (over > 0) { const cut = Math.min(stateLevyNgn, over); stateLevyNgn = round2(stateLevyNgn - cut); over = round2(over - cut); }
  if (over > 0 && version !== 4) { const cut = Math.min(whatsappFeeNgn, over); whatsappFeeNgn = round2(whatsappFeeNgn - cut); over = round2(over - cut); }
  if (over > 0) { const cut = Math.min(commissionNgn, over); commissionNgn = round2(commissionNgn - cut); over = round2(over - cut); }
  if (over > 0 && (version === 1 || version === 4)) { const cut = Math.min(vatNgn, over); vatNgn = round2(vatNgn - cut); }

  const driverPayoutNgn = version === 1
    ? Math.max(0, round2(share - commissionNgn - vatNgn - stateLevyNgn))
    : version === 4
      ? Math.max(0, round2(share - vatNgn - stateLevyNgn - commissionNgn))
      : Math.max(0, round2(share - commissionNgn - whatsappFeeNgn - stateLevyNgn));
  const platformTotalNgn = round2(fare - driverPayoutNgn);
  return {
    fareNgn: fare,
    bookingFeeNgn,
    driverShareNgn: share,
    tripFareNgn: share,
    commissionNgn,
    whatsappFeeNgn,
    vatNgn,
    stateLevyNgn,
    platformTotalNgn,
    driverPayoutNgn,
    totalNgn: fare,
    pricingVersion: version,
    platformFeeNgn: commissionNgn,
    serviceFeeNgn: bookingFeeNgn,
  };
}

/**
 * The platform's total on a ride, split into the three lines it is made of.
 * The state levy comes first (it is owed to Lagos), then the flat service fee,
 * and the commission is what remains. On a fare too small to carry the flat
 * fees, where the total is capped at the fare, the commission shrinks first
 * and the three always add up to it.
 */
export function splitPlatformTotal(
  platformTotalNgn: number,
  // Only rides from before the split was stored need this, and they paid the ₦375 booking fee.
  rates: { serviceFeeNgn: number; stateLevyNgn: number } = { serviceFeeNgn: V1_BOOKING_FEE_NGN, stateLevyNgn: LAGOS_STATE_FEE_NGN },
): { commissionNgn: number; serviceFeeNgn: number; stateLevyNgn: number } {
  const total = Math.max(0, round2(platformTotalNgn));
  const stateLevyNgn = Math.min(rates.stateLevyNgn, total);
  const serviceFeeNgn = Math.min(rates.serviceFeeNgn, round2(total - stateLevyNgn));
  const commissionNgn = round2(total - stateLevyNgn - serviceFeeNgn);
  return { commissionNgn, serviceFeeNgn, stateLevyNgn };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function roundUpToIncrement(value: number, increment: number): number {
  return Math.ceil(value / increment) * increment;
}
