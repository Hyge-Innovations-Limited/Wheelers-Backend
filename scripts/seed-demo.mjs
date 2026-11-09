#!/usr/bin/env node
/**
 * Seeds Wheelers with a realistic 9-month operating history.
 *
 * The shape comes from the business model, not from random noise:
 *   • ₦88,000,000 processed across ~8,800 completed rides (avg ₦10,000, range ₦6k–₦14k)
 *   • 270 days (9 months), volume ramping from a handful of rides/day to ~50
 *   • Real Lagos routes — distance drives the fare (₦300/km), fare drives the
 *     duration, and the fee split is the SAME calculation production uses
 *     (7.5% VAT + ₦30 Lagos levy + ₦200 service fee), so the ledger reconciles.
 *   • Rides that never found a driver, rides riders abandoned, rides drivers
 *     dropped — the funnel is not perfect, because a real one never is.
 *   • Every naira has a trail: deposits fund riders, ride payments debit them,
 *     drivers get paid out and withdraw to their banks, the platform wallet
 *     accumulates fees. Running balances are computed in chronological order.
 *
 * Usage:
 *   node scripts/seed-demo.mjs --dry-run          # plan only, touches nothing
 *   node scripts/seed-demo.mjs --confirm          # write it
 *   node scripts/seed-demo.mjs --purge --confirm  # remove previously seeded data
 *
 * Options: --target=88000000 --days=270 --riders=3220 --drivers=280 --seed=42
 *          --database-url=postgres://...   (defaults to DATABASE_URL from .env)
 *
 * Everything it creates is tagged: seeded users have a `seed:` privyDid prefix,
 * so --purge can remove all of it and nothing else.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/* ─────────────────────────── args + env ─────────────────────────── */

const args = Object.fromEntries(
  process.argv.slice(2).map((raw) => {
    const [key, value] = raw.replace(/^--/, '').split('=');
    return [key, value ?? true];
  }),
);

const CONFIRM = args.confirm === true;
const DRY_RUN = args['dry-run'] === true || !CONFIRM;
const PURGE = args.purge === true;

const TARGET_NGN = Number(args.target ?? 88_000_000);
const DAYS = Number(args.days ?? 270);
const RIDER_COUNT = Number(args.riders ?? 3220);
const DRIVER_COUNT = Number(args.drivers ?? 280);
const SEED = Number(args.seed ?? 42);

function loadEnvFile() {
  try {
    return Object.fromEntries(
      readFileSync(new URL('../.env', import.meta.url), 'utf8')
        .split(/\r?\n/)
        .filter((line) => line && !line.startsWith('#') && line.includes('='))
        .map((line) => {
          const i = line.indexOf('=');
          return [line.slice(0, i).trim(), line.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')];
        }),
    );
  } catch {
    return {};
  }
}

const env = loadEnvFile();
const DATABASE_URL = args['database-url'] || process.env.DATABASE_URL || env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL not found (pass --database-url=... or set it in .env)');
  process.exit(1);
}

/* ─────────────────── deterministic randomness ─────────────────── */

function mulberry32(a) {
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(SEED);
const rand = () => rng();
const randInt = (min, max) => Math.floor(rand() * (max - min + 1)) + min;
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const chance = (p) => rand() < p;
/** Bell-ish value in [min,max] — averages of uniforms, so the middle is common. */
const bell = (min, max, sharpness = 3) => {
  let total = 0;
  for (let i = 0; i < sharpness; i += 1) total += rand();
  return min + (total / sharpness) * (max - min);
};

/* ───────────────────────── reference data ───────────────────────── */

const FIRST_NAMES = [
  // Igbo
  'Chinedu', 'Ifeoma', 'Amaka', 'Ngozi', 'Emeka', 'Chukwuma', 'Chiamaka', 'Uchenna',
  'Nkechi', 'Obinna', 'Kelechi', 'Chidi', 'Adaeze', 'Onyeka', 'Ebuka', 'Chioma',
  'Ifeanyi', 'Nnamdi', 'Chinwe', 'Okechukwu', 'Adaobi', 'Chukwudi', 'Ijeoma', 'Somtochukwu',
  'Nneka', 'Ikenna', 'Chidinma', 'Obiageli', 'Arinze', 'Ozioma', 'Chibuzo', 'Ugochi',
  // Yoruba
  'Adebayo', 'Oluwaseun', 'Tunde', 'Folake', 'Segun', 'Temitope', 'Babatunde', 'Bukola',
  'Damilola', 'Yetunde', 'Olumide', 'Simisola', 'Gbenga', 'Timilehin', 'Kunle', 'Toyin',
  'Adewale', 'Funmilayo', 'Olawale', 'Bisi', 'Ayodeji', 'Kehinde', 'Taiwo', 'Modupe',
  'Olabisi', 'Seyi', 'Ronke', 'Tolulope', 'Femi', 'Yemisi', 'Bolanle', 'Dayo',
  'Abiodun', 'Titilayo', 'Sade', 'Wale', 'Iyabo', 'Lanre', 'Omotola', 'Jide',
  // Hausa / Northern
  'Yusuf', 'Aisha', 'Ibrahim', 'Halima', 'Musa', 'Zainab', 'Fatima', 'Abdullahi',
  'Rukayat', 'Sadiq', 'Hauwa', 'Maryam', 'Sani', 'Aminu', 'Hadiza', 'Bashir',
  'Amina', 'Umar', 'Khadija', 'Nasir', 'Rabiu', 'Safiya', 'Kabiru', 'Zahra',
  'Suleiman', 'Binta', 'Mustapha', 'Jamila', 'Auwal', 'Hafsat',
  // Common / other
  'Blessing', 'Precious', 'Grace', 'Daniel', 'Victor', 'Peace', 'Joy', 'Samuel',
  'Esther', 'David', 'Favour', 'Emmanuel', 'Gloria', 'Michael', 'Mercy', 'Joshua',
  'Deborah', 'Peter', 'Rita', 'Success', 'Godwin', 'Patience', 'Stephen', 'Comfort',
];

const LAST_NAMES = [
  // Igbo
  'Okafor', 'Nwosu', 'Eze', 'Okonkwo', 'Chukwu', 'Obi', 'Nnamdi', 'Umeh',
  'Iheanacho', 'Anyanwu', 'Uzoma', 'Nwachukwu', 'Onwuka', 'Ezeani', 'Njoku', 'Okoye',
  'Nwankwo', 'Madu', 'Ugwu', 'Ibe', 'Okeke', 'Nwaogu', 'Agu', 'Onyema',
  'Ekwueme', 'Nwabueze', 'Obiora', 'Chikezie',
  // Yoruba
  'Adeyemi', 'Ogunlesi', 'Balogun', 'Adesanya', 'Adeleke', 'Ojo', 'Adekunle', 'Fashola',
  'Alabi', 'Akintola', 'Oladipo', 'Oyelaran', 'Bakare', 'Adebayo', 'Ogunleye', 'Sanni',
  'Afolabi', 'Adeoye', 'Ogundipe', 'Olawuyi', 'Aluko', 'Bamidele', 'Ademola', 'Owolabi',
  'Sotomi', 'Adegoke', 'Ilesanmi', 'Okanlawon', 'Adeniyi', 'Oyebode',
  // Hausa / Northern
  'Bello', 'Abubakar', 'Danjuma', 'Musa', 'Lawal', 'Ibrahim', 'Yakubu', 'Sanusi',
  'Garba', 'Suleiman', 'Mohammed', 'Aliyu', 'Usman', 'Shehu', 'Maikano', 'Gambo',
  'Tijani', 'Yaro', 'Dauda', 'Isah',
  // Other common surnames
  'Johnson', 'Williams', 'Thomas', 'Peters', 'James', 'Edet', 'Effiong', 'Bassey',
  'Etim', 'Akpan', 'Udoh', 'Inyang', 'Ekpo', 'Archibong',
];

/** Greater Lagos, real coordinates. Cross-town pairs land in the ₦6k–₦14k band. */
const LOCATIONS = [
  { area: 'Ikeja',            address: 'Allen Avenue, Ikeja, Lagos',                        lat: 6.6018, lng: 3.3515 },
  { area: 'Ikeja GRA',        address: 'Isaac John Street, Ikeja GRA, Lagos',               lat: 6.5833, lng: 3.3600 },
  { area: 'Opebi',            address: '102 Opebi Road, Opebi, Ikeja, Lagos',               lat: 6.5883, lng: 3.3626 },
  { area: 'Maryland',         address: 'Mobolaji Bank Anthony Way, Maryland, Lagos',        lat: 6.5697, lng: 3.3675 },
  { area: 'Yaba',             address: 'Herbert Macaulay Way, Yaba, Lagos',                 lat: 6.5095, lng: 3.3711 },
  { area: 'Akoka',            address: 'University of Lagos, Akoka, Yaba, Lagos',           lat: 6.5158, lng: 3.3898 },
  { area: 'Surulere',         address: 'Adeniran Ogunsanya Street, Surulere, Lagos',        lat: 6.4924, lng: 3.3540 },
  { area: 'Victoria Island',  address: 'Adeola Odeku Street, Victoria Island, Lagos',       lat: 6.4281, lng: 3.4219 },
  { area: 'Ikoyi',            address: 'Awolowo Road, Ikoyi, Lagos',                        lat: 6.4520, lng: 3.4340 },
  { area: 'Lekki Phase 1',    address: 'Admiralty Way, Lekki Phase 1, Lagos',               lat: 6.4433, lng: 3.4720 },
  { area: 'Chevron',          address: 'Chevron Roundabout, Lekki, Lagos',                  lat: 6.4444, lng: 3.5386 },
  { area: 'Ajah',             address: 'Ajah Roundabout, Ajah, Lagos',                      lat: 6.4667, lng: 3.5667 },
  { area: 'Sangotedo',        address: 'Novare Mall, Sangotedo, Lagos',                     lat: 6.4667, lng: 3.6167 },
  { area: 'Apapa',            address: 'Warehouse Road, Apapa, Lagos',                      lat: 6.4483, lng: 3.3592 },
  { area: 'Festac',           address: '2nd Avenue, Festac Town, Lagos',                    lat: 6.4667, lng: 3.2833 },
  { area: 'Ojo',              address: 'Lagos State University, Ojo, Lagos',                lat: 6.4667, lng: 3.2000 },
  { area: 'Alimosho',         address: 'Egbeda Roundabout, Alimosho, Lagos',                lat: 6.5900, lng: 3.2833 },
  { area: 'Ikorodu',          address: 'Ikorodu Garage, Ikorodu, Lagos',                    lat: 6.6194, lng: 3.5106 },
  { area: 'Agege',            address: 'Agege Motor Road, Agege, Lagos',                    lat: 6.6153, lng: 3.3225 },
  { area: 'Oshodi',           address: 'Oshodi Interchange, Oshodi, Lagos',                 lat: 6.5556, lng: 3.3392 },
  { area: 'Gbagada',          address: 'Diya Street, Gbagada, Lagos',                       lat: 6.5556, lng: 3.3892 },
  { area: 'Magodo',           address: 'CMD Road, Magodo, Lagos',                           lat: 6.6206, lng: 3.3897 },
  { area: 'Berger',           address: 'Berger Bus Stop, Ojodu, Lagos',                     lat: 6.6400, lng: 3.3600 },
  { area: 'Badagry',          address: 'Badagry Expressway, Badagry, Lagos',                lat: 6.4150, lng: 2.8814 },
  { area: 'Epe',              address: 'Epe Town, Epe, Lagos',                              lat: 6.5833, lng: 3.9833 },
  { area: 'Murtala Airport',  address: 'Murtala Muhammed Airport, Ikeja, Lagos',            lat: 6.5774, lng: 3.3212 },
];

const VEHICLES = [
  { make: 'Toyota',   models: ['Corolla', 'Camry', 'Matrix', 'Sienna', 'Highlander'] },
  { make: 'Honda',    models: ['Accord', 'Civic', 'CR-V', 'Pilot'] },
  { make: 'Kia',      models: ['Rio', 'Cerato', 'Sportage', 'Picanto'] },
  { make: 'Hyundai',  models: ['Elantra', 'Accent', 'Sonata', 'Tucson'] },
  { make: 'Nissan',   models: ['Almera', 'Sentra', 'Primera', 'Qashqai'] },
  { make: 'Mercedes-Benz', models: ['C300', 'E350', 'GLK'] },
  { make: 'Volkswagen',    models: ['Golf', 'Passat', 'Jetta'] },
];
const PLATE_PREFIXES = ['LND', 'KJA', 'AGL', 'EPE', 'IKJ', 'BDG', 'SMK', 'FKJ', 'JJJ', 'GGE'];

const RIDER_CANCEL_REASONS = [
  'Long waiting time', 'Changed my mind', 'Accidental request',
  'Found another ride', 'Driver too far', 'Price too high',
];
const DRIVER_CANCEL_REASONS = [
  'Driver cancelled', 'Driver unreachable', 'Vehicle issue',
];
const NO_DRIVER_REASON = 'No driver accepted in time';

/* ───────────────────────── domain helpers ───────────────────────── */

const RATE_PER_KM_NGN = 300;
const MIN_FARE_NGN = 3000;
const FARE_ROUNDING_INCREMENT = 100;
const VAT_RATE = 0.075;
const LAGOS_STATE_FEE_NGN = 30;
const SERVICE_FEE_NGN = 200;
const MIN_OFFER_DISCOUNT = 0.28;

const round2 = (v) => Math.round(v * 100) / 100;

/** Mirrors packages/config/src/pricing.ts — keep in step if the fee model changes. */
function calculateRideFees(fareNgn) {
  const stateLevyNgn = LAGOS_STATE_FEE_NGN;
  const vatNgn = round2(fareNgn * VAT_RATE);
  const serviceFeeNgn = SERVICE_FEE_NGN;
  const rawPlatformTotalNgn = round2(vatNgn + stateLevyNgn + serviceFeeNgn);
  const rawDriverPayoutNgn = round2(fareNgn - rawPlatformTotalNgn);
  const driverPayoutNgn = Math.max(0, rawDriverPayoutNgn);
  const platformTotalNgn = rawDriverPayoutNgn < 0 ? round2(fareNgn) : rawPlatformTotalNgn;
  return { fareNgn, vatNgn, stateLevyNgn, serviceFeeNgn, platformTotalNgn, driverPayoutNgn };
}

function suggestedFare(distanceKm) {
  const raw = RATE_PER_KM_NGN * distanceKm;
  return Math.max(MIN_FARE_NGN, Math.ceil(raw / FARE_ROUNDING_INCREMENT) * FARE_ROUNDING_INCREMENT);
}

function haversineKm(a, b) {
  const toRad = (n) => (n * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

/** Road distance is longer than straight-line; Lagos is roughly 1.35x. */
const ROAD_FACTOR = 1.35;

/** Route pairs whose fare lands in the target band, precomputed once. */
function buildRoutePairs(minFare, maxFare) {
  const pairs = [];
  for (let i = 0; i < LOCATIONS.length; i += 1) {
    for (let j = 0; j < LOCATIONS.length; j += 1) {
      if (i === j) continue;
      const distanceKm = round2(haversineKm(LOCATIONS[i], LOCATIONS[j]) * ROAD_FACTOR);
      const fare = suggestedFare(distanceKm);
      if (fare >= minFare && fare <= maxFare) {
        pairs.push({ from: LOCATIONS[i], to: LOCATIONS[j], distanceKm, fare });
      }
    }
  }
  return pairs.sort((a, b) => a.fare - b.fare);
}

/**
 * Lagos has many more short cross-town pairs than long ones, so picking a
 * route uniformly would drag the average fare well below the ₦10,000 the
 * business model assumes. Draw the *price* first from a bell centred on the
 * target, then take a route that actually costs that — the geography stays
 * real and the revenue lands where it should.
 */
function makeRoutePicker(pairs, targetAvgFare, minFare, maxFare) {
  const fares = pairs.map((p) => p.fare);
  return function pickRoute() {
    const spread = Math.min(targetAvgFare - minFare, maxFare - targetAvgFare);
    const wanted = targetAvgFare + (bell(-1, 1, 3) * spread);
    // Nearest fare, then a little jitter among equally-priced routes.
    let lo = 0;
    let hi = fares.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (fares[mid] < wanted) lo = mid + 1;
      else hi = mid;
    }
    const window = 6;
    const from = Math.max(0, lo - window);
    const to = Math.min(pairs.length - 1, lo + window);
    return pairs[randInt(from, to)];
  };
}

function uuid() {
  const hex = '0123456789abcdef';
  let out = '';
  for (let i = 0; i < 36; i += 1) {
    if (i === 8 || i === 13 || i === 18 || i === 23) out += '-';
    else if (i === 14) out += '4';
    else if (i === 19) out += hex[(Math.floor(rand() * 16) & 0x3) | 0x8];
    else out += hex[Math.floor(rand() * 16)];
  }
  return out;
}

const usedPhones = new Set();
function phoneNumber() {
  for (;;) {
    const prefix = pick(['0803', '0806', '0810', '0813', '0814', '0703', '0706', '0805', '0815', '0902', '0905', '0703']);
    const phone = `+234${prefix.slice(1)}${String(randInt(1000000, 9999999)).padStart(7, '0')}`;
    if (!usedPhones.has(phone)) {
      usedPhones.add(phone);
      return phone;
    }
  }
}

const usedUsernames = new Set();
function usernameFor(name) {
  const first = name.toLowerCase().split(' ')[0].replace(/[^a-z0-9]/g, '');
  for (;;) {
    const candidate = `${first}${randInt(10, 999999)}`;
    if (!usedUsernames.has(candidate)) {
      usedUsernames.add(candidate);
      return candidate;
    }
  }
}

/**
 * Real people share names, so these do too — no numeric suffixes. Only
 * `username` carries a DB uniqueness constraint, and usernameFor() owns that.
 */
function personName() {
  return `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`;
}

/** Honorifics and nicknames people actually put in a WhatsApp display name. */
const WA_TITLES = ['Alhaji', 'Alhaja', 'Chief', 'Engr', 'Barr', 'Dr', 'Pastor', 'Sir', 'Uncle', 'Aunty', 'Mummy', 'Daddy', 'Big', 'Oga'];
const WA_SUFFIXES = ['Baby', 'Gold', 'Benz', 'Cash', 'Boy', 'Girl', 'Jnr', 'Blessed', 'Pikin', 'Money'];
const WA_PLACES = ['Lekki', 'Ikeja', 'Yaba', 'Surulere', 'Ajah', 'VI', 'Festac', 'Ikorodu', 'Gbagada', 'Apapa'];
const WA_NICKNAMES = [
  'Timmy', 'Balosh', 'Tega', 'Dammy', 'Kemzy', 'Chidozzy', 'Bukky', 'Segzy',
  'Tunji', 'Ify', 'Nonso', 'Shola', 'Yemzy', 'Kachi', 'Bibi', 'Deji',
  'Lekan', 'Nkem', 'Femzy', 'Ruky', 'Tobi', 'Ejay', 'Somto', 'Bimbo',
  'Chuks', 'Dupe', 'Kunle', 'Zeeboy', 'Ada', 'Ola', 'Emeks', 'Tolu',
];

/**
 * WhatsApp riders never typed a name into Wheelers — the bot stores whatever
 * their WhatsApp profile says. In Nigeria that is rarely "Firstname Lastname":
 * it is a nickname, a title, a trade, or a single word. Seeding formal names
 * for these accounts made the user list look fake in a way the real one is not.
 */
function whatsappProfileName() {
  const first = pick(FIRST_NAMES);
  const r = rand();

  if (r < 0.22) return pick(WA_NICKNAMES);                                  // Timmy
  if (r < 0.36) return first;                                               // Ibrahim
  if (r < 0.50) return `${pick(WA_TITLES)} ${first}`;                       // Alhaji Yusuf
  if (r < 0.60) return `${first} ${pick(WA_SUFFIXES)}`;                     // Ada Baby
  if (r < 0.68) return `${first} ${pick(WA_PLACES)}`;                       // Musa Lekki
  if (r < 0.74) return `${pick(WA_NICKNAMES)} ${pick(WA_SUFFIXES)}`;        // Tega Cash
  if (r < 0.79) return first.toUpperCase();                                 // TUNDE
  if (r < 0.83) return `${pick(WA_TITLES)} ${pick(WA_NICKNAMES)}`;          // Oga Chuks
  return `${first} ${pick(LAST_NAMES)}`;                                    // the formal minority
}

function emailFor(name, index) {
  const [first, last] = name.toLowerCase().split(' ');
  return `${first}.${last}${index}@${pick(['gmail.com', 'yahoo.com', 'outlook.com', 'gmail.com'])}`;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const START = new Date(Date.now() - DAYS * DAY_MS);
const dayStart = (dayIndex) => new Date(START.getTime() + dayIndex * DAY_MS);

/** A plausible request time — morning and evening rush carry the day. */
function requestTimeOn(dayIndex) {
  const base = dayStart(dayIndex);
  const r = rand();
  let hour;
  if (r < 0.28) hour = randInt(6, 9);        // morning rush
  else if (r < 0.44) hour = randInt(10, 14); // midday
  else if (r < 0.78) hour = randInt(15, 20); // evening rush
  else if (r < 0.93) hour = randInt(21, 23); // night
  else hour = randInt(0, 5);                 // late night
  base.setHours(hour, randInt(0, 59), randInt(0, 59), 0);
  return base;
}

/**
 * Daily volume ramp: a young business grows. Starts near 8 rides/day, ends
 * near 55, with weekday/weekend and week-to-week wobble. Normalised later so
 * the completed total hits the target exactly.
 */
function volumeWeight(dayIndex) {
  const progress = dayIndex / Math.max(1, DAYS - 1);
  const growth = 0.25 + 1.55 * progress ** 1.25;          // ramp
  const weekday = dayStart(dayIndex).getDay();
  const weekendDip = weekday === 0 ? 0.72 : weekday === 6 ? 0.88 : 1;
  const wobble = 0.82 + 0.36 * rand();                     // day-to-day noise
  const payday = dayStart(dayIndex).getDate() <= 3 ? 1.18 : 1; // start-of-month bump
  return growth * weekendDip * wobble * payday;
}

/* ─────────────────────────── generation ─────────────────────────── */

function generate(completedTargetOverride) {
  const avgFare = 10_000;
  const targetCompleted = completedTargetOverride ?? Math.round(TARGET_NGN / avgFare);

  const routePairs = buildRoutePairs(6000, 14000);
  if (routePairs.length === 0) throw new Error('No Lagos route pairs land in the ₦6k–₦14k band');
  const pickRoute = makeRoutePicker(routePairs, avgFare, 6000, 14000);

  /* ---- people ---- */

  const now = new Date();
  const users = [];
  const drivers = [];
  const kycSubmissions = [];

  // Drivers are recruited early — you cannot serve rides without them.
  for (let i = 0; i < DRIVER_COUNT; i += 1) {
    const name = personName();
    const joinedDay = Math.floor(bell(0, DAYS * 0.75, 2));
    const createdAt = requestTimeOn(joinedDay);
    const userId = uuid();
    const vehicle = pick(VEHICLES);
    // Most drivers clear KYC; a tail is stuck in review or was rejected.
    // A live platform always has a queue: most drivers are approved, a real
    // slice is waiting on review, a few were turned down.
    const kycRoll = rand();
    const kycStatus = kycRoll < 0.72 ? 'APPROVED' : kycRoll < 0.88 ? 'SUBMITTED' : kycRoll < 0.94 ? 'PENDING' : 'REJECTED';
    users.push({
      id: userId,
      privyDid: `seed:driver:${userId}`,
      name,
      phone: phoneNumber(),
      email: emailFor(name, i),
      role: 'DRIVER',
      riderKycStatus: 'NONE',
      createdAt,
      isDriver: true,
    });
    drivers.push({
      id: uuid(),
      userId,
      name,
      createdAt,
      kycStatus,
      canDrive: kycStatus === 'APPROVED',
      status: 'OFFLINE',
      rating: round2(bell(3.8, 5, 4)),
      vehicleMake: vehicle.make,
      vehicleModel: pick(vehicle.models),
      vehiclePlate: `${pick(PLATE_PREFIXES)}-${randInt(100, 999)}${pick('ABCDEFGHJKLMNPQRSTUVWXYZ')}${pick('ABCDEFGHJKLMNPQRSTUVWXYZ')}`,
      vehicleYear: randInt(2006, 2021),
      totalRides: 0,
      totalEarningsNgn: 0,
      lat: null,
      lng: null,
      lastSeenAt: null,
    });

    // The KYC queue the admin panel reviews. Only drivers who actually filed
    // paperwork have a submission row — PENDING means they never finished.
    if (kycStatus !== 'PENDING') {
      const driver = drivers[drivers.length - 1];
      const submittedAt = new Date(createdAt.getTime() + randInt(600, 3 * 24 * 3600) * 1000);
      kycSubmissions.push({
        id: uuid(),
        driverId: driver.id,
        status: kycStatus,
        vehicleMake: driver.vehicleMake,
        vehicleModel: driver.vehicleModel,
        vehiclePlate: driver.vehiclePlate,
        vehicleYear: driver.vehicleYear,
        submittedAt,
        reviewedAt: kycStatus === 'SUBMITTED' ? null : new Date(submittedAt.getTime() + randInt(3600, 5 * 24 * 3600) * 1000),
        rejectionReason: kycStatus === 'REJECTED'
          ? pick(['Licence expired', 'Vehicle photos unclear', 'Selfie does not match NIN', 'Plate number unreadable'])
          : null,
        createdAt: submittedAt,
      });
    }
  }

  // Riders arrive on a growth curve too — more sign-ups as the product spreads.
  for (let i = 0; i < RIDER_COUNT; i += 1) {
    const progress = rand() ** 0.62;               // skewed toward recent months
    const joinedDay = Math.min(DAYS - 1, Math.floor(progress * DAYS));
    const userId = uuid();
    // Roughly half arrive through WhatsApp and never set an email/password.
    const viaWhatsapp = chance(0.82);
    // Their name is whatever their WhatsApp profile says, not a form field.
    const name = viaWhatsapp ? whatsappProfileName() : personName();
    const kycRoll = rand();
    users.push({
      id: userId,
      privyDid: `seed:rider:${userId}`,
      name,
      phone: phoneNumber(),
      email: viaWhatsapp ? null : emailFor(name, DRIVER_COUNT + i),
      username: viaWhatsapp ? null : usernameFor(name),
      role: 'RIDER',
      // Rider KYC is optional and almost nobody bothers — seeding a fifth of
      // the base as verified was wishful thinking, not data.
      riderKycStatus: kycRoll < 0.035 ? 'VERIFIED' : kycRoll < 0.055 ? 'PENDING' : 'NONE',
      createdAt: requestTimeOn(joinedDay),
      joinedDay,
      isDriver: false,
    });
  }

  const riders = users.filter((u) => !u.isDriver);

  /**
   * Ride frequency is a long tail: most riders try it once or twice, a small
   * core rides constantly. Weight = expected lifetime rides.
   */
  for (const rider of riders) {
    const r = rand();
    rider.frequency =
      r < 0.42 ? 1 :          // one-and-done
      r < 0.68 ? randInt(2, 3) :
      r < 0.86 ? randInt(4, 8) :
      r < 0.96 ? randInt(9, 18) :
                 randInt(19, 45); // power users
    rider.ridesTaken = 0;
  }

  /* ---- rides, day by day ---- */

  const weights = [];
  let weightTotal = 0;
  for (let day = 0; day < DAYS; day += 1) {
    const w = volumeWeight(day);
    weights.push(w);
    weightTotal += w;
  }

  const rides = [];
  const holds = [];
  let completedCount = 0;

  const activeDriversOn = (day) =>
    drivers.filter((d) => d.canDrive && d.createdAt.getTime() <= dayStart(day).getTime());

  for (let day = 0; day < DAYS; day += 1) {
    const share = weights[day] / weightTotal;
    const completedToday = Math.max(0, Math.round(targetCompleted * share));
    if (completedToday === 0) continue;

    // Not every request becomes a trip: ~72% complete. The rest are the messy
    // reality — no driver ever accepted, the rider gave up, the driver bailed.
    const attemptsToday = Math.round(completedToday / 0.62);
    const pool = activeDriversOn(day);
    const eligibleRiders = riders.filter(
      (r) => r.joinedDay <= day && r.ridesTaken < r.frequency,
    );
    if (eligibleRiders.length === 0 || pool.length === 0) continue;

    for (let n = 0; n < attemptsToday; n += 1) {
      const rider = pick(eligibleRiders);
      const route = pickRoute();
      const createdAt = requestTimeOn(day);
      if (createdAt > now) continue;

      const fareEstimateNgn = route.fare;
      // Riders haggle: most take the suggested price, some offer below it.
      const minOffer = Math.max(MIN_FARE_NGN, Math.round(fareEstimateNgn * (1 - MIN_OFFER_DISCOUNT)));
      const riderOfferNgn = chance(0.3)
        ? Math.max(minOffer, Math.round((fareEstimateNgn * bell(0.78, 1, 2)) / 100) * 100)
        : fareEstimateNgn;

      const outcome = rand();
      const rideId = uuid();
      const base = {
        id: rideId,
        riderId: rider.id,
        pickupLat: route.from.lat,
        pickupLng: route.from.lng,
        pickupAddress: route.from.address,
        destLat: route.to.lat,
        destLng: route.to.lng,
        destAddress: route.to.address,
        paymentMethod: 'WALLET',
        fareEstimateNgn,
        riderOfferNgn,
        distanceKm: route.distanceKm,
        createdAt,
      };

      // ── never matched: the driver-search ran out of road ──
      if (outcome < 0.235) {
        rides.push({
          ...base,
          status: 'CANCELLED',
          cancelStage: 'BEFORE_MATCH',
          cancelReason: NO_DRIVER_REASON,
          cancelledAt: new Date(createdAt.getTime() + randInt(180, 320) * 1000),
        });
        continue;
      }

      // ── rider walked away while waiting for bids ──
      if (outcome < 0.30) {
        rides.push({
          ...base,
          status: 'CANCELLED',
          cancelStage: 'BEFORE_MATCH',
          cancelReason: pick(RIDER_CANCEL_REASONS),
          cancelledAt: new Date(createdAt.getTime() + randInt(40, 240) * 1000),
        });
        continue;
      }

      const driver = pick(pool);
      const matchedAt = new Date(createdAt.getTime() + randInt(25, 170) * 1000);
      const agreedFareNgn = chance(0.22)
        ? Math.max(minOffer, Math.round((riderOfferNgn * bell(1, 1.12, 2)) / 100) * 100)
        : riderOfferNgn;

      // ── driver accepted, then dropped it ──
      if (outcome < 0.34) {
        rides.push({
          ...base,
          driverId: driver.id,
          status: 'CANCELLED',
          cancelStage: 'AFTER_MATCH',
          cancelReason: pick(DRIVER_CANCEL_REASONS),
          agreedFareNgn,
          matchedAt,
          cancelledAt: new Date(matchedAt.getTime() + randInt(60, 600) * 1000),
        });
        continue;
      }

      // ── a live trip right now (only the last couple of days) ──
      if (day >= DAYS - 2 && outcome < 0.45) {
        rides.push({
          ...base,
          driverId: driver.id,
          status: pick(['DRIVER_ASSIGNED', 'DRIVER_EN_ROUTE', 'ARRIVED', 'IN_PROGRESS']),
          agreedFareNgn,
          matchedAt,
          startedAt: chance(0.5) ? new Date(matchedAt.getTime() + randInt(300, 900) * 1000) : null,
        });
        holds.push({ rideId, riderId: rider.id, driverUserId: driver.userId, amountNgn: agreedFareNgn, status: 'ACTIVE', createdAt });
        continue;
      }

      // ── completed ──
      const arrivedAt = new Date(matchedAt.getTime() + randInt(240, 900) * 1000);
      const startedAt = new Date(arrivedAt.getTime() + randInt(30, 420) * 1000);
      // Lagos traffic: ~18-26 km/h door to door.
      const durationSeconds = Math.round((route.distanceKm / bell(16, 27, 2)) * 3600);
      const completedAt = new Date(startedAt.getTime() + durationSeconds * 1000);
      if (completedAt > now) continue;

      const fees = calculateRideFees(agreedFareNgn);
      const disputed = chance(0.004);

      rides.push({
        ...base,
        driverId: driver.id,
        status: disputed ? 'DISPUTED' : 'COMPLETED',
        agreedFareNgn,
        fareFinalNgn: agreedFareNgn,
        platformFeeNgn: fees.platformTotalNgn,
        durationSeconds,
        matchedAt,
        arrivedAt,
        startedAt,
        completedAt,
        _settlement: {
          driverUserId: driver.userId,
          driverIndex: driver.id,
          fees,
          completedAt,
        },
      });

      holds.push({
        rideId,
        riderId: rider.id,
        driverUserId: driver.userId,
        amountNgn: agreedFareNgn,
        status: 'CHARGED',
        settledAmountNgn: agreedFareNgn,
        settledAt: completedAt,
        createdAt,
      });

      rider.ridesTaken += 1;
      driver.totalRides += 1;
      driver.totalEarningsNgn = round2(driver.totalEarningsNgn + fees.driverPayoutNgn);
      completedCount += 1;
    }
  }

  // A slice of approved drivers is online right now.
  for (const driver of drivers) {
    if (!driver.canDrive) continue;
    if (driver.totalRides === 0) continue;
    const roll = rand();
    if (roll < 0.18) {
      driver.status = 'ONLINE';
      const spot = pick(LOCATIONS);
      driver.lat = round2(spot.lat + (rand() - 0.5) * 0.05);
      driver.lng = round2(spot.lng + (rand() - 0.5) * 0.05);
      driver.lastSeenAt = new Date(now.getTime() - randInt(5, 900) * 1000);
    } else if (roll < 0.24) {
      driver.status = 'ON_RIDE';
      const spot = pick(LOCATIONS);
      driver.lat = round2(spot.lat + (rand() - 0.5) * 0.05);
      driver.lng = round2(spot.lng + (rand() - 0.5) * 0.05);
      driver.lastSeenAt = new Date(now.getTime() - randInt(5, 300) * 1000);
    } else {
      driver.lastSeenAt = new Date(now.getTime() - randInt(600, 20 * DAY_MS / 1000) * 1000);
    }
  }

  /* ---- group rides ---- */

  // A share of riders try a group ride. The funnel is deliberately lossy: the
  // verification selfie is a real wall, and plenty of requests never find
  // anybody heading the same way before they expire.
  const groupRequests = [];
  const faceVerifications = [];
  const groupCandidates = riders.filter(() => chance(0.09));

  for (const rider of groupCandidates) {
    const attempts = chance(0.25) ? 2 : 1;
    for (let n = 0; n < attempts; n += 1) {
      const day = randInt(rider.joinedDay, DAYS - 1);
      const createdAt = requestTimeOn(day);
      if (createdAt > now) continue;

      const route = pickRoute();
      // A seat in a shared car is meaningfully cheaper than riding alone.
      const seatFare = Math.round((route.fare * bell(0.52, 0.7, 2)) / 100) * 100;
      const id = uuid();

      const roll = rand();
      let status;
      let readyForMatchAt = null;
      let matchingStartedAt = null;
      let groupedAt = null;
      let bookedAt = null;
      let expiredAt = null;
      let cancelledAt = null;
      let cancelReason = null;
      let faceStatus = null;

      if (roll < 0.31) {
        // Never took the selfie — the single biggest drop-off.
        status = 'PENDING_FACE_UPLOAD';
        if (chance(0.35)) faceStatus = chance(0.5) ? 'UPLOADING' : 'FAILED';
      } else {
        faceStatus = 'STORED';
        readyForMatchAt = new Date(createdAt.getTime() + randInt(40, 400) * 1000);

        if (roll < 0.44) {
          status = 'READY_FOR_MATCH';
        } else if (roll < 0.52) {
          status = 'MATCHING';
          matchingStartedAt = new Date(readyForMatchAt.getTime() + randInt(10, 90) * 1000);
        } else if (roll < 0.62) {
          status = 'EXPIRED';
          matchingStartedAt = new Date(readyForMatchAt.getTime() + randInt(10, 90) * 1000);
          expiredAt = new Date(matchingStartedAt.getTime() + randInt(500, 900) * 1000);
        } else if (roll < 0.70) {
          status = 'CANCELLED';
          cancelledAt = new Date(readyForMatchAt.getTime() + randInt(60, 800) * 1000);
          cancelReason = pick(['Changed my mind', 'Waiting too long', 'Found another ride']);
        } else if (roll < 0.82) {
          status = 'GROUPED';
          matchingStartedAt = new Date(readyForMatchAt.getTime() + randInt(10, 90) * 1000);
          groupedAt = new Date(matchingStartedAt.getTime() + randInt(30, 420) * 1000);
        } else {
          status = 'BOOKED';
          matchingStartedAt = new Date(readyForMatchAt.getTime() + randInt(10, 90) * 1000);
          groupedAt = new Date(matchingStartedAt.getTime() + randInt(30, 420) * 1000);
          bookedAt = new Date(groupedAt.getTime() + randInt(20, 180) * 1000);
        }
      }

      groupRequests.push({
        id,
        userId: rider.id,
        status,
        groupId: null,
        pickupLat: route.from.lat,
        pickupLng: route.from.lng,
        pickupAddress: route.from.address,
        destLat: route.to.lat,
        destLng: route.to.lng,
        destAddress: route.to.address,
        // Product rule: group matching never asks about gender.
        genderPreference: 'ANY',
        plannedDistanceKm: route.distanceKm,
        plannedDurationSeconds: Math.round((route.distanceKm / 20) * 3600),
        fareEstimateNgn: seatFare,
        readyForMatchAt,
        matchingStartedAt,
        groupedAt,
        bookedAt,
        expiredAt,
        cancelledAt,
        cancelReason,
        createdAt,
        _groupable: status === 'GROUPED' || status === 'BOOKED',
      });

      if (faceStatus) {
        faceVerifications.push({
          id: uuid(),
          matchRequestId: id,
          userId: rider.id,
          bucket: 'wheelers-group-ride-faces',
          objectKey: `group-rides/face-verification/${id}.jpg`,
          mimeType: 'image/jpeg',
          sizeBytes: randInt(60_000, 420_000),
          uploadStatus: faceStatus,
          capturedAt: createdAt,
          storedAt: faceStatus === 'STORED' ? new Date(createdAt.getTime() + randInt(5, 60) * 1000) : null,
          failedAt: faceStatus === 'FAILED' ? new Date(createdAt.getTime() + randInt(5, 60) * 1000) : null,
          failureReason: faceStatus === 'FAILED'
            ? pick(['Face not detected', 'Photo too blurry', 'Not a live photo'])
            : null,
          createdAt,
        });
      }
    }
  }

  // Pair matched requests into actual groups of 2–3 travelling the same way.
  const groupable = groupRequests.filter((r) => r._groupable);
  for (let i = 0; i < groupable.length; ) {
    const size = Math.min(groupable.length - i, chance(0.68) ? 2 : 3);
    if (size < 2) break;
    const groupId = uuid();
    const members = groupable.slice(i, i + size);
    const memberIds = members.map((m) => m.id);
    for (const member of members) {
      member.groupId = groupId;
      member.matchedRideIds = memberIds;
    }
    i += size;
  }

  return {
    users, drivers, kycSubmissions, riders, rides, holds,
    groupRequests, faceVerifications,
    completedCount, routePairs, now, targetCompleted,
  };
}

/** Gross processed = what the target is actually expressed in. */
function grossOf(data) {
  return data.rides.reduce(
    (sum, r) => (r.status === 'COMPLETED' ? sum + Number(r.fareFinalNgn) : sum),
    0,
  );
}

/**
 * Rides are built from real routes, so the average fare is an outcome, not an
 * input — it lands near ₦10,000 but never exactly. Generate, measure, correct
 * the ride count, repeat. Two or three passes puts the gross within ~1% of the
 * target instead of a few million short.
 */
function generateCalibrated() {
  let best = generate();
  let bestGap = Math.abs(grossOf(best) - TARGET_NGN);
  let rideTarget = best.targetCompleted;

  for (let pass = 0; pass < 4 && bestGap / TARGET_NGN > 0.01; pass += 1) {
    const gross = grossOf(best);
    if (gross <= 0) break;
    rideTarget = Math.round(rideTarget * (TARGET_NGN / gross));
    const candidate = generate(rideTarget);
    const gap = Math.abs(grossOf(candidate) - TARGET_NGN);
    if (gap < bestGap) {
      best = candidate;
      bestGap = gap;
    }
  }
  return best;
}

/* ──────────────────────────── the ledger ──────────────────────────── */

/**
 * Replays every money movement in chronological order so `balanceAfterNgn` on
 * each transaction — and the closing wallet balance — are arithmetically true,
 * exactly as they would be if these rides had actually happened.
 */
function buildLedger({ users, drivers, rides, now }) {
  const PLATFORM_USER_ID = '00000000-0000-0000-0000-000000000001';

  const wallets = new Map(); // userId -> { id, balance, locked }
  const walletFor = (userId) => {
    let w = wallets.get(userId);
    if (!w) {
      w = { id: uuid(), userId, balance: 0, locked: 0 };
      wallets.set(userId, w);
    }
    return w;
  };
  for (const user of users) walletFor(user.id);
  const platformWallet = walletFor(PLATFORM_USER_ID);

  const driverByUserId = new Map(drivers.map((d) => [d.userId, d]));

  // Every money event, then sorted by time.
  const events = [];
  for (const ride of rides) {
    if (!ride._settlement) continue;
    events.push({ at: ride._settlement.completedAt, kind: 'settle', ride });
  }
  events.sort((a, b) => a.at - b.at);

  const transactions = [];
  const withdrawals = [];
  const reservations = [];

  const txn = (wallet, type, direction, amountNgn, referenceId, createdAt, metadata) => {
    wallet.balance = round2(wallet.balance + (direction === 'CREDIT' ? amountNgn : -amountNgn));
    transactions.push({
      id: uuid(),
      walletId: wallet.id,
      type,
      direction,
      amountNgn,
      balanceAfterNgn: wallet.balance,
      referenceId,
      metadata: metadata ?? null,
      createdAt,
    });
  };

  const depositsByUser = new Map();

  for (const event of events) {
    const { ride } = event;
    const { fees, driverUserId, completedAt } = ride._settlement;
    const fareNgn = Number(ride.fareFinalNgn);
    const riderWallet = walletFor(ride.riderId);

    // Riders top up when they are short — the deposit that funds this trip.
    if (riderWallet.balance < fareNgn) {
      const shortfall = fareNgn - riderWallet.balance;
      // People fund in round numbers, usually more than one trip's worth.
      const topUp = Math.max(
        5000,
        Math.ceil((shortfall * bell(1.1, 3.2, 2)) / 1000) * 1000,
      );
      const depositAt = new Date(completedAt.getTime() - randInt(200, 7200) * 1000);
      txn(riderWallet, 'DEPOSIT', 'CREDIT', topUp, `seed-deposit-${uuid()}`, depositAt, { seed: true, channel: 'virtual_account' });
      depositsByUser.set(ride.riderId, (depositsByUser.get(ride.riderId) ?? 0) + topUp);
    }

    txn(riderWallet, 'RIDE_PAYMENT', 'DEBIT', fareNgn, ride.id, completedAt);

    const driverWallet = walletFor(driverUserId);
    txn(driverWallet, 'DRIVER_PAYOUT', 'CREDIT', fees.driverPayoutNgn, ride.id, completedAt);

    txn(platformWallet, 'PLATFORM_FEE', 'CREDIT', fees.platformTotalNgn, ride.id, completedAt);

    // Drivers cash out once they have built up a balance.
    if (driverWallet.balance >= 60_000 && chance(0.55)) {
      const amount = Math.floor((driverWallet.balance * bell(0.6, 0.95, 2)) / 500) * 500;
      if (amount >= 5000) {
        const at = new Date(completedAt.getTime() + randInt(3600, 3 * 24 * 3600) * 1000);
        if (at <= now) {
          const driver = driverByUserId.get(driverUserId);
          const reservationId = uuid();
          const roll = rand();
          const status = roll < 0.9 ? 'SETTLED' : roll < 0.97 ? 'PROCESSING' : 'FAILED';
          const settled = status === 'SETTLED';

          reservations.push({
            id: reservationId,
            walletId: driverWallet.id,
            userId: driverUserId,
            kind: 'WITHDRAWAL',
            status: settled ? 'CONSUMED' : status === 'FAILED' ? 'RELEASED' : 'ACTIVE',
            amountNgn: amount,
            referenceId: `seed-withdrawal-${reservationId}`,
            createdAt: at,
            consumedAt: settled ? at : null,
            releasedAt: status === 'FAILED' ? at : null,
          });

          withdrawals.push({
            id: uuid(),
            userId: driverUserId,
            walletId: driverWallet.id,
            reservationId,
            status,
            requestedAmountNgn: amount,
            reservedAmountNgn: amount,
            bankAccountNumber: String(randInt(1000000000, 9999999999)),
            bankAccountName: (driver?.name ?? 'Wheelers Driver').toUpperCase(),
            bankNetworkId: uuid(),
            failureReason: status === 'FAILED' ? 'Bank rejected the transfer' : null,
            createdAt: at,
            settledAt: settled ? at : null,
            failedAt: status === 'FAILED' ? at : null,
          });

          if (settled) {
            txn(driverWallet, 'WITHDRAWAL', 'DEBIT', amount, `seed-withdrawal-${reservationId}`, at, { seed: true, bank: 'payout' });
          }
        }
      }
    }
  }

  // Funds locked against rides that are still in flight.
  for (const ride of rides) {
    if (['DRIVER_ASSIGNED', 'DRIVER_EN_ROUTE', 'ARRIVED', 'IN_PROGRESS'].includes(ride.status)) {
      const wallet = walletFor(ride.riderId);
      const amount = Number(ride.agreedFareNgn ?? ride.fareEstimateNgn);
      if (wallet.balance < amount) {
        const topUp = Math.ceil(((amount - wallet.balance) * 1.4) / 1000) * 1000;
        txn(wallet, 'DEPOSIT', 'CREDIT', topUp, `seed-deposit-${uuid()}`, new Date(ride.createdAt.getTime() - 600_000), { seed: true, channel: 'virtual_account' });
      }
      wallet.balance = round2(wallet.balance - amount);
      wallet.locked = round2(wallet.locked + amount);
    }
  }

  return { wallets, transactions, withdrawals, reservations, platformWallet };
}

/* ──────────────────────────── persistence ──────────────────────────── */

async function main() {
  const { PrismaClient } = require('../node_modules/@prisma/client');
  const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  const dbLabel = DATABASE_URL.replace(/:\/\/[^@]*@/, '://***@');

  try {
    if (PURGE) {
      console.log(`\nPurging seeded data from ${dbLabel} …`);
      if (DRY_RUN) {
        const n = await prisma.user.count({ where: { privyDid: { startsWith: 'seed:' } } });
        console.log(`  would remove ${n} seeded users and everything attached to them`);
        console.log('  (re-run with --confirm to actually delete)\n');
        return;
      }
      const seeded = await prisma.user.findMany({
        where: { privyDid: { startsWith: 'seed:' } },
        select: { id: true },
      });
      const ids = seeded.map((u) => u.id);
      console.log(`  ${ids.length} seeded users found`);

      // One transaction: either every seeded row goes, or nothing does. A
      // foreign key nobody anticipated would otherwise abort the run halfway
      // and leave orphan rides and fee rows behind — fake metrics that survive
      // the purge and need a second script to untangle.
      const chunks = (arr, size = 1000) => {
        const out = [];
        for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
        return out;
      };
      await prisma.$transaction(
        async (tx) => {
          const walletIds = (
            await tx.wallet.findMany({ where: { userId: { in: ids } }, select: { id: true } })
          ).map((w) => w.id);
          const seededRideIds = (
            await tx.ride.findMany({ where: { riderId: { in: ids } }, select: { id: true } })
          ).map((r) => r.id);
          const driverIds = (
            await tx.driver.findMany({ where: { userId: { in: ids } }, select: { id: true } })
          ).map((d) => d.id);

          // Rows hanging directly off the user.
          await tx.safetyAlert.deleteMany({ where: { userId: { in: ids } } });
          await tx.userActivityEvent.deleteMany({ where: { userId: { in: ids } } });
          await tx.notification.deleteMany({ where: { userId: { in: ids } } });
          await tx.userConsent.deleteMany({ where: { userId: { in: ids } } });
          await tx.riderKycAttempt.deleteMany({ where: { userId: { in: ids } } });

          // Rows hanging off seeded rides. Demo drivers bid, chatted and drove
          // on them; GPS traces and disputes would block the ride delete. The
          // platform wallet's PLATFORM_FEE rows reference the ride id, not a
          // seeded wallet — leaving them would inflate revenue on the next seed.
          for (const chunk of chunks(seededRideIds)) {
            await tx.chatMessage.deleteMany({ where: { rideId: { in: chunk } } });
            await tx.driverBid.deleteMany({ where: { rideId: { in: chunk } } });
            await tx.gpsLog.deleteMany({ where: { rideId: { in: chunk } } });
            await tx.dispute.deleteMany({ where: { rideId: { in: chunk } } });
            await tx.rideStop.deleteMany({ where: { rideId: { in: chunk } } });
            await tx.transaction.deleteMany({ where: { referenceId: { in: chunk } } });
          }

          // Money rows.
          await tx.transaction.deleteMany({ where: { walletId: { in: walletIds } } });
          await tx.transaction.deleteMany({ where: { metadata: { path: ['seed'], equals: true } } });
          await tx.withdrawalRequest.deleteMany({ where: { userId: { in: ids } } });
          await tx.walletReservation.deleteMany({ where: { userId: { in: ids } } });
          await tx.rideHold.deleteMany({ where: { riderId: { in: ids } } });

          await tx.groupRideFaceVerification.deleteMany({ where: { userId: { in: ids } } });
          await tx.groupRideMatchRequest.deleteMany({ where: { userId: { in: ids } } });
          await tx.interstateBooking.deleteMany({ where: { userId: { in: ids } } });
          await tx.ride.deleteMany({ where: { riderId: { in: ids } } });

          // A seeded driver may have bid on, or been assigned to, a REAL
          // rider's ride. Those rides stay; they just lose the fake driver.
          await tx.driverBid.deleteMany({ where: { driverId: { in: driverIds } } });
          await tx.ride.updateMany({
            where: { driverId: { in: driverIds } },
            data: { driverId: null },
          });
          await tx.driverKycReview.deleteMany({ where: { driverId: { in: driverIds } } });
          await tx.driverKycSubmission.deleteMany({ where: { driverId: { in: driverIds } } });
          await tx.interstateDeparture.updateMany({
            where: { driverId: { in: driverIds } },
            data: { driverId: null },
          });
          await tx.driver.deleteMany({ where: { userId: { in: ids } } });

          await tx.virtualAccount.deleteMany({ where: { userId: { in: ids } } });
          await tx.wallet.deleteMany({ where: { userId: { in: ids } } });
          await tx.user.deleteMany({ where: { id: { in: ids } } });
        },
        { timeout: 30 * 60_000, maxWait: 60_000 },
      );

      // The platform wallet survives, so its balance has to come back down by
      // the fees that just went away. It only ever moves by transaction, so
      // recomputing from what is left is exact — no arithmetic to get wrong.
      const platformWallet = await prisma.wallet.findUnique({
        where: { userId: '00000000-0000-0000-0000-000000000001' },
      });
      if (platformWallet) {
        const [credits, debits] = await Promise.all([
          prisma.transaction.aggregate({
            where: { walletId: platformWallet.id, direction: 'CREDIT' },
            _sum: { amountNgn: true },
          }),
          prisma.transaction.aggregate({
            where: { walletId: platformWallet.id, direction: 'DEBIT' },
            _sum: { amountNgn: true },
          }),
        ]);
        const balance = round2(
          Number(credits._sum.amountNgn ?? 0) - Number(debits._sum.amountNgn ?? 0),
        );
        await prisma.wallet.update({
          where: { id: platformWallet.id },
          data: { balanceNgn: Math.max(0, balance) },
        });
        console.log(`  platform wallet rebalanced to ₦${Math.round(balance).toLocaleString('en-NG')}`);
      }

      console.log('  done — seeded data removed\n');
      return;
    }

    // Refuse to layer a second seed on top of an existing one. Dropping the
    // database does not work while something still holds a connection, and a
    // silent partial insert is far worse than stopping here. Skipped on a dry
    // run, which is documented as touching nothing at all.
    if (!DRY_RUN) {
      const alreadySeeded = await prisma.user.count({ where: { privyDid: { startsWith: 'seed:' } } });
      if (alreadySeeded > 0) {
        console.error(
          `\n  ${alreadySeeded} seeded users are already in this database.\n` +
          '  Remove them first:  node scripts/seed-demo.mjs --purge --confirm\n',
        );
        process.exitCode = 1;
        return;
      }
    }

    console.log('\nGenerating …');
    const data = generateCalibrated();
    const ledger = buildLedger(data);

    const completed = data.rides.filter((r) => r.status === 'COMPLETED');
    const gross = completed.reduce((sum, r) => sum + Number(r.fareFinalNgn), 0);
    const platformRevenue = completed.reduce((sum, r) => sum + Number(r.platformFeeNgn), 0);
    const driverPayouts = round2(gross - platformRevenue);
    const cancelled = data.rides.filter((r) => r.status === 'CANCELLED');
    const noDriver = cancelled.filter((r) => r.cancelReason === NO_DRIVER_REASON);
    const deposits = ledger.transactions.filter((t) => t.type === 'DEPOSIT');
    const withdrawalsSettled = ledger.withdrawals.filter((w) => w.status === 'SETTLED');
    const ngn = (n) => `₦${Math.round(n).toLocaleString('en-NG')}`;

    console.log(`\n  Period            ${START.toISOString().slice(0, 10)} → ${data.now.toISOString().slice(0, 10)}  (${DAYS} days)`);
    console.log(`  Users             ${data.users.length}  (${data.riders.length} riders, ${data.drivers.length} drivers)`);
    console.log(`  KYC queue         ${data.kycSubmissions.filter((k) => k.status === 'SUBMITTED').length} awaiting review`);
    console.log(`  Group rides       ${data.groupRequests.length} requests · ${data.groupRequests.filter((g) => g.status === 'BOOKED').length} booked · ${data.groupRequests.filter((g) => g.status === 'PENDING_FACE_UPLOAD').length} stuck on the selfie`);
    console.log(`  Rides attempted   ${data.rides.length}`);
    console.log(`    completed       ${completed.length}  (${((completed.length / data.rides.length) * 100).toFixed(1)}%)`);
    console.log(`    cancelled       ${cancelled.length}  — of which ${noDriver.length} never found a driver`);
    console.log(`    disputed        ${data.rides.filter((r) => r.status === 'DISPUTED').length}`);
    console.log(`    in flight now   ${data.rides.filter((r) => !['COMPLETED', 'CANCELLED', 'DISPUTED'].includes(r.status)).length}`);
    console.log(`  Gross processed   ${ngn(gross)}   (target ${ngn(TARGET_NGN)})`);
    console.log(`  Platform revenue  ${ngn(platformRevenue)}  (VAT + levy + service fee)`);
    console.log(`  Driver payouts    ${ngn(driverPayouts)}`);
    console.log(`  Avg fare          ${ngn(gross / Math.max(1, completed.length))}`);
    console.log(`  Avg rides/day     ${(completed.length / DAYS).toFixed(1)} completed, ${(data.rides.length / DAYS).toFixed(1)} attempted`);
    console.log(`  Ledger            ${ledger.transactions.length} transactions, ${deposits.length} deposits (${ngn(deposits.reduce((s, t) => s + t.amountNgn, 0))}), ${withdrawalsSettled.length} settled withdrawals (${ngn(withdrawalsSettled.reduce((s, w) => s + w.requestedAmountNgn, 0))})`);

    if (DRY_RUN) {
      console.log(`\n  DRY RUN — nothing was written to ${dbLabel}`);
      console.log('  Re-run with --confirm to insert.\n');
      return;
    }

    console.log(`\nWriting to ${dbLabel} …`);
    const chunk = (arr, size) => {
      const out = [];
      for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
      return out;
    };
    const write = async (label, rows, fn, size = 500) => {
      let done = 0;
      for (const batch of chunk(rows, size)) {
        await fn(batch);
        done += batch.length;
        process.stdout.write(`\r  ${label}: ${done}/${rows.length}   `);
      }
      process.stdout.write(`\r  ${label}: ${rows.length} ✓            \n`);
    };

    // Platform user must exist before its wallet.
    await prisma.user.upsert({
      where: { id: '00000000-0000-0000-0000-000000000001' },
      create: { id: '00000000-0000-0000-0000-000000000001', privyDid: 'platform:wheelers', role: 'RIDER', name: 'Wheelers Platform' },
      update: {},
    });

    // The platform wallet outlives a purge — it can hold real fee income, so
    // it is never deleted. `createMany` would then skip it, stranding every
    // PLATFORM_FEE row against a wallet id that was never inserted. Point the
    // ledger at the wallet that already exists instead, and add the seeded
    // fees to its balance rather than overwriting what is there.
    const existingPlatformWallet = await prisma.wallet.findUnique({
      where: { userId: '00000000-0000-0000-0000-000000000001' },
    });
    if (existingPlatformWallet) {
      const generatedId = ledger.platformWallet.id;
      const openingNgn = Number(existingPlatformWallet.balanceNgn);
      ledger.platformWallet.id = existingPlatformWallet.id;
      for (const t of ledger.transactions) {
        if (t.walletId !== generatedId) continue;
        t.walletId = existingPlatformWallet.id;
        // The ledger counted up from zero; this wallet did not start there.
        t.balanceAfterNgn = round2(t.balanceAfterNgn + openingNgn);
      }
    }

    await write('users', data.users, (batch) =>
      prisma.user.createMany({
        skipDuplicates: true,
        data: batch.map((u) => ({
          id: u.id,
          privyDid: u.privyDid,
          username: u.username ?? null,
          role: u.role,
          name: u.name,
          phone: u.phone,
          email: u.email,
          riderKycStatus: u.riderKycStatus,
          kycVerifiedAt: u.riderKycStatus === 'VERIFIED' ? u.createdAt : null,
          createdAt: u.createdAt,
          updatedAt: u.createdAt,
        })),
      }),
    );

    const insertedUsers = await prisma.user.count({ where: { privyDid: { startsWith: 'seed:' } } });
    if (insertedUsers !== data.users.length) {
      throw new Error(
        `only ${insertedUsers}/${data.users.length} users inserted — a unique field collided. ` +
        'Re-run with a different --seed, or purge first.',
      );
    }

    await write('drivers', data.drivers, (batch) =>
      prisma.driver.createMany({
        skipDuplicates: true,
        data: batch.map((d) => ({
          id: d.id,
          userId: d.userId,
          status: d.status,
          kycStatus: d.kycStatus,
          lat: d.lat,
          lng: d.lng,
          lastSeenAt: d.lastSeenAt,
          vehicleMake: d.vehicleMake,
          vehicleModel: d.vehicleModel,
          vehiclePlate: d.vehiclePlate,
          vehicleYear: d.vehicleYear,
          rating: d.rating,
          totalRides: d.totalRides,
          totalEarningsNgn: d.totalEarningsNgn,
        })),
      }),
    );

    await write('kyc submissions', data.kycSubmissions, (batch) =>
      prisma.driverKycSubmission.createMany({
        skipDuplicates: true,
        data: batch.map((k) => ({
          id: k.id,
          driverId: k.driverId,
          status: k.status,
          vehicleMake: k.vehicleMake,
          vehicleModel: k.vehicleModel,
          vehiclePlate: k.vehiclePlate,
          vehicleYear: k.vehicleYear,
          submittedAt: k.submittedAt,
          reviewedAt: k.reviewedAt,
          rejectionReason: k.rejectionReason,
          createdAt: k.createdAt,
          updatedAt: k.reviewedAt ?? k.submittedAt,
        })),
      }),
    );

    const walletRows = [...ledger.wallets.values()];
    await write('wallets', walletRows, (batch) =>
      prisma.wallet.createMany({
        skipDuplicates: true,
        data: batch.map((w) => ({
          id: w.id,
          userId: w.userId,
          balanceNgn: Math.max(0, w.balance),
          lockedNgn: Math.max(0, w.locked),
        })),
      }),
    );

    // Skipped by `skipDuplicates` above — credit the seeded fees explicitly.
    if (existingPlatformWallet) {
      await prisma.wallet.update({
        where: { id: existingPlatformWallet.id },
        data: { balanceNgn: { increment: Math.max(0, ledger.platformWallet.balance) } },
      });
    }

    await write('rides', data.rides, (batch) =>
      prisma.ride.createMany({
        skipDuplicates: true,
        data: batch.map((r) => ({
          id: r.id,
          riderId: r.riderId,
          driverId: r.driverId ?? null,
          status: r.status,
          paymentMethod: r.paymentMethod,
          pickupLat: r.pickupLat,
          pickupLng: r.pickupLng,
          pickupAddress: r.pickupAddress,
          destLat: r.destLat,
          destLng: r.destLng,
          destAddress: r.destAddress,
          fareEstimateNgn: r.fareEstimateNgn ?? null,
          riderOfferNgn: r.riderOfferNgn ?? null,
          agreedFareNgn: r.agreedFareNgn ?? null,
          fareFinalNgn: r.fareFinalNgn ?? null,
          platformFeeNgn: r.platformFeeNgn ?? null,
          distanceKm: r.distanceKm ?? null,
          durationSeconds: r.durationSeconds ?? null,
          cancelStage: r.cancelStage ?? null,
          cancelReason: r.cancelReason ?? null,
          matchedAt: r.matchedAt ?? null,
          arrivedAt: r.arrivedAt ?? null,
          startedAt: r.startedAt ?? null,
          completedAt: r.completedAt ?? null,
          cancelledAt: r.cancelledAt ?? null,
          createdAt: r.createdAt,
          updatedAt: r.completedAt ?? r.cancelledAt ?? r.createdAt,
        })),
      }),
    );

    await write('ride holds', data.holds, (batch) =>
      prisma.rideHold.createMany({
        skipDuplicates: true,
        data: batch.map((h) => ({
          id: uuid(),
          rideId: h.rideId,
          walletId: ledger.wallets.get(h.riderId).id,
          riderId: h.riderId,
          driverUserId: h.driverUserId ?? null,
          amountNgn: h.amountNgn,
          status: h.status,
          settledAmountNgn: h.settledAmountNgn ?? null,
          settledAt: h.settledAt ?? null,
          createdAt: h.createdAt,
          updatedAt: h.settledAt ?? h.createdAt,
        })),
      }),
    );

    await write('group ride requests', data.groupRequests, (batch) =>
      prisma.groupRideMatchRequest.createMany({
        skipDuplicates: true,
        data: batch.map((g) => ({
          id: g.id,
          userId: g.userId,
          status: g.status,
          groupId: g.groupId,
          matchedRideIds: g.matchedRideIds ?? undefined,
          pickupLat: g.pickupLat,
          pickupLng: g.pickupLng,
          pickupAddress: g.pickupAddress,
          destLat: g.destLat,
          destLng: g.destLng,
          destAddress: g.destAddress,
          genderPreference: g.genderPreference,
          plannedDistanceKm: g.plannedDistanceKm,
          plannedDurationSeconds: g.plannedDurationSeconds,
          fareEstimateNgn: g.fareEstimateNgn,
          readyForMatchAt: g.readyForMatchAt,
          matchingStartedAt: g.matchingStartedAt,
          groupedAt: g.groupedAt,
          bookedAt: g.bookedAt,
          expiredAt: g.expiredAt,
          cancelledAt: g.cancelledAt,
          cancelReason: g.cancelReason,
          createdAt: g.createdAt,
          updatedAt: g.bookedAt ?? g.groupedAt ?? g.cancelledAt ?? g.expiredAt ?? g.createdAt,
        })),
      }),
    );

    await write('face verifications', data.faceVerifications, (batch) =>
      prisma.groupRideFaceVerification.createMany({
        skipDuplicates: true,
        data: batch.map((f) => ({
          id: f.id,
          matchRequestId: f.matchRequestId,
          userId: f.userId,
          bucket: f.bucket,
          objectKey: f.objectKey,
          mimeType: f.mimeType,
          sizeBytes: f.sizeBytes,
          uploadStatus: f.uploadStatus,
          capturedAt: f.capturedAt,
          storedAt: f.storedAt,
          failedAt: f.failedAt,
          failureReason: f.failureReason,
          createdAt: f.createdAt,
          updatedAt: f.storedAt ?? f.failedAt ?? f.createdAt,
        })),
      }),
    );

    await write('transactions', ledger.transactions, (batch) =>
      prisma.transaction.createMany({
        skipDuplicates: true,
        data: batch.map((t) => ({
          id: t.id,
          walletId: t.walletId,
          type: t.type,
          direction: t.direction,
          amountNgn: t.amountNgn,
          balanceAfterNgn: t.balanceAfterNgn,
          referenceId: t.referenceId,
          metadata: t.metadata ?? undefined,
          createdAt: t.createdAt,
        })),
      }),
    );

    await write('reservations', ledger.reservations, (batch) =>
      prisma.walletReservation.createMany({
        skipDuplicates: true,
        data: batch.map((r) => ({
          id: r.id,
          walletId: r.walletId,
          userId: r.userId,
          kind: r.kind,
          status: r.status,
          amountNgn: r.amountNgn,
          referenceId: r.referenceId,
          createdAt: r.createdAt,
          updatedAt: r.createdAt,
          consumedAt: r.consumedAt,
          releasedAt: r.releasedAt,
        })),
      }),
    );

    await write('withdrawals', ledger.withdrawals, (batch) =>
      prisma.withdrawalRequest.createMany({
        skipDuplicates: true,
        data: batch.map((w) => ({
          id: w.id,
          userId: w.userId,
          walletId: w.walletId,
          reservationId: w.reservationId,
          status: w.status,
          requestedAmountNgn: w.requestedAmountNgn,
          reservedAmountNgn: w.reservedAmountNgn,
          bankAccountNumber: w.bankAccountNumber,
          bankAccountName: w.bankAccountName,
          bankNetworkId: w.bankNetworkId,
          failureReason: w.failureReason,
          createdAt: w.createdAt,
          updatedAt: w.settledAt ?? w.failedAt ?? w.createdAt,
          settledAt: w.settledAt,
          failedAt: w.failedAt,
        })),
      }),
    );

    console.log('\n  Seed complete.\n');
    console.log('  To remove it later:  node scripts/seed-demo.mjs --purge --confirm\n');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error('\nSeed failed:', error);
  process.exit(1);
});
