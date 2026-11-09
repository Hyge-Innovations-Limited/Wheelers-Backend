/**
 * Nigeria's public holidays, worked out for any year, so pricing treats them
 * as weekends without anyone typing them in (pricing.ts, lagosClock):
 *
 *   fixed        New Year 1 Jan, Workers' Day 1 May, Democracy Day 12 Jun,
 *                Independence Day 1 Oct, Christmas 25 Dec, Boxing Day 26 Dec
 *   Easter       Good Friday and Easter Monday (the Western date, by the Computus)
 *   Islamic      Eid-el-Fitr (two days from 1 Shawwal), Eid-el-Kabir (two days
 *                from 10 Dhul Hijja), Eid-el-Maulud (12 Rabi' al-Awwal), from the
 *                Umm al-Qura calendar. The day declared after the moon is sighted
 *                can be a day off: settings add the declared day and remove the guess.
 *   in lieu      a fixed holiday, an Eid or Mawlid on a Saturday or Sunday gives
 *                the next working day too, as the government declares it
 *   festive eves Christmas Eve and New Year's Eve: Lagos is out in force
 *
 * Dates are Lagos days, YYYY-MM-DD.
 */

export type Holiday = { date: string; name: string };

const FIXED: ReadonlyArray<[string, string]> = [
  ['01-01', 'New Year'],
  ['05-01', "Workers' Day"],
  ['06-12', 'Democracy Day'],
  ['10-01', 'Independence Day'],
  ['12-25', 'Christmas'],
  ['12-26', 'Boxing Day'],
];
const EVES: ReadonlyArray<[string, string]> = [
  ['12-24', 'Christmas Eve'],
  ['12-31', "New Year's Eve"],
];

const DAY_MS = 86_400_000;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const utc = (date: string) => Date.parse(`${date}T00:00:00Z`);
const weekday = (date: string) => new Date(utc(date)).getUTCDay();

/** Easter Sunday of a year (the anonymous Gregorian algorithm). */
export function easterSunday(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

let hijri: Intl.DateTimeFormat | null | undefined;

/** Days of a Gregorian year that fall on a Hijri month and day. Empty where this Node has no Islamic calendar. */
function hijriDays(year: number, month: number, day: number): string[] {
  if (hijri === undefined) {
    try {
      hijri = new Intl.DateTimeFormat('en-u-ca-islamic-umalqura', { day: 'numeric', month: 'numeric', timeZone: 'UTC' });
      // A build without the calendar quietly falls back to the Gregorian one: check it really is Hijri.
      const p = Object.fromEntries(hijri.formatToParts(new Date(Date.UTC(2025, 2, 30))).map((x) => [x.type, x.value]));
      if (Number(p.month) !== 10 || Number(p.day) !== 1) hijri = null;
    } catch {
      hijri = null;
    }
  }
  if (!hijri) return [];
  const out: string[] = [];
  for (let t = Date.UTC(year, 0, 1); t < Date.UTC(year + 1, 0, 1); t += DAY_MS) {
    const p = Object.fromEntries(hijri.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    if (Number(p.month) === month && Number(p.day) === day) out.push(iso(t));
  }
  return out;
}

const byYear = new Map<number, Holiday[]>();

/** Every public holiday (and festive eve) of a year, in date order. */
export function holidaysFor(year: number): Holiday[] {
  const cached = byYear.get(year);
  if (cached) return cached;
  const days = new Map<string, string>();
  const add = (date: string, name: string) => { if (!days.has(date)) days.set(date, name); };
  const movable: Holiday[] = [];

  for (const [md, name] of FIXED) movable.push({ date: `${year}-${md}`, name });
  const easter = utc(easterSunday(year));
  add(iso(easter - 2 * DAY_MS), 'Good Friday');
  add(iso(easter + DAY_MS), 'Easter Monday');
  for (const date of hijriDays(year, 10, 1)) {
    movable.push({ date, name: 'Eid-el-Fitr' }, { date: iso(utc(date) + DAY_MS), name: 'Eid-el-Fitr' });
  }
  for (const date of hijriDays(year, 12, 10)) {
    movable.push({ date, name: 'Eid-el-Kabir' }, { date: iso(utc(date) + DAY_MS), name: 'Eid-el-Kabir' });
  }
  for (const date of hijriDays(year, 3, 12)) movable.push({ date, name: 'Eid-el-Maulud' });
  for (const h of movable) add(h.date, h.name);
  for (const [md, name] of EVES) add(`${year}-${md}`, name);

  // A holiday on a weekend gives the next working day that is not already a holiday.
  for (const h of movable.sort((x, y) => x.date.localeCompare(y.date))) {
    const dow = weekday(h.date);
    if (dow !== 0 && dow !== 6) continue;
    let t = utc(h.date) + DAY_MS;
    while (weekday(iso(t)) === 0 || weekday(iso(t)) === 6 || days.has(iso(t))) t += DAY_MS;
    if (new Date(t).getUTCFullYear() === year) add(iso(t), `${h.name} (day off in lieu)`);
  }

  const list = [...days.entries()].map(([date, name]) => ({ date, name })).sort((x, y) => x.date.localeCompare(y.date));
  byYear.set(year, list);
  return list;
}

/**
 * The holiday on a Lagos date, or null: the calendar's, plus any `added`
 * (declared on the day: a moved Eid, a one-off), less any `removed`.
 */
export function holidayOn(date: string, added: readonly string[] = [], removed: readonly string[] = []): string | null {
  if (removed.includes(date)) return null;
  if (added.includes(date)) return 'Declared holiday';
  const year = Number(date.slice(0, 4));
  if (!Number.isInteger(year)) return null;
  return holidaysFor(year).find((h) => h.date === date)?.name ?? null;
}

/** The holidays from a Lagos date on, for the next `days` (the CLI's list). */
export function upcomingHolidays(from: string, days = 120, added: readonly string[] = [], removed: readonly string[] = []): Holiday[] {
  const out: Holiday[] = [];
  for (let t = utc(from); t < utc(from) + days * DAY_MS; t += DAY_MS) {
    const date = iso(t);
    const name = holidayOn(date, added, removed);
    if (name) out.push({ date, name });
  }
  return out;
}
