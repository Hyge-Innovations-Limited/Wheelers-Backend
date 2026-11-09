/**
 * Fuel tank size of common Lagos cars, in litres, by year range, from the
 * makers' published (mostly US-market) figures: most cars here are used imports.
 * Only figures that are certain are listed; a car or year not here is unknown
 * (null). Never a guess. Gallons x 3.785 rounded to the litre.
 */
export interface VehicleTankEntry {
  make: string;
  /** Model names as they may be typed, normalised the same way as the input (see normalise). */
  models: string[];
  from: number;
  to: number;
  litres: number;
  source: string;
}

const e = (make: string, models: string[], from: number, to: number, litres: number, source: string): VehicleTankEntry => ({ make, models, from, to, litres, source });

export const VEHICLE_TANKS: readonly VehicleTankEntry[] = [
  e('toyota', ['corolla'], 2000, 2022, 50, 'Toyota spec, 13.2 gal'),
  e('toyota', ['camry'], 2012, 2017, 64, 'Toyota spec, 17.0 gal'),
  e('toyota', ['camry'], 2018, 2024, 60, 'Toyota spec, 15.8 gal'),
  e('toyota', ['rav4'], 2006, 2018, 60, 'Toyota spec, 15.9 gal'),
  e('toyota', ['rav4'], 2019, 2024, 55, 'Toyota spec, 14.5 gal'),
  e('toyota', ['highlander'], 2001, 2007, 75, 'Toyota spec, 19.8 gal'),
  e('toyota', ['highlander'], 2008, 2019, 73, 'Toyota spec, 19.2 gal'),
  e('toyota', ['avalon'], 2013, 2018, 64, 'Toyota spec, 17.0 gal'),
  e('toyota', ['yaris'], 2007, 2014, 42, 'Toyota spec, 11.1 gal'),
  e('toyota', ['matrix'], 2003, 2013, 50, 'Toyota spec, 13.2 gal'),
  e('honda', ['accord'], 2003, 2007, 65, 'Honda spec, 17.1 gal'),
  e('honda', ['accord'], 2008, 2012, 70, 'Honda spec, 18.5 gal'),
  e('honda', ['accord'], 2013, 2017, 65, 'Honda spec, 17.2 gal'),
  e('honda', ['accord'], 2018, 2022, 56, 'Honda spec, 14.8 gal'),
  e('honda', ['civic'], 2006, 2015, 50, 'Honda spec, 13.2 gal'),
  e('honda', ['civic'], 2016, 2021, 47, 'Honda spec, 12.4 gal'),
  e('honda', ['crv'], 2007, 2016, 58, 'Honda spec, 15.3 gal'),
  e('honda', ['crv'], 2017, 2022, 53, 'Honda spec, 14.0 gal'),
  e('honda', ['pilot'], 2009, 2015, 79, 'Honda spec, 21.0 gal'),
  e('honda', ['pilot'], 2016, 2022, 74, 'Honda spec, 19.5 gal'),
  e('lexus', ['rx'], 2010, 2022, 73, 'Lexus spec, 19.2 gal'),
  e('lexus', ['gx'], 2010, 2023, 87, 'Lexus spec, 23.0 gal'),
  e('hyundai', ['elantra'], 2007, 2010, 50, 'Hyundai spec, 13.2 gal'),
  e('hyundai', ['sonata'], 2011, 2019, 70, 'Hyundai spec, 18.5 gal'),
  e('hyundai', ['tucson'], 2016, 2021, 62, 'Hyundai spec, 16.4 gal'),
  e('nissan', ['altima'], 2007, 2012, 76, 'Nissan spec, 20.0 gal'),
  e('nissan', ['altima'], 2013, 2018, 68, 'Nissan spec, 18.0 gal'),
  e('nissan', ['sentra'], 2013, 2019, 50, 'Nissan spec, 13.2 gal'),
  e('ford', ['focus'], 2012, 2018, 47, 'Ford spec, 12.4 gal'),
  e('mercedes', ['cclass', 'c180', 'c200', 'c230', 'c250', 'c280', 'c300', 'c350'], 2008, 2021, 66, 'Mercedes-Benz spec, 66 L'),
  e('mercedes', ['eclass', 'e200', 'e230', 'e250', 'e280', 'e300', 'e320', 'e350'], 2003, 2016, 80, 'Mercedes-Benz spec, 80 L'),
];

const squash = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');

function makeKey(make: string): string {
  const m = squash(make);
  if (m.includes('mercedes') || m.includes('benz') || m === 'mb') return 'mercedes';
  return m;
}

/**
 * The tank in litres for a car, or null when it is not in the table.
 * Forgiving about case, spaces, hyphens, "Benz" and trim names ("Corolla LE"),
 * strict about the year: a year outside every listed range is unknown.
 */
export function vehicleTankLitres(make: string | null | undefined, model: string | null | undefined, year: number | null | undefined): number | null {
  if (!make || !model || year == null || !Number.isInteger(year)) return null;
  const mk = makeKey(make);
  const md = squash(model);
  if (!mk || !md) return null;
  // A model typed with its make ("Toyota Corolla") still matches.
  const mdNoMake = md.startsWith(mk) ? md.slice(mk.length) : md;
  let best: { len: number; litres: number } | null = null;
  for (const entry of VEHICLE_TANKS) {
    if (entry.make !== mk || year < entry.from || year > entry.to) continue;
    for (const name of entry.models) {
      if ((mdNoMake.startsWith(name) || md.startsWith(name)) && (!best || name.length > best.len)) best = { len: name.length, litres: entry.litres };
    }
  }
  return best?.litres ?? null;
}
