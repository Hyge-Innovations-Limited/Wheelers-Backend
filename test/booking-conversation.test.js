// A WhatsApp booking, replayed message by message through the real route.
//
// The conversation that prompted this file: a rider in Akoka typed "No 7 osaro
// isokpan", was quoted ₦97,100 for a 311 km trip to Benin City, resent the
// address with "Lagos" on the end, then typed "Book a ride", then "Cancel first
// order" — and got "Please send a price for your ride" every single time.
//
// Google, Groq and Meta are stubbed at fetch(); everything between — stages,
// Redis state, geocoding recovery, re-planning, the replies — is production code.
//
//   DATABASE_URL=… node --test --test-force-exit test/booking-conversation.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { PrismaClient } = require('@prisma/client');

const { handleMetaWhatsappWebhookRoute, placeChoiceRows, createRidePageChatNotifier, createWhatsappDepositFinisher, createOffersFormChatHooks } = require('../apps/api-gateway/dist/http/whatsapp.route.js');
const bidState = require('../apps/api-gateway/dist/whatsapp-flows/bid-state.js');
const { classifyBookingIntent, mightNotBeAnAddress, sharedPlaceWords } = require('../apps/api-gateway/dist/LLM/booking-intent.js');
const { geocodeAddress, geocodeAddressCandidates, kmBetween, resetPlacesAvailability } = require('../apps/api-gateway/dist/LLM/geocoding.js');

// The "model" in this file is a stub behind Groq's URL. A GEMINI_API_KEY in the
// developer's shell would send these calls to a provider the stub does not play.
delete process.env.GEMINI_API_KEY;

const prisma = new PrismaClient();
const realFetch = global.fetch;
const realConsole = { log: console.log, info: console.info, warn: console.warn, error: console.error };

const AKOKA = { lat: 6.5244, lng: 3.3870, address: '31 Emily Akinola St, Akoka, Lagos 100001, Lagos, Nigeria' };
const BENIN = { lat: 6.3350, lng: 5.6037, address: 'Isokpan St, Use, Benin City 300103, Edo, Nigeria' };
const YABA = { lat: 6.5095, lng: 3.3711, address: '7 Osaro Isokpan St, Yaba, Lagos 101245, Lagos, Nigeria' };

/* ── the outside world ─────────────────────────────────────────────────── */

function geocodeResult(place, extra = {}) {
  return {
    formatted_address: place.address,
    geometry: { location: { lat: place.lat, lng: place.lng } },
    types: ['street_address'],
    address_components: [{ short_name: 'NG', types: ['country'] }],
    ...extra,
  };
}

/**
 * world.geocode(query, params) → place | null      Google's street geocoder
 * world.places(query, locationbias) → place | null  Google Places
 * world.intent(message) → {intent,address}|'down'   the language model
 */
function installWorld(world) {
  const sent = [];
  const placeById = new Map();
  const calls = { geocode: [], places: [], groq: 0 };
  global.fetch = async (url, init) => {
    const href = String(url);
    if (href.includes('graph.facebook.com')) {
      const body = JSON.parse(init.body);
      if (world.refuseLists && body.interactive?.type === 'list') {
        return { ok: false, status: 400, json: async () => ({}), text: async () => 'list rejected' };
      }
      if (body.type === 'text' || body.type === 'interactive') sent.push(body);
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
    }
    if (href.includes('/maps/api/geocode/')) {
      const params = new URL(href).searchParams;
      calls.geocode.push({ address: params.get('address'), bounds: params.get('bounds') });
      const found = world.geocode(params.get('address'), params);
      const places = Array.isArray(found) ? found : found ? [found] : [];
      return { ok: true, json: async () => (places.length ? { status: 'OK', results: places.map((place) => geocodeResult(place)) } : { status: 'ZERO_RESULTS', results: [] }) };
    }
    if (href.includes('places.googleapis.com') && init?.method !== 'POST') {
      // "Where is this suggestion?" — the location-only lookup after autocomplete.
      const place = placeById.get(decodeURIComponent(new URL(href).pathname.split('/').pop()));
      return { ok: Boolean(place), status: place ? 200 : 404, json: async () => (place ? { location: { latitude: place.lat, longitude: place.lng } } : {}) };
    }
    if (href.includes('places:autocomplete')) {
      const asked = JSON.parse(init.body);
      const circle = asked.locationBias?.circle;
      const bias = circle ? `circle:${circle.radius}@${circle.center.latitude},${circle.center.longitude}` : 'rectangle';
      calls.places.push({ input: asked.input, bias });
      if (world.placesOff) return { ok: false, status: 403, json: async () => ({ error: { status: 'PERMISSION_DENIED', message: 'not enabled' } }) };
      const found = world.places?.(asked.input, bias) ?? null;
      const list = Array.isArray(found) ? found : found ? [found] : [];
      return {
        ok: true, status: 200,
        json: async () => ({ suggestions: list.map((place) => {
          const id = `pid_${placeById.size}`;
          placeById.set(id, place);
          const name = place.name ?? place.address.split(',')[0];
          const where = place.name ? place.address : place.address.split(',').slice(1).join(',').trim();
          return { placePrediction: { placeId: id, structuredFormat: { mainText: { text: name }, secondaryText: { text: `${where}, Nigeria` } }, types: ['point_of_interest', 'establishment'] } };
        }) }),
      };
    }
    if (href.includes('places.googleapis.com')) {
      // Whole-name text search: only the "spots in an area" question uses it in these worlds.
      const asked = JSON.parse(init.body);
      if (world.spots) {
        const spots = world.spots(asked.textQuery) ?? [];
        return { ok: true, status: 200, json: async () => ({ places: spots.map((place) => ({ displayName: { text: place.name }, formattedAddress: `${place.address}, Nigeria`, shortFormattedAddress: place.address, location: { latitude: place.lat, longitude: place.lng }, types: ['bus_station'] })) }) };
      }
      if (!world.textSearch) return { ok: true, status: 200, json: async () => ({ places: [] }) };
      const circle = asked.locationBias?.circle;
      const bias = circle ? `circle:${circle.radius}@${circle.center.latitude},${circle.center.longitude}` : 'rectangle';
      calls.places.push({ input: asked.textQuery, bias });
      if (world.placesOff) return { ok: false, status: 403, json: async () => ({ error: { status: 'PERMISSION_DENIED', message: 'not enabled' } }) };
      const found = world.places?.(asked.textQuery, bias) ?? null;
      const list = Array.isArray(found) ? found : found ? [found] : [];
      return {
        ok: true, status: 200,
        json: async () => ({ places: list.map((place) => ({
          displayName: place.name ? { text: place.name } : undefined,
          formattedAddress: `${place.address}${/nigeria$/i.test(place.address) ? '' : ', Nigeria'}`,
          shortFormattedAddress: place.address.replace(/,\s*Nigeria$/i, ''),
          location: { latitude: place.lat, longitude: place.lng },
          types: ['point_of_interest'],
        })) }),
      };
    }
    if (href.includes('api.groq.com')) {
      calls.groq += 1;
      const messages = JSON.parse(init.body).messages;
      const answer = world.intent(messages.at(-1).content, messages[0].content);
      if (answer === 'down') return { ok: false, status: 503, json: async () => ({ error: { message: 'model unavailable' } }) };
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(answer) } }] }) };
    }
    throw new Error(`unexpected fetch in test: ${href}`);
  };
  return { sent, calls };
}

function memoryRedis() {
  const store = new Map();
  return {
    store,
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async set(k, v) { store.set(k, v); },
    async del(k) { store.delete(k); },
    async setIfNotExists(k, v) { if (store.has(k)) return false; store.set(k, v); return true; },
    async send() { return null; },
  };
}

function makeDeps(redisClient) {
  const published = [];
  const providerCalls = [];
  return {
    published,
    providerCalls,
    deps: {
      jwtSecret: 'test-secret-that-is-at-least-32-characters-long',
      publisher: new Proxy({}, { get: (_t, name) => async (event) => { published.push({ via: String(name), event }); } }),
      paymentsClient: {
        createCustomer: async (input) => { providerCalls.push(input); return { id: `cus_${Math.random().toString(36).slice(2, 12)}` }; },
        findCustomerByReference: async () => null,
        updateCustomer: async () => ({}),
        createVirtualAccount: async () => ({ id: `va_${Math.random().toString(36).slice(2, 12)}`, bank_name: 'Test Bank', account_number: String(Math.floor(1e9 + Math.random() * 9e9)), account_name: 'Test', currency: 'NGN', country: 'NG' }),
      },
      redisClient,
      // ₦300/km, so a wrong-city quote is unmistakable in the reply.
      routePlanner: {
        planRoute: async ({ origin, destination, stops = [] }) => {
          const points = [origin, ...stops, destination];
          const distanceKm = points.slice(1).reduce((sum, point, index) => sum + kmBetween(points[index], point), 0) * 1.3;
          const suggested = Math.round(distanceKm * 300 / 100) * 100 + 500;
          return { distanceKm, durationSeconds: Math.round(distanceKm * 150), suggestedFareNgn: suggested, minOfferNgn: Math.round(suggested * 0.8), ratePerKmNgn: 300, geometry: undefined };
        },
      },
      googleMapsApiKey: 'test-key',
      metaAccessToken: 'meta-token',
      metaPhoneNumberId: '1234567890',
      groqApiKey: 'groq-key',
      groqModel: 'openai/gpt-oss-120b',
      groqTimeoutMs: 4000,
    },
  };
}

let messageCounter = 0;
function rider() {
  const phone = `23480${String(Date.now()).slice(-5)}${String(Math.floor(Math.random() * 900) + 100)}`;
  return { phone, name: 'Test Rider' };
}

async function say(deps, who, text) {
  messageCounter += 1;
  const payload = {
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ value: {
      contacts: [{ profile: { name: who.name }, wa_id: who.phone }],
      messages: [{ id: `wamid.test.${Date.now()}.${messageCounter}`, from: who.phone, type: 'text', text: { body: text } }],
    } }] }],
  };
  const raw = Buffer.from(JSON.stringify(payload));
  const req = { method: 'POST', headers: {}, async *[Symbol.asyncIterator]() { yield raw; } };
  const res = { statusCode: 0, setHeader() {}, writeHead() { return this; }, end() {} };
  await handleMetaWhatsappWebhookRoute(req, res, deps);
}

/** Tap a row in WhatsApp's list picker. The title is what WhatsApp shows — cut short. */
async function tap(deps, who, rowId, title) {
  messageCounter += 1;
  const payload = {
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ value: {
      contacts: [{ profile: { name: who.name }, wa_id: who.phone }],
      messages: [{ id: `wamid.tap.${Date.now()}.${messageCounter}`, from: who.phone, type: 'interactive', interactive: { type: 'list_reply', list_reply: { id: rowId, title } } }],
    } }] }],
  };
  const raw = Buffer.from(JSON.stringify(payload));
  const req = { method: 'POST', headers: {}, async *[Symbol.asyncIterator]() { yield raw; } };
  const res = { statusCode: 0, setHeader() {}, writeHead() { return this; }, end() {} };
  await handleMetaWhatsappWebhookRoute(req, res, deps);
}

/** Put a rider exactly where the screenshots start: pickup set, destination asked for. */
async function riderWithPickup(deps, redis, who) {
  await say(deps, who, 'hi'); // onboards them (and meets the privacy question)
  const found = await prisma.user.findFirstOrThrow({ where: { phone: { contains: who.phone.slice(-10) } } });
  const user = await agree(redis, found);
  await bidState.setPendingLocation(redis, user.id, { ...AKOKA, savedAt: new Date().toISOString() });
  await bidState.setBookingStage(redis, user.id, 'awaiting_destination');
  return user;
}

/** Skip the privacy question: this rider accepted it some other day. */
async function agree(redis, user) {
  await redis.del(`whatsapp:user:${user.id}:pre_consent_message`);
  return prisma.user.update({ where: { id: user.id }, data: { privacyConsent: 'AGREED', privacyConsentAt: new Date() } });
}
const findRider = (who) => prisma.user.findFirstOrThrow({ where: { phone: { contains: who.phone.slice(-10) } } });

const textOf = (message) => message?.text?.body ?? message?.interactive?.body?.text ?? '';
const last = (sent) => sent.at(-1);

test.beforeEach(() => { if (!process.env.LOUD) console.log = console.info = console.warn = console.error = () => {}; resetPlacesAvailability(); });
test.afterEach(() => { Object.assign(console, realConsole); global.fetch = realFetch; });
// Searches this file left open would sit in the admin dispatch queue (the 50 OLDEST unmatched rides)
// for a day and crowd another file's ride out of it. Close them.
const startedAt = new Date();
test.after(async () => {
  await prisma.ride.updateMany({ where: { status: { in: ['REQUESTED', 'MATCHING'] }, createdAt: { gte: startedAt } }, data: { status: 'CANCELLED' } }).catch(() => {});
  await prisma.$disconnect();
});

/* ── privacy consent comes first ───────────────────────────────────────── */

const rideRequestModel = (_message, system) => (/part-way through booking/.test(system)
  ? { intent: 'other' }
  : {
      intent: 'ride_request',
      pickup: { address: '31 Emily Akinola, Akoka', area: 'Akoka', specific: true },
      destination: { address: '7 Osaro Isokpan, Yaba', area: 'Yaba', specific: true },
      offerNgn: null, paymentMethod: null, outsideNigeria: false,
    });

test('a first message meets the privacy question — and nothing reaches the payment provider before the answer', async () => {
  const redis = memoryRedis();
  const { deps, providerCalls } = makeDeps(redis);
  const { sent } = installWorld({ geocode: (q) => (/emily|akoka/i.test(q) ? AKOKA : YABA), places: () => null, intent: rideRequestModel });
  const who = rider();

  await say(deps, who, 'take me from 31 emily akinola akoka to 7 osaro isokpan yaba');
  const question = last(sent);
  assert.equal(question.type, 'interactive');
  assert.deepEqual(question.interactive.action.buttons.map((b) => b.reply.title), ['Continue', 'Not now']);
  assert.match(textOf(question), /https:\/\/wheelersng\.com\/privacy/);
  assert.doesNotMatch(textOf(question), /Suggested fare/, 'no booking before consent');

  const before = await findRider(who);
  assert.equal(before.privacyConsent, 'PENDING');
  assert.equal(before.privacyConsentAt, null);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(providerCalls.length, 0, 'their name and phone have gone nowhere');

  // Continue = agree. The trip they asked for is answered without asking again.
  await say(deps, who, 'Continue');
  const after = await findRider(who);
  assert.equal(after.privacyConsent, 'AGREED');
  assert.ok(after.privacyConsentAt);
  assert.match(textOf(last(sent)), /Destination: \*7 Osaro Isokpan St, Yaba/, 'their first message was not thrown away');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(providerCalls.length, 1, 'the deposit account is opened only now');

  // And never asked again.
  const count = sent.length;
  await say(deps, who, '2,000');
  assert.ok(sent.slice(count).every((m) => !/privacy/.test(textOf(m))));
});

test('"Not now" means not agreed: recorded, nothing set up, and the door stays open', async () => {
  const redis = memoryRedis();
  const { deps, providerCalls } = makeDeps(redis);
  const { sent } = installWorld({ geocode: () => YABA, places: () => null, intent: rideRequestModel });
  const who = rider();

  await say(deps, who, 'hello');
  await say(deps, who, 'Not now');
  const declined = await findRider(who);
  assert.equal(declined.privacyConsent, 'DECLINED');
  assert.ok(declined.privacyConsentAt);
  assert.match(textOf(last(sent)), /nothing has been set up/);
  assert.equal(providerCalls.length, 0);

  // Any later message offers the choice again — it does not start booking.
  await say(deps, who, 'i need a ride');
  assert.equal(last(sent).type, 'interactive');
  assert.match(textOf(last(sent)), /Welcome back/);

  await say(deps, who, 'Continue');
  assert.equal((await findRider(who)).privacyConsent, 'AGREED');
});

test('FREEZE never waits for a privacy form', async () => {
  const redis = memoryRedis();
  const { deps } = makeDeps(redis);
  const { sent } = installWorld({ geocode: () => YABA, places: () => null, intent: () => ({ intent: 'other' }) });
  const who = rider();

  await say(deps, who, 'FREEZE');
  assert.match(textOf(last(sent)), /Withdrawals are now locked/);
  const user = await findRider(who);
  assert.ok(user.withdrawalsFrozenUntil > new Date());
  assert.equal(user.privacyConsent, 'PENDING');
});

/* ── one name, several places: a tap, not a typed number ───────────────── */

const ADMIRALTY_WAY = { lat: 6.4474, lng: 3.4723, address: 'Admiralty Way, Lekki, Nigeria' };
const ADMIRALTY_ROAD = { lat: 6.4391, lng: 3.4586, address: 'Admiralty Road, Lekki, Nigeria' };
const LEKKI_PICKUP = { lat: 6.4500, lng: 3.4700, address: 'Lekki Phase 1 Gate, Lekki, Lagos, Nigeria' };
const admiraltyWorld = (extra = {}) => ({
  geocode: (query) => (/admiralty/i.test(query) ? [ADMIRALTY_WAY, ADMIRALTY_ROAD] : YABA),
  places: () => null,
  intent: () => ({ intent: 'other' }),
  ...extra,
});

async function riderInLekki(deps, redis, who) {
  const user = await riderWithPickup(deps, redis, who);
  await bidState.setPendingLocation(redis, user.id, { ...LEKKI_PICKUP, savedAt: new Date().toISOString() });
  return user;
}

test('the labels fit WhatsApp\'s limits and lead with what differs', () => {
  // The screenshot: "Admiralty Way, Lekki, Nigeria" was cut to "Admiralty Way, Lekki, Ni".
  const rows = placeChoiceRows([ADMIRALTY_WAY.address, ADMIRALTY_ROAD.address]);
  assert.deepEqual(rows.map((r) => r.title), ['Admiralty Way', 'Admiralty Road']);
  assert.deepEqual(rows.map((r) => r.description), ['Admiralty Way, Lekki', 'Admiralty Road, Lekki']);
  assert.deepEqual(rows.map((r) => r.id), ['place_choice_1', 'place_choice_2']);

  // Same street name in two districts: the DISTRICT is what tells them apart.
  const same = placeChoiceRows(['Aiyetoro Street, Surulere, Lagos 101241, Lagos, Nigeria', 'Aiyetoro Street, Akoka, Lagos 100001, Lagos, Nigeria']);
  assert.deepEqual(same.map((r) => r.title), ['Surulere', 'Akoka']);
  assert.match(same[0].description, /^Aiyetoro Street, Surulere/);

  // Nothing ever exceeds the limits, and twins are numbered rather than identical.
  const long = placeChoiceRows([
    'The Very Long Named International Conference Centre Annex, Victoria Island, Lagos, Nigeria',
    'Shoprite, Ikeja, Lagos, Nigeria', 'Shoprite, Ikeja, Lagos, Nigeria',
  ]);
  for (const row of long) { assert.ok(row.title.length <= 24, row.title); assert.ok(row.description.length <= 72, row.description); }
  assert.equal(new Set(long.map((r) => r.title)).size, 3);
});

test('SCREENSHOT — two places called Admiralty: one message with a Choose button, and a tap picks it', async () => {
  const redis = memoryRedis();
  const { deps } = makeDeps(redis);
  const { sent } = installWorld(admiraltyWorld());
  const who = rider();
  const user = await riderInLekki(deps, redis, who);

  const before = sent.length;
  await say(deps, who, 'admiralty');
  assert.equal(sent.length - before, 1, 'one message, not a wall of text');
  const picker = last(sent);
  assert.equal(picker.interactive.type, 'list');
  assert.equal(picker.interactive.action.button, 'Choose');
  assert.match(textOf(picker), /I found 2 places matching "admiralty"/);
  assert.doesNotMatch(textOf(picker), /Reply with the number/);
  const rows = picker.interactive.action.sections[0].rows;
  assert.deepEqual(rows.map((r) => r.title), ['Admiralty Way', 'Admiralty Road', 'None of these']);

  // WhatsApp hands back the row's id. The title is only what was on screen.
  await tap(deps, who, 'place_choice_2', 'Admiralty Road');
  assert.match(textOf(last(sent)), /Destination: \*Admiralty Road, Lekki, Nigeria\*/);
  assert.equal(await bidState.getBookingStage(redis, user.id), 'awaiting_trip_confirm');
  assert.equal(await bidState.getPendingGeoChoices(redis, user.id), null, 'the question is closed');
});

test('typing the number still works, and "None of these" asks again instead of guessing', async () => {
  const redis = memoryRedis();
  const { deps } = makeDeps(redis);
  const { sent } = installWorld(admiraltyWorld());
  const who = rider();
  const user = await riderInLekki(deps, redis, who);

  await say(deps, who, 'admiralty');
  await tap(deps, who, 'place_choice_none', 'None of these');
  assert.match(textOf(last(sent)), /Type the destination again with the area or a nearby landmark/);
  assert.equal(await bidState.getPendingGeoChoices(redis, user.id), null);
  assert.equal(await bidState.getBookingStage(redis, user.id), 'awaiting_destination', 'still on the destination step');

  await say(deps, who, 'admiralty');
  await say(deps, who, '1');
  assert.match(textOf(last(sent)), /Destination: \*Admiralty Way, Lekki, Nigeria\*/);
});

test('the pickup gets the same picker', async () => {
  const redis = memoryRedis();
  const { deps } = makeDeps(redis);
  const { sent } = installWorld(admiraltyWorld());
  const who = rider();
  await say(deps, who, 'hi');
  const user = await agree(redis, await findRider(who));
  await bidState.setBookingStage(redis, user.id, 'awaiting_pickup');

  await say(deps, who, 'admiralty');
  assert.equal(last(sent).interactive.type, 'list');
  assert.match(textOf(last(sent)), /pick the right pickup/);

  await tap(deps, who, 'place_choice_1', 'Admiralty Way');
  assert.match(textOf(last(sent)), /Pickup: \*Admiralty Way, Lekki, Nigeria\*/);
  assert.match(textOf(last(sent)), /Where are you going\?/);
  assert.equal(await bidState.getBookingStage(redis, user.id), 'awaiting_destination');
});

test('if WhatsApp refuses the list, the question still goes out — as numbered text', async () => {
  const redis = memoryRedis();
  const { deps } = makeDeps(redis);
  const { sent } = installWorld(admiraltyWorld({ refuseLists: true }));
  const who = rider();
  await riderInLekki(deps, redis, who);

  await say(deps, who, 'admiralty');
  assert.equal(last(sent).type, 'text');
  assert.match(textOf(last(sent)), /\*1\.\* Admiralty Way, Lekki, Nigeria/);
  assert.match(textOf(last(sent)), /Reply with the number/);
  await say(deps, who, '2');
  assert.match(textOf(last(sent)), /Destination: \*Admiralty Road/);
});

/* ── named places: a list, like a ride app's search box ─────────────────── */

const IKORODU_GARAGE = { lat: 6.6194, lng: 3.5105, name: 'Ikorodu Garage', address: 'Lagos Rd, Ikorodu, Lagos' };
const CALEB = [
  { lat: 6.6018, lng: 3.4800, name: 'Caleb University College of Law', address: 'Magodo, Lagos' },
  { lat: 6.6583, lng: 3.7420, name: 'Caleb University', address: 'Ibadan-Ijebu Ode Rd, Imota' },
  // Far enough from the main gate to be its own destination, as in Google's real data.
  { lat: 6.6480, lng: 3.7300, name: 'Caleb University Admissions', address: 'Imota, Lagos' },
  { lat: 6.6420, lng: 3.7390, name: 'Caleb University staff residence', address: 'Isiu' },
];
const calebWorld = (extra = {}) => ({
  // What the address geocoder really says today: ONE answer, badly labelled.
  geocode: (q) => (/caleb/i.test(q) ? { lat: 6.6583, lng: 3.7420, address: 'Ikorodu, Ibadan-Ijebu Ode Rd, Imota 104101, Lagos, Nigeria' }
    : /ikorodu/i.test(q) ? { lat: 6.6194, lng: 3.5105, address: 'Ikorodu, 104101, Lagos, Nigeria' } : null),
  places: (q) => (/caleb.*law|law.*caleb/i.test(q) ? [CALEB[0]] : /caleb/i.test(q) ? CALEB : /ikorodu garage/i.test(q) ? [IKORODU_GARAGE] : []),
  intent: (message, system) => (/part-way through booking/.test(system)
    ? (/caleb law/i.test(message) ? { intent: 'change_destination', address: 'Caleb law' } : { intent: 'other' })
    : {
        intent: 'ride_request',
        pickup: { address: 'Ikorodu Garage, Ikorodu, Lagos', area: 'Ikorodu', specific: true },
        destination: { address: 'Caleb University, Lagos', area: '', specific: true },
        offerNgn: null, paymentMethod: null, outsideNigeria: false,
      }),
  ...extra,
});

test('THE CHAT — "from ikorodu garage to Caleb University" offers the Caleb Universities instead of guessing one', async () => {
  const redis = memoryRedis();
  const { deps } = makeDeps(redis);
  const { sent } = installWorld(calebWorld());
  const who = rider();
  await say(deps, who, 'hi');
  const user = await agree(redis, await findRider(who));

  const before = sent.length;
  await say(deps, who, 'I want to book a ride from ikorodu garage to Caleb University');
  assert.equal(sent.length - before, 1, 'one message');
  const picker = last(sent);
  assert.equal(picker.interactive.type, 'list');
  assert.match(textOf(picker), /Pickup: \*Ikorodu Garage, Lagos Rd, Ikorodu, Lagos\*/, 'the garage by name — not just "Ikorodu"');
  assert.match(textOf(picker), /I found 4 places matching/);
  assert.doesNotMatch(textOf(picker), /Suggested fare/, 'no quote until they choose');

  const rows = picker.interactive.action.sections[0].rows;
  // "Caleb University …" does not fit 24 characters, so the shared words come off.
  // The place whose name is exactly what they typed leads; its namesakes elsewhere follow.
  assert.deepEqual(rows.map((r) => r.title), ['Caleb University', 'College of Law', 'Admissions', 'Staff residence', 'None of these']);
  assert.match(rows[0].description, /^Caleb University, Ibadan-Ijebu Ode Rd, Imota · 2\d km$/);
  assert.match(rows[1].description, /^Caleb University College of Law, Magodo, Lagos · 3\.\d km$/);
  for (const row of rows) { assert.ok(row.title.length <= 24); assert.ok(row.description.length <= 72); }

  await tap(deps, who, 'place_choice_2', 'College of Law');
  const quote = textOf(last(sent));
  assert.match(quote, /Pickup: \*Ikorodu Garage/);
  assert.match(quote, /Destination: \*Caleb University College of Law, Magodo, Lagos\*/);
  assert.doesNotMatch(quote, /Ibadan-Ijebu Ode Rd|[A-Z0-9]{4}\+[A-Z0-9]{2}/, 'no mislabelled road, no map code');
  assert.equal(await bidState.getBookingStage(redis, user.id), 'awaiting_trip_confirm');
});

test('THE CHAT, part 2 — "No Caleb law" at the price step lands on the College of Law, by name', async () => {
  const redis = memoryRedis();
  const { deps } = makeDeps(redis);
  const { sent } = installWorld(calebWorld());
  const who = rider();
  await say(deps, who, 'hi');
  await agree(redis, await findRider(who));
  await say(deps, who, 'I want to book a ride from ikorodu garage to Caleb University');
  await tap(deps, who, 'place_choice_1', 'Caleb University'); // they picked the main campus first

  await say(deps, who, 'No Caleb law');
  const requote = textOf(last(sent));
  assert.match(requote, /Destination updated!/);
  assert.match(requote, /Destination: \*Caleb University College of Law, Magodo, Lagos\*/);
  assert.doesNotMatch(requote, /\+2QW|Ketu/);
});

test('a correction that is itself ambiguous gets the picker too', async () => {
  const redis = memoryRedis();
  const { deps } = makeDeps(redis);
  const { sent } = installWorld(calebWorld({
    intent: (message, system) => (/part-way through booking/.test(system)
      ? { intent: 'change_destination', address: 'caleb university' }
      : calebWorld().intent(message, system)),
  }));
  const who = rider();
  await say(deps, who, 'hi');
  const user = await agree(redis, await findRider(who));
  await say(deps, who, 'I want to book a ride from ikorodu garage to Caleb University');
  await tap(deps, who, 'place_choice_1', 'Caleb University');

  await say(deps, who, 'not that caleb university, the other one');
  assert.equal(last(sent).interactive.type, 'list');
  await tap(deps, who, 'place_choice_3', 'Admissions');
  assert.match(textOf(last(sent)), /Destination: \*Caleb University Admissions/);
  assert.equal(await bidState.getBookingStage(redis, user.id), 'awaiting_trip_confirm');
});

test('with Places switched off in Google Cloud, the bot still works — it just cannot offer a list', async () => {
  const redis = memoryRedis();
  const { deps } = makeDeps(redis);
  const { sent } = installWorld(calebWorld({ placesOff: true }));
  const who = rider();
  await say(deps, who, 'hi');
  await agree(redis, await findRider(who));
  await say(deps, who, 'I want to book a ride from ikorodu garage to Caleb University');
  assert.match(textOf(last(sent)), /suggested fare/i, 'today\'s behaviour: the geocoder\'s single answer');
});

const IKORODU_SPOTS = [
  { lat: 6.6190, lng: 3.5100, name: 'Agric Bus Terminal', address: 'Ikorodu Rd, Ikorodu' },
  { lat: 6.6160, lng: 3.5060, name: 'Benson Busstop (Eco Bank) Ikorodu', address: 'Ikorodu' },
  { lat: 6.6210, lng: 3.5020, name: 'Aruna bus stop', address: '6/8 Solebo Str, Ikorodu' },
];

test('THE CHAT, part 3 — "I want to go from ikorodu" asks whereabouts WITH spots to tap', async () => {
  const redis = memoryRedis();
  const { deps } = makeDeps(redis);
  const { sent } = installWorld({
    geocode: () => null,
    places: () => [],
    spots: (q) => (/ikorodu/i.test(q) ? IKORODU_SPOTS : []),
    intent: (_m, system) => (/part-way through booking/.test(system) ? { intent: 'other' }
      : { intent: 'ride_request', pickup: { address: 'Ikorodu, Lagos', area: 'Ikorodu', specific: false }, destination: null, offerNgn: null, paymentMethod: null, outsideNigeria: false }),
  });
  const who = rider();
  await say(deps, who, 'hi');
  const user = await agree(redis, await findRider(who));

  const before = sent.length;
  await say(deps, who, 'I want to go from ikorodu');
  assert.equal(sent.length - before, 1);
  const picker = last(sent);
  assert.equal(picker.interactive.type, 'list');
  assert.match(textOf(picker), /Whereabouts in \*Ikorodu\* should the driver pick you up\?/);
  assert.match(textOf(picker), /or type a landmark or street, or share a location pin/, 'typing still works');
  const titles = picker.interactive.action.sections[0].rows.map((r) => r.title);
  assert.deepEqual(titles, ['Agric Bus Terminal', 'Benson Busstop (Eco…', 'Aruna bus stop', 'None of these']);

  await tap(deps, who, 'place_choice_1', 'Agric Bus Terminal');
  assert.match(textOf(last(sent)), /Pickup: \*Agric Bus Terminal, Ikorodu Rd, Ikorodu\*/);
  assert.match(textOf(last(sent)), /Where are you going\?/);
  assert.equal(await bidState.getBookingStage(redis, user.id), 'awaiting_destination');
});

test('no spots found for an area → the plain question, exactly as before', async () => {
  const redis = memoryRedis();
  const { deps } = makeDeps(redis);
  const { sent } = installWorld({
    geocode: () => null, places: () => [], spots: () => [],
    intent: (_m, system) => (/part-way through booking/.test(system) ? { intent: 'other' }
      : { intent: 'ride_request', pickup: { address: 'Ikorodu, Lagos', area: 'Ikorodu', specific: false }, destination: null, offerNgn: null, paymentMethod: null, outsideNigeria: false }),
  });
  const who = rider();
  await say(deps, who, 'hi');
  await agree(redis, await findRider(who));
  await say(deps, who, 'I want to go from ikorodu');
  assert.equal(last(sent).type, 'text');
  assert.match(textOf(last(sent)), /Tell me a landmark, street or bus stop/);
});

test('"from unilag gate to lekki": the "Lekki" they said is kept, and its spots are offered (it used to be thrown away)', async () => {
  const redis = memoryRedis();
  const { deps } = makeDeps(redis);
  const UNILAG = { lat: 6.5158, lng: 3.3898, name: 'University of Lagos Main Gate', address: 'Akoka, Lagos' };
  const LEKKI_SPOTS = [
    { lat: 6.4478, lng: 3.4723, name: 'Lekki Phase 1 Gate (Bus Park)', address: 'Lekki' },
    { lat: 6.4360, lng: 3.5200, name: 'Ikate Bus Stop', address: 'Lagos-Epe Express Rd, Lekki' },
  ];
  const { sent } = installWorld({
    geocode: () => null,
    places: (q) => (/unilag|university of lagos/i.test(q) ? [UNILAG] : []),
    spots: (q) => (/lekki/i.test(q) ? LEKKI_SPOTS : []),
    intent: (_m, system) => (/part-way through booking/.test(system) ? { intent: 'other' }
      : { intent: 'ride_request', pickup: { address: 'University of Lagos Main Gate', area: 'Akoka', specific: true }, destination: { address: 'Lekki, Lagos', area: 'Lekki', specific: false }, offerNgn: null, paymentMethod: null, outsideNigeria: false }),
  });
  const who = rider();
  await say(deps, who, 'hi');
  const user = await agree(redis, await findRider(who));

  await say(deps, who, 'from unilag gate to lekki');
  assert.match(textOf(last(sent)), /Pickup: \*University of Lagos Main Gate, Akoka, Lagos\*/);
  assert.match(textOf(last(sent)), /Whereabouts in \*Lekki\* are you headed\?/);
  assert.ok(await bidState.getPendingLocation(redis, user.id), 'the pickup is remembered');

  await tap(deps, who, 'place_choice_2', 'Ikate Bus Stop');
  assert.doesNotMatch(textOf(last(sent)), /Session expired/);
  assert.match(textOf(last(sent)), /Destination: \*Ikate Bus Stop/);
  assert.equal(await bidState.getBookingStage(redis, user.id), 'awaiting_trip_confirm');
});

/* ── one message, one answer — whichever way the model reads it ──────────── */

const { repairFromOnly } = require('../apps/api-gateway/dist/LLM/ride-intent-parser.js');

test('"from X" with no "to" is a pickup, even when the model files it under destination', () => {
  const misread = (message) => {
    const intent = { intent: 'ride_request', pickup: null, destination: { address: 'Caleb University, Nigeria', area: '', specific: true }, offerNgn: null, paymentMethod: null };
    repairFromOnly(intent, message);
    return intent;
  };
  for (const message of ['I want to go from Caleb University', 'from caleb university', 'pick me from Caleb University abeg', 'I wan comot from caleb university', 'I need to leave from Caleb University']) {
    const fixed = misread(message);
    assert.equal(fixed.pickup?.address, 'Caleb University, Nigeria', message);
    assert.equal(fixed.destination, null, message);
  }
  // A real destination is left alone.
  for (const message of ['take me to Caleb University', 'I want to go to Caleb University', 'from my house to Caleb University', 'Caleb University']) {
    const kept = misread(message);
    assert.equal(kept.pickup, null, message);
    assert.equal(kept.destination.address, 'Caleb University, Nigeria', message);
  }
});

test('with no model answering at all, a clearly stated trip is still understood', async () => {
  const { tripFromGrammar } = require('../apps/api-gateway/dist/LLM/ride-intent-parser.js');
  const ends = (message) => { const t = tripFromGrammar(message); return t ? [t.pickup?.address ?? null, t.destination?.address ?? null] : null; };
  assert.deepEqual(ends('I want to book a ride from ikorodu garage to Caleb University'), ['ikorodu garage', 'Caleb University']);
  assert.deepEqual(ends('I want to go from Caleb University'), ['Caleb University', null]);
  assert.deepEqual(ends('abeg take me to unilag main gate please'), [null, 'unilag main gate']);
  assert.deepEqual(ends('I dey go to yaba'), [null, 'yaba']);
  for (const notATrip of ['hello', 'I want to pay', 'how much to top up', '2,600', 'cancel my ride', 'I want to withdraw']) {
    assert.equal(ends(notATrip), null, notATrip);
  }

  // End to end: the model is down, the rider still gets their picker.
  const redis = memoryRedis();
  const { deps } = makeDeps(redis);
  const { sent } = installWorld(calebWorld({ intent: () => 'down' }));
  const who = rider();
  await say(deps, who, 'hi');
  await agree(redis, await findRider(who));
  await say(deps, who, 'I want to book a ride from ikorodu garage to Caleb University');
  assert.equal(last(sent).interactive?.type, 'list');
  assert.match(textOf(last(sent)), /Pickup: \*Ikorodu Garage/);
  assert.match(textOf(last(sent)), /places matching "Caleb University"/);
});

test('THE CHAT, part 4 — "I want to go from Caleb University" gets the picker even when the model misreads it', async () => {
  const redis = memoryRedis();
  const { deps } = makeDeps(redis);
  const { sent } = installWorld(calebWorld({
    // What Groq's model answered 3 times out of 5, live.
    intent: (_m, system) => (/part-way through booking/.test(system) ? { intent: 'other' }
      : { intent: 'ride_request', pickup: null, destination: { address: 'Caleb University, Nigeria', area: '', specific: true }, offerNgn: null, paymentMethod: null, outsideNigeria: false }),
  }));
  const who = rider();
  await say(deps, who, 'hi');
  await agree(redis, await findRider(who));

  await say(deps, who, 'I want to go from Caleb University');
  assert.doesNotMatch(textOf(last(sent)), /To book a ride, type your pickup and destination/);
  assert.equal(last(sent).interactive?.type, 'list');
  assert.match(textOf(last(sent)), /pick the right pickup/);
});

test('only a destination given: it is remembered, the pickup is asked for, and the trip carries on by itself', async () => {
  const redis = memoryRedis();
  const { deps } = makeDeps(redis);
  const { sent } = installWorld(calebWorld({
    intent: (_m, system) => (/part-way through booking/.test(system) ? { intent: 'other' }
      : { intent: 'ride_request', pickup: null, destination: { address: 'Caleb law', area: '', specific: true }, offerNgn: null, paymentMethod: null, outsideNigeria: false }),
  }));
  const who = rider();
  await say(deps, who, 'hi');
  const user = await agree(redis, await findRider(who));

  await say(deps, who, 'take me to caleb law');
  assert.match(textOf(last(sent)), /Heading to \*Caleb law\* — got it/);
  assert.match(textOf(last(sent)), /Where should we pick you up\?/);
  assert.doesNotMatch(textOf(last(sent)), /To book a ride, type/);
  assert.equal(await bidState.getBookingStage(redis, user.id), 'awaiting_pickup');

  // They answer with the pickup — and are NOT asked for the destination again.
  await say(deps, who, 'ikorodu garage');
  const quote = textOf(last(sent));
  assert.match(quote, /Pickup: \*Ikorodu Garage/);
  assert.match(quote, /Destination: \*Caleb University College of Law/);
  assert.equal(await bidState.getBookingStage(redis, user.id), 'awaiting_trip_confirm');
});

/* ── searching near the pickup ─────────────────────────────────────────── */

test('a destination search leans towards the pickup, and asks Places before believing another city', async () => {
  const { calls } = installWorld({
    geocode: () => BENIN, // the street geocoder insists on Benin, bias or not
    places: (_q, bias) => (bias.startsWith('circle:') ? YABA : null),
    intent: () => ({ intent: 'other' }),
  });

  const [best] = await geocodeAddressCandidates('k', 'No 7 osaro isokpan', 3, { near: AKOKA });
  assert.match(best.formattedAddress, /^7 Osaro Isokpan St, Yaba/, 'the match 2 km away beats the one 245 km away');
  assert.match(calls.geocode[0].bounds, /^6\.02\d*,2\.88\d*\|7\.02\d*,3\.88\d*$/, 'Google was told where the trip is');
  assert.match(calls.places[0].bias, /^circle:50000@6\.5244,3\.387$/);

  const single = await geocodeAddress('k', 'No 7 osaro isokpan', { near: AKOKA });
  assert.match(single.formattedAddress, /^7 Osaro Isokpan St, Yaba/);

  const noHint = await geocodeAddress('k', 'No 7 osaro isokpan');
  assert.equal(noHint.formattedAddress, BENIN.address, 'without a pickup nothing changes');
});

test('a rider really going to another city still can: near is a lean, never a filter', async () => {
  installWorld({ geocode: () => BENIN, places: () => null, intent: () => ({ intent: 'other' }) });
  const [only] = await geocodeAddressCandidates('k', 'Isokpan street Benin', 3, { near: AKOKA });
  assert.equal(only.formattedAddress, BENIN.address);
});

/* ── the screenshots ───────────────────────────────────────────────────── */

test('SCREENSHOT 1 — "No 7 osaro isokpan" from Akoka is quoted for Lagos, not Benin City', async () => {
  const redis = memoryRedis();
  const { deps } = makeDeps(redis);
  const { sent } = installWorld({
    geocode: () => BENIN,
    places: (_q, bias) => (bias.startsWith('circle:') ? YABA : null),
    intent: () => ({ intent: 'other' }),
  });
  const who = rider();
  await riderWithPickup(deps, redis, who);

  await say(deps, who, 'No 7 osaro isokpan');
  const reply = textOf(last(sent));
  assert.match(reply, /7 Osaro Isokpan St, Yaba/);
  assert.doesNotMatch(reply, /Benin/);
  assert.match(reply, /suggested fare ₦1,[0-9]{3}\b/, 'a city fare, not ₦97,100');
});

test('when the only match IS in another city, the bot asks before quoting — and both answers work', async () => {
  const redis = memoryRedis();
  const { deps } = makeDeps(redis);
  const { sent } = installWorld({
    geocode: (query) => (/lagos|yaba/i.test(query) ? YABA : BENIN),
    places: () => null,
    intent: () => ({ intent: 'other' }),
  });
  const who = rider();
  const user = await riderWithPickup(deps, redis, who);

  await say(deps, who, 'No 7 osaro isokpan');
  const question = textOf(last(sent));
  assert.match(question, /Isokpan St, Use, Benin City/);
  assert.match(question, /about \*2\d\d km\* from your pickup, in another city/);
  assert.match(question, /Reply \*yes\* if you really are going that far/);
  assert.doesNotMatch(question, /Suggested fare/, 'no ₦97,100 quote for a place they never meant');
  assert.equal(await bidState.getBookingStage(redis, user.id), 'awaiting_destination', 'still waiting for a destination');

  // The rider does what the screenshot rider did: sends it again with the city.
  await say(deps, who, 'No 7 osaro isokpan Lagos');
  assert.match(textOf(last(sent)), /Destination: \*7 Osaro Isokpan St, Yaba/);
  assert.equal(await bidState.getBookingStage(redis, user.id), 'awaiting_trip_confirm');

  // A different rider who really is going to Benin.
  const traveller = rider();
  const travellerUser = await riderWithPickup(deps, redis, traveller);
  await say(deps, traveller, 'Isokpan street');
  await say(deps, traveller, 'yes');
  assert.match(textOf(last(sent)), /Destination: \*Isokpan St, Use, Benin City/);
  assert.equal(await bidState.getBookingStage(redis, travellerUser.id), 'awaiting_trip_confirm');
});

test('the whole trip in one message gets the same care: destination searched near the pickup, far ones questioned', async () => {
  const redis = memoryRedis();
  const { deps } = makeDeps(redis);
  let placesNearby = YABA;
  const { sent, calls } = installWorld({
    geocode: (query) => (/emily|akoka/i.test(query) ? AKOKA : BENIN),
    places: (_q, bias) => (bias.startsWith('circle:') ? placesNearby : null),
    intent: (_message, system) => (/part-way through booking/.test(system)
      ? { intent: 'other' }
      : {
          intent: 'ride_request',
          pickup: { address: '31 Emily Akinola, Akoka', area: 'Akoka', specific: true },
          destination: { address: 'No 7 osaro isokpan', area: '', specific: true },
          offerNgn: null, paymentMethod: null, outsideNigeria: false,
        }),
  });

  const who = rider();
  await say(deps, who, 'hi');
  await agree(redis, await findRider(who));
  await say(deps, who, 'take me from 31 emily akinola akoka to no 7 osaro isokpan');
  assert.match(textOf(last(sent)), /Destination: \*7 Osaro Isokpan St, Yaba/);
  const destinationLookup = calls.geocode.find((call) => /isokpan/i.test(call.address));
  assert.ok(destinationLookup.bounds, 'the destination lookup knew where the pickup was');

  // Same message, but nothing of that name near Lagos: ask, do not quote.
  placesNearby = null;
  resetPlacesAvailability(); // place searches are remembered for a few hours; this is a different world
  const other = rider();
  await say(deps, other, 'hi');
  await agree(redis, await findRider(other));
  await say(deps, other, 'take me from 31 emily akinola akoka to no 7 osaro isokpan');
  assert.match(textOf(last(sent)), /in another city/);
  assert.doesNotMatch(textOf(last(sent)), /Suggested fare/);
  await say(deps, other, 'yes');
  assert.match(textOf(last(sent)), /Destination: \*Isokpan St, Use, Benin City/);
});

test('SCREENSHOTS 2 + 3 — at the price step the rider is understood, not told to send a price', async () => {
  const redis = memoryRedis();
  const { deps } = makeDeps(redis);
  const { sent } = installWorld({
    geocode: (query) => (/lagos/i.test(query) ? YABA : BENIN),
    places: () => null,
    // The model, as measured live, for these exact messages.
    intent: (message) => ({
      'No 7 osaro isokpan Lagos': { intent: 'change_destination', address: 'No 7 osaro isokpan Lagos' },
      'Book a ride': { intent: 'restart', address: null },
      'Cancel first order': { intent: 'cancel', address: null },
    }[message] ?? { intent: 'other', address: null }),
  });
  const who = rider();
  const user = await riderWithPickup(deps, redis, who);

  // Get them to the screenshot's state: a Benin quote on the table.
  await say(deps, who, 'Isokpan street');
  await say(deps, who, 'yes');
  assert.match(textOf(last(sent)), /Benin City/);

  await say(deps, who, 'No 7 osaro isokpan Lagos');
  const requote = textOf(last(sent));
  assert.match(requote, /Destination updated!/);
  assert.match(requote, /Destination: \*7 Osaro Isokpan St, Yaba/);
  assert.doesNotMatch(requote, /Please send a price/);

  await say(deps, who, 'Cancel first order');
  assert.doesNotMatch(textOf(last(sent)), /Please send a price/);
  assert.equal(await bidState.getBookingStage(redis, user.id), 'awaiting_cancel_reason');

  // Back at a quote, "Book a ride" starts over instead of looping.
  await bidState.setBookingStage(redis, user.id, 'awaiting_price');
  await say(deps, who, 'Book a ride');
  assert.match(textOf(last(sent)), /start fresh/);
  assert.equal(await bidState.getBookingStage(redis, user.id), null);
  assert.equal(await bidState.getPendingRoute(redis, user.id), null, 'the old quote is gone');
});

test('a price is still just a price — no model call, and the ride is published', async () => {
  const redis = memoryRedis();
  const { deps, published } = makeDeps(redis);
  const { sent, calls } = installWorld({ geocode: () => YABA, places: () => null, intent: () => ({ intent: 'other' }) });
  const who = rider();
  await riderWithPickup(deps, redis, who);
  await say(deps, who, 'Osaro Isokpan street');
  const groqBefore = calls.groq;

  await say(deps, who, '2,000');
  assert.equal(calls.groq, groqBefore, 'a number never costs a model call');
  assert.ok(published.some((p) => p.event?.eventType === 'RIDE_REQUESTED' && p.event.riderOfferNgn === 2000));
  assert.doesNotMatch(textOf(last(sent)), /Please send a price/);
});

test('never turn "ok" into a fare; never guess an amount from words', async () => {
  const redis = memoryRedis();
  const { deps, published } = makeDeps(redis);
  const { sent } = installWorld({
    geocode: () => YABA, places: () => null,
    intent: (message) => (message === 'ok book it' ? { intent: 'confirm' } : { intent: 'answer' }),
  });
  const who = rider();
  await riderWithPickup(deps, redis, who);
  await say(deps, who, 'Osaro Isokpan street');
  await tapButton(deps, who, 'trip_confirm', 'Confirm trip');

  await say(deps, who, 'ok book it');
  assert.match(textOf(last(sent)), /just tell me your price/);
  await say(deps, who, 'two thousand five hundred');
  assert.match(textOf(last(sent)), /send it in figures/);
  assert.equal(published.filter((p) => p.event?.eventType === 'RIDE_REQUESTED').length, 0, 'nothing was booked on a guess');
});

/* ── the bidding page, from the chat's side ─────────────────────────────── */

test('the quote comes with a "Set your price" button; typing a price still works, and the search message says offers come to the chat', async () => {
  const redis = memoryRedis();
  const { deps, published } = makeDeps(redis);
  deps.appBaseUrl = 'https://app.wheelersng.com';
  const { sent } = installWorld({ geocode: () => YABA, places: () => null, intent: () => ({ intent: 'other' }) });
  const who = rider();
  const user = await riderWithPickup(deps, redis, who);

  await say(deps, who, 'Osaro Isokpan street');
  assert.equal(last(sent).interactive.type, 'button', 'first the trip is confirmed — no price is asked for yet');
  await tapButton(deps, who, 'trip_confirm', 'Confirm trip');
  const quote = last(sent);
  assert.equal(quote.interactive.type, 'cta_url');
  assert.equal(quote.interactive.action.parameters.display_text, 'Set your price');
  assert.match(textOf(quote), /Suggested fare: ₦/);
  assert.match(textOf(quote), /Tap \*Set your price\* — or just type your offer/, 'the chat fallback is named');
  const url = quote.interactive.action.parameters.url;
  assert.match(url, /^https:\/\/app\.wheelersng\.com\/widget\/ride\/ride\.html#t=/);
  const local = require('../apps/api-gateway/dist/auth/local.js');
  assert.deepEqual(local.verifyWalletPageToken(decodeURIComponent(url.split('#t=')[1]), deps.jwtSecret), { userId: user.id, scope: 'ride' });

  await say(deps, who, '2,000');
  const searching = last(sent);
  assert.equal(searching.interactive.action.parameters.display_text, 'Change my price', 'the page is for the price — offers are not on it');
  assert.match(textOf(searching), /Finding you a driver/);
  assert.match(textOf(searching), /offers will land right here in this chat/);
  assert.ok(published.some((p) => p.event?.eventType === 'RIDE_REQUESTED' && p.event.riderOfferNgn === 2000));
});

async function driverWithPhotos({ selfie = true, car = true } = {}) {
  const user = await prisma.user.create({ data: { privyDid: `local:${Date.now()}-${Math.random()}`, role: 'DRIVER', name: 'Chinedu Okafor' } });
  const driver = await prisma.driver.create({ data: { userId: user.id, kycStatus: 'APPROVED' } });
  await prisma.driverKycSubmission.create({ data: { driverId: driver.id, selfieKey: selfie ? 'selfie.jpg' : null, vehicleImageKeys: car ? ['car.jpg'] : [] } });
  return driver;
}
const confirmedRide = (driverId) => ({
  rideId: 'r1', fareNgn: 6200, driverId, driverName: 'Chinedu Okafor', driverPhone: '+2348031234567', driverRating: 4.9, totalRides: 412,
  vehicleModel: 'Toyota Corolla', vehiclePlate: 'LND-174XA', etaSeconds: 240,
  pickupAddress: 'Ikorodu Garage, Lagos Rd, Ikorodu', destAddress: 'Caleb University College of Law, Magodo, Lagos',
});
function recordMeta({ refuseCards = false } = {}) {
  const order = [];
  global.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const isCard = body.type === 'interactive' && body.interactive.header?.type === 'image';   // the ride card WITH its picture
    order.push({ type: isCard ? 'card' : body.type, at: Date.now(), body });
    if (isCard && refuseCards) { order.pop(); return { ok: false, status: 400, json: async () => ({}), text: async () => 'header not supported' }; }
    return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
  };
  return order;
}
function confirmationDeps(redis) {
  const { deps } = makeDeps(redis);
  deps.appBaseUrl = 'https://app.wheelersng.com';
  deps.driverKycStorage = { getSignedUrl: async (key) => `https://files.test/${key}` };
  return deps;
}

test('ride confirmed is TWO messages: the driver\'s photo, then ONE card — car photo, every detail, and two buttons: Track live trip, 🆘 SOS', async () => {
  const redis = memoryRedis();
  const deps = confirmationDeps(redis);
  const order = recordMeta();
  const driver = await driverWithPhotos();

  await createRidePageChatNotifier(deps)({ kind: 'ride_confirmed', userId: 'rider-1', phone: '+2348030000001', ride: confirmedRide(driver.id) });

  assert.deepEqual(order.map((m) => m.type), ['image', 'card'], 'two messages — not three, not four');
  assert.match(order[0].body.image.link, /selfie\.jpg$/);
  assert.match(order[0].body.image.caption, /Your driver: \*Chinedu Okafor\*/);
  assert.ok(order[1].at - order[0].at >= 1100, 'the card waits for the first photo to land');

  const card = order[1].body.interactive;
  assert.equal(card.type, 'button');
  assert.match(card.header.image.link, /car\.jpg$/, 'the car is the picture on the card');
  assert.deepEqual(card.action.buttons.map((b) => [b.reply.id, b.reply.title]), [['ride_track', 'Track live trip'], ['ride_sos', '🆘 SOS']]);

  const text = card.body.text;
  assert.ok(text.length <= 1024);
  assert.doesNotMatch(text, /https?:\/\//, 'no link in the text — tracking is a button');
  const at = (needle) => { const i = text.indexOf(needle); assert.ok(i >= 0, `the info carries "${needle}"`); return i; };
  const sequence = ['Ride confirmed & paid', '*YOUR DRIVER*', 'Chinedu Okafor', '4.9 · 412 rides', '+2348031234567',
    '*THE CAR*', 'Toyota Corolla', 'Plate: *LND-174XA*',
    '*YOUR TRIP*', 'From: Ikorodu Garage', 'To: Caleb University College of Law', '₦6,200 — held in your wallet', 'Arrives in about 4 min',
    '*Track live trip*', '*SOS*'].map(at);
  assert.deepEqual(sequence, [...sequence].sort((a, b) => a - b), 'in reading order: tracking, then SOS');
});

test('Track live trip is a reply button, and a reply button cannot open a link — so the tap is answered with ONE message: the map\'s link button', async () => {
  const redis = memoryRedis();
  const { deps } = makeDeps(redis);
  deps.appBaseUrl = 'https://app.wheelersng.com';
  const { sent } = installWorld({ geocode: () => YABA, places: () => null, intent: () => ({ intent: 'other' }) });
  const who = rider();
  await say(deps, who, 'hi');
  const user = await agree(redis, await findRider(who));

  const before = sent.length;
  await tapButton(deps, who, 'ride_track', 'Track live trip');
  assert.equal(sent.length, before + 1);
  const map = last(sent).interactive;
  assert.equal(map.type, 'cta_url');
  assert.equal(map.action.parameters.display_text, 'Open live map');
  const url = map.action.parameters.url;
  assert.match(url, /^https:\/\/app\.wheelersng\.com\/widget\/ride\/ride\.html#t=/);
  const local = require('../apps/api-gateway/dist/auth/local.js');
  assert.deepEqual(local.verifyWalletPageToken(decodeURIComponent(url.split('#t=')[1]), deps.jwtSecret), { userId: user.id, scope: 'ride' });
});

test('one photo on file → ONE message; none → the card without a picture; WhatsApp refuses the picture card → the same card without it', async () => {
  const deps = confirmationDeps(memoryRedis());

  let order = recordMeta();
  const selfieOnly = await driverWithPhotos({ car: false });
  await createRidePageChatNotifier(deps)({ kind: 'ride_confirmed', userId: 'r', phone: '+2348030000001', ride: confirmedRide(selfieOnly.id) });
  assert.deepEqual(order.map((m) => m.type), ['card']);
  assert.match(order[0].body.interactive.header.image.link, /selfie\.jpg$/, 'the driver\'s own photo becomes the card');

  order = recordMeta();
  const noPhotos = await driverWithPhotos({ selfie: false, car: false });
  await createRidePageChatNotifier(deps)({ kind: 'ride_confirmed', userId: 'r', phone: '+2348030000001', ride: confirmedRide(noPhotos.id) });
  assert.deepEqual(order.map((m) => m.type), ['interactive']);
  assert.deepEqual(order[0].body.interactive.action.buttons.map((b) => b.reply.title), ['Track live trip', '🆘 SOS']);
  assert.match(order[0].body.interactive.body.text, /Plate: \*LND-174XA\*/);

  order = recordMeta({ refuseCards: true });
  const both = await driverWithPhotos();
  await createRidePageChatNotifier(deps)({ kind: 'ride_confirmed', userId: 'r', phone: '+2348030000001', ride: confirmedRide(both.id) });
  assert.deepEqual(order.map((m) => m.type), ['image', 'interactive'], 'still two messages, still every detail, still SOS');
  assert.deepEqual(order[1].body.interactive.action.buttons.map((b) => b.reply.id), ['ride_track', 'ride_sos']);
});

/* ── 🆘 SOS: one tap on the ride card tells the safety team — the same alerts the app raises ── */

test('SOS: one tap records the emergency with the trip, the driver and the car\'s position; pressing again is ONE incident; "I\'m safe" withdraws it', async () => {
  const redis = memoryRedis();
  const { deps } = makeDeps(redis);
  const { sent } = installWorld({ geocode: () => YABA, places: () => null, intent: () => ({ intent: 'other' }) });
  const who = rider();
  await say(deps, who, 'hi');
  const user = await agree(redis, await findRider(who));
  const driver = await onlineDriver();
  const ride = await prisma.ride.create({ data: { riderId: user.id, driverId: driver.driverId, status: 'IN_PROGRESS', pickupLat: AKOKA.lat, pickupLng: AKOKA.lng, pickupAddress: AKOKA.address, destLat: YABA.lat, destLng: YABA.lng, destAddress: YABA.address } });

  await tapButton(deps, who, 'ride_sos', '🆘 SOS');
  const alerts = () => prisma.safetyAlert.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'asc' } });
  const [alert] = await alerts();
  assert.deepEqual([alert.kind, alert.status, alert.raisedByRole, alert.rideId, alert.counterpartUserId], ['SOS', 'OPEN', 'RIDER', ride.id, driver.userId]);
  assert.deepEqual([alert.lat, alert.lng], [6.52, 3.38], 'a chat tap carries no position — the car\'s is where the rider is');
  assert.match(alert.note, /WhatsApp ride card[\s\S]*DRIVER's last known position[\s\S]*IN_PROGRESS/);

  // They are told it was heard — and how to take it back.
  const heard = last(sent).interactive;
  assert.match(heard.body.text, /SOS received[\s\S]*your trip, your driver and your location[\s\S]*Call \*112\*/);
  assert.deepEqual(heard.action.buttons.map((b) => [b.reply.id, b.reply.title]), [['ride_sos_cancel', "I'm safe"]]);

  await tapButton(deps, who, 'ride_sos', '🆘 SOS');                       // a frightened thumb
  assert.equal((await alerts()).length, 1, 'one emergency, not two');
  assert.match(textOf(last(sent)), /We already have your alert/);

  await tapButton(deps, who, 'ride_sos_cancel', "I'm safe");
  assert.equal((await alerts())[0].status, 'CANCELLED');
  assert.match(textOf(last(sent)), /alert has been withdrawn/);
  await prisma.ride.update({ where: { id: ride.id }, data: { status: 'COMPLETED' } });
});

test('SOS is never stopped by anything else the chat is doing — not even the privacy question — and is recorded with no trip at all', async () => {
  const redis = memoryRedis();
  const { deps } = makeDeps(redis);
  const { sent } = installWorld({ geocode: () => YABA, places: () => null, intent: () => ({ intent: 'other' }) });
  const who = rider();
  await say(deps, who, 'hi');                                             // consent still PENDING
  const user = await findRider(who);
  assert.equal(user.privacyConsent, 'PENDING');

  await tapButton(deps, who, 'ride_sos', '🆘 SOS');
  const alert = await prisma.safetyAlert.findFirst({ where: { userId: user.id } });
  assert.ok(alert, 'the alert must get recorded');
  assert.deepEqual([alert.rideId, alert.lat], [null, null]);
  assert.match(textOf(last(sent)), /SOS received/);
  assert.doesNotMatch(textOf(last(sent)), /privacy/i);
});

/* ── confirm the trip before the price: Confirm · Add a stop · Edit trip ── */

const SABO = { lat: 6.5068, lng: 3.3780, address: 'Sabo Market, Yaba, Lagos', name: 'Sabo Market' };
const TEJUOSHO = { lat: 6.5140, lng: 3.3690, address: 'Tejuosho Market, Yaba, Lagos', name: 'Tejuosho Market' };
const UNILAG_GATE = { lat: 6.5190, lng: 3.3900, address: 'University of Lagos Main Gate, Akoka, Lagos', name: 'UNILAG Main Gate' };

/** A rider looking at "Check your trip": Akoka → Yaba, nothing confirmed yet. */
async function riderAtTripCard(world = {}, configure = () => {}) {
  const redis = memoryRedis();
  const { deps, published } = makeDeps(redis);
  deps.appBaseUrl = 'https://app.wheelersng.com';
  configure(deps);
  const { sent } = installWorld({ geocode: () => YABA, places: () => null, intent: () => ({ intent: 'other' }), ...world });
  const who = rider();
  const user = await riderWithPickup(deps, redis, who);
  await say(deps, who, 'Osaro Isokpan street');
  return { redis, deps, sent, who, user, published };
}

test('after the destination comes "Check your trip" — Confirm / Add a stop / Edit — and NO price until it is confirmed', async () => {
  const { redis, deps, sent, who, user } = await riderAtTripCard();

  const card = last(sent).interactive;
  assert.equal(card.type, 'button');
  assert.deepEqual(card.action.buttons.map((b) => [b.reply.id, b.reply.title]), [['trip_confirm', 'Confirm trip'], ['trip_add_stop', 'Add a stop'], ['trip_edit', 'Edit trip']]);
  assert.match(card.body.text, /Check your trip[\s\S]*Pickup: \*31 Emily Akinola[\s\S]*Destination: \*7 Osaro Isokpan St, Yaba/);
  assert.doesNotMatch(card.body.text, /Send your offer|Minimum fare|Set your price/, 'the price is not asked for yet');
  assert.equal(await bidState.getBookingStage(redis, user.id), 'awaiting_trip_confirm');

  await tapButton(deps, who, 'trip_confirm', 'Confirm trip');
  const quote = last(sent).interactive;
  assert.equal(quote.action.parameters.display_text, 'Set your price');
  assert.match(quote.body.text, /Trip confirmed[\s\S]*Minimum fare: ₦[\s\S]*Suggested fare: ₦/);
  assert.equal(await bidState.getBookingStage(redis, user.id), 'awaiting_price');
  assert.equal((await bidState.getPendingRoute(redis, user.id)).confirmed, true);
});

test('typing works as well as tapping: "yes" confirms, and a price typed at the card means "this trip, at this price"', async () => {
  const typedYes = await riderAtTripCard();
  await say(typedYes.deps, typedYes.who, 'yes');
  assert.equal(await bidState.getBookingStage(typedYes.redis, typedYes.user.id), 'awaiting_price');

  const typedPrice = await riderAtTripCard();
  await say(typedPrice.deps, typedPrice.who, '2,000');
  assert.ok(typedPrice.published.some((p) => p.event?.eventType === 'RIDE_REQUESTED' && p.event.riderOfferNgn === 2000));
});

test('ADD A STOP: tap, type the place, pick it from the Places list — the trip is re-planned through it and drivers are told', async () => {
  const { redis, deps, sent, who, user, published } = await riderAtTripCard({ places: (query) => (/market/i.test(query) ? [SABO, TEJUOSHO] : null) });
  const before = await bidState.getPendingRoute(redis, user.id);

  await tapButton(deps, who, 'trip_add_stop', 'Add a stop');
  assert.match(textOf(last(sent)), /Where do you want to stop\?/);
  assert.equal(await bidState.getBookingStage(redis, user.id), 'adding_stop');

  // Two markets match: the same picker as every other place — never a guess.
  await say(deps, who, 'yaba market');
  const picker = last(sent).interactive;
  assert.equal(picker.type, 'list');
  assert.equal(picker.action.sections[0].title, 'Pick the stop');
  assert.deepEqual(picker.action.sections[0].rows.map((r) => r.title), ['Sabo Market', 'Tejuosho Market', 'None of these']);

  await tap(deps, who, 'place_choice_2', 'Tejuosho Market');
  const card = last(sent).interactive;
  assert.match(card.body.text, /Stop added[\s\S]*Pickup: \*31 Emily[\s\S]*Stop 1: \*Tejuosho Market, Yaba, Lagos\*[\s\S]*Destination: \*7 Osaro/);
  const after = await bidState.getPendingRoute(redis, user.id);
  assert.deepEqual(after.stops, [{ lat: TEJUOSHO.lat, lng: TEJUOSHO.lng, address: TEJUOSHO.address }]);
  assert.ok(after.distanceKm > before.distanceKm && after.suggestedFareNgn >= before.suggestedFareNgn, 'the route and the fare are for the trip THROUGH the stop');
  assert.notEqual(after.confirmed, true, 'a changed trip is confirmed again');
  assert.equal(await bidState.getBookingStage(redis, user.id), 'awaiting_trip_confirm');

  await tapButton(deps, who, 'trip_confirm', 'Confirm trip');
  assert.match(textOf(last(sent)), /Trip confirmed[\s\S]*Stop 1: \*Tejuosho Market/);
  await say(deps, who, '3,000');
  const request = published.find((p) => p.event?.eventType === 'RIDE_REQUESTED').event;
  assert.deepEqual(request.stops, [{ lat: TEJUOSHO.lat, lng: TEJUOSHO.lng, address: TEJUOSHO.address }], 'drivers see the stop');
  assert.match(textOf(last(sent)), /Finding you a driver[\s\S]*Stop 1: \*Tejuosho Market/);
});

test('just TYPING it works: "add a stop at sabo market" / "remove the stop" — and "back" leaves the trip alone', async () => {
  const { redis, deps, sent, who, user } = await riderAtTripCard({
    places: (query) => (/sabo/i.test(query) ? SABO : null),
    intent: (message) => ({
      'abeg make we branch sabo market first': { intent: 'add_stop', address: 'sabo market' },
      'no need to stop again': { intent: 'remove_stop', address: null },
    }[message] ?? { intent: 'other', address: null }),
  });

  await say(deps, who, 'abeg make we branch sabo market first');
  assert.match(textOf(last(sent)), /Stop added[\s\S]*Stop 1: \*Sabo Market, Yaba, Lagos\*/);

  await say(deps, who, 'no need to stop again');
  assert.match(textOf(last(sent)), /Stop removed/);
  assert.doesNotMatch(textOf(last(sent)), /Stop 1:/);
  assert.deepEqual((await bidState.getPendingRoute(redis, user.id)).stops, []);

  await tapButton(deps, who, 'trip_add_stop', 'Add a stop');
  await say(deps, who, 'back');
  assert.match(textOf(last(sent)), /No stop added[\s\S]*Confirm trip/);
  assert.equal(await bidState.getBookingStage(redis, user.id), 'awaiting_trip_confirm');
});

test('EDIT TRIP opens the Choose sheet: change pickup, change destination, add a stop, remove each stop — and a change keeps the stops', async () => {
  const { redis, deps, sent, who, user } = await riderAtTripCard({ places: (query) => (/sabo/i.test(query) ? SABO : /gate/i.test(query) ? UNILAG_GATE : null) });
  await tapButton(deps, who, 'trip_add_stop', 'Add a stop');
  await say(deps, who, 'sabo market');

  await tapButton(deps, who, 'trip_edit', 'Edit trip');
  const sheet = last(sent).interactive;
  assert.equal(sheet.type, 'list');
  assert.equal(sheet.action.button, 'Choose');
  assert.deepEqual(sheet.action.sections[0].rows.map((r) => [r.id, r.title]), [
    ['trip_edit_pickup', 'Change pickup'], ['trip_edit_destination', 'Change destination'], ['trip_add_stop', 'Add a stop'],
    ['trip_remove_stop_1', 'Remove stop 1'], ['trip_cancel', 'Cancel booking'],
  ]);
  assert.ok(sheet.action.sections[0].rows.every((r) => r.title.length <= 24 && r.description.length <= 72));
  assert.match(sheet.action.sections[0].rows[3].description, /Sabo Market/, 'each row says what it would change');

  // Change pickup → type a name → Places finds it → the trip comes back for confirmation, stop intact.
  await tap(deps, who, 'trip_edit_pickup', 'Change pickup');
  assert.match(textOf(last(sent)), /Current pickup: \*31 Emily Akinola[\s\S]*Type the new pickup/);
  await say(deps, who, 'unilag main gate');
  assert.match(textOf(last(sent)), /Pickup updated![\s\S]*Pickup: \*UNILAG Main Gate[\s\S]*Stop 1: \*Sabo Market/);
  assert.equal(await bidState.getBookingStage(redis, user.id), 'awaiting_trip_confirm');

  await tap(deps, who, 'trip_remove_stop_1', 'Remove stop 1');
  assert.deepEqual((await bidState.getPendingRoute(redis, user.id)).stops, []);
});

test('stops have limits that are said out loud: three at most, never another city, never the same place twice', async () => {
  const far = { lat: 7.3775, lng: 3.9470, address: 'Sabo Market, Ibadan', name: 'Sabo Market' };
  let found = SABO;
  const { redis, deps, sent, who, user } = await riderAtTripCard({ places: () => found });
  const addStop = async (place, text) => { found = place; await tapButton(deps, who, 'trip_add_stop', 'Add a stop'); await say(deps, who, text); };

  await addStop(far, 'sabo ibadan');          // (its own words: place lookups are cached by what was typed)
  assert.match(textOf(last(sent)), /in another city/);
  assert.equal((await bidState.getPendingRoute(redis, user.id)).stops ?? null, null, 'nothing was added');

  await say(deps, who, 'back');
  await addStop({ ...YABA, name: 'Osaro Isokpan' }, 'osaro isokpan');
  assert.match(textOf(last(sent)), /same place as your destination/);
  await say(deps, who, 'back');

  await addStop(SABO, 'sabo market');
  await addStop(TEJUOSHO, 'tejuosho');
  await addStop(UNILAG_GATE, 'unilag gate');
  const full = last(sent).interactive;
  assert.deepEqual(full.action.buttons.map((b) => b.reply.title), ['Confirm trip', 'Edit trip'], 'no "Add a stop" once there are three');
  await tap(deps, who, 'trip_add_stop', 'Add a stop');     // an old card's button
  assert.match(textOf(last(sent)), /up to 3 stops/);
  assert.equal((await bidState.getPendingRoute(redis, user.id)).stops.length, 3);
});

test('old cards stay tappable and stay safe: Edit after confirming re-opens the trip; a card from an expired or running booking says so', async () => {
  const { redis, deps, sent, who, user } = await riderAtTripCard();
  await tapButton(deps, who, 'trip_confirm', 'Confirm trip');
  await tapButton(deps, who, 'trip_edit', 'Edit trip');                  // the card above the quote
  assert.equal(last(sent).interactive.type, 'list');
  assert.equal(await bidState.getBookingStage(redis, user.id), 'awaiting_trip_confirm');

  await bidState.clearPendingRoute(redis, user.id);
  await tapButton(deps, who, 'trip_confirm', 'Confirm trip');
  assert.match(textOf(last(sent)), /That trip has expired/);

  await bidState.setActiveRide(redis, user.id, 'ride-already-out');
  await tapButton(deps, who, 'trip_add_stop', 'Add a stop');
  assert.match(textOf(last(sent)), /Drivers are already looking at this trip/);
});

test('"I did not catch that" shows the trip again — and an unsure model never counts as "yes"', async () => {
  const { redis, deps, sent, who, user } = await riderAtTripCard({ intent: () => ({ intent: 'answer', address: null }) });
  await say(deps, who, 'hmm wetin be this');
  assert.equal(last(sent).interactive.type, 'button');
  assert.match(textOf(last(sent)), /I did not catch that/);
  assert.equal(await bidState.getBookingStage(redis, user.id), 'awaiting_trip_confirm', 'not moved on to the price');
});

/* ── the trip FORM: one card, one button — confirm, edit and stops inside it ── */

const { handleEditTripFlow } = require('../apps/api-gateway/dist/whatsapp-flows/edit-trip-flow.js');
const { verifyFlowToken } = require('../apps/api-gateway/dist/whatsapp-flows/encryption.js');
const EDIT_TRIP_FLOW = require('../apps/api-gateway/src/whatsapp-flows/edit-trip-flow-definition.json');

/** A rider at the trip card, on a server where the form is published. */
async function riderWithForm(world = {}) {
  const at = await riderAtTripCard(
    { places: (query) => (/sabo/i.test(query) ? SABO : /gate/i.test(query) ? UNILAG_GATE : /market/i.test(query) ? [SABO, TEJUOSHO] : null), ...world },
    (deps) => { deps.whatsappEditTripFlowId = 'flow-edit-trip-1'; },
  );
  const formDeps = { redisClient: at.redis, googleMapsApiKey: 'test-key', routePlanner: at.deps.routePlanner, publisher: at.deps.publisher };
  const form = (action, data, screen) => handleEditTripFlow({ version: '3.0', action, flow_token: 'x', data, screen }, at.user.id, formDeps);
  const submit = (fields) => form('data_exchange', { action: 'edit_trip', pickup: AKOKA.address, stop_1: '', stop_2: '', stop_3: '', destination: YABA.address, ...fields });
  return { ...at, form, submit };
}

test('with the form published the trip card is ONE message with ONE button that opens it — no reply buttons, no second message', async () => {
  const { redis, deps, sent, who, user } = await riderWithForm();

  const card = last(sent).interactive;
  assert.equal(card.type, 'flow');
  assert.equal(card.action.parameters.flow_cta, 'Confirm or edit trip');
  assert.ok(card.action.parameters.flow_cta.length <= 20, "WhatsApp's limit for a form button");
  assert.equal(card.action.parameters.flow_id, 'flow-edit-trip-1');
  assert.equal(card.action.parameters.flow_action, 'data_exchange', 'opening it asks OUR server for the boxes, filled in');
  assert.equal(verifyFlowToken(card.action.parameters.flow_token, deps.jwtSecret), `edit:${user.id}`);
  assert.match(card.body.text, /Check your trip[\s\S]*Pickup: \*31 Emily Akinola[\s\S]*Destination: \*7 Osaro Isokpan[\s\S]*suggested fare ₦/);
  assert.match(card.body.text, /Form not opening\? Reply_ \*yes\*/, 'a phone that cannot open forms is told what to do');
  assert.equal(await bidState.getBookingStage(redis, user.id), 'awaiting_trip_confirm');

  // …and that promise is kept: "yes" confirms without the form — and the price is TYPED, never a web page.
  await say(deps, who, 'yes');
  assert.equal(last(sent).type, 'text');
  assert.match(textOf(last(sent)), /Trip confirmed[\s\S]*Send your offer \(e\.g\./);
});

test('if WhatsApp refuses the form message, the card falls back to reply buttons — never silence', async () => {
  const redis = memoryRedis();
  const { deps } = makeDeps(redis);
  deps.whatsappEditTripFlowId = 'flow-edit-trip-1';
  const { sent } = installWorld({ geocode: () => YABA, places: () => null, intent: () => ({ intent: 'other' }) });
  const send = global.fetch;
  global.fetch = async (url, init) => (String(url).includes('graph.facebook.com') && JSON.parse(init.body).interactive?.type === 'flow'
    ? { ok: false, status: 400, json: async () => ({}), text: async () => 'flow not published' }
    : send(url, init));
  const who = rider();
  await riderWithPickup(deps, redis, who);
  await say(deps, who, 'Osaro Isokpan street');
  assert.deepEqual(last(sent).interactive.action.buttons.map((b) => b.reply.title), ['Confirm trip', 'Add a stop', 'Edit trip']);
});

test('THE FORM: opens filled in; Confirm trip → the PRICE screen; Find drivers → "You have successfully bid" — the ride is out, and the chat gets NOTHING', async () => {
  const { redis, sent, user, form, submit, published } = await riderWithForm();

  const opened = await form('INIT');
  assert.equal(opened.screen, 'EDIT_TRIP');
  assert.deepEqual([opened.data.pickup, opened.data.stop_1, opened.data.destination, opened.data.has_error], [AKOKA.address, '', YABA.address, false]);

  const before = sent.length;
  const price = await submit({});
  assert.equal(price.screen, 'SET_PRICE');
  assert.match(price.data.limits_line, /Lowest for this trip: ₦[\d,]+ · suggested ₦[\d,]+/);
  assert.equal(price.data.suggested_price, String((await bidState.getPendingRoute(redis, user.id)).suggestedFareNgn), 'the box opens on the suggested fare');
  assert.equal((await bidState.getPendingRoute(redis, user.id)).confirmed, true);

  const low = await form('data_exchange', { action: 'set_price', price: '100' });
  assert.equal(low.screen, 'SET_PRICE');
  assert.match(low.data.error, /lowest price for this trip is ₦/);
  assert.equal(published.filter((p) => p.event?.eventType === 'RIDE_REQUESTED').length, 0);

  const out = await form('data_exchange', { price: '2,500' });          // no `action` tag: the payload's shape says it
  assert.equal(out.screen, 'DONE');
  assert.match(out.data.headline, /You have successfully bid ₦2,500/);
  const request = published.find((p) => p.event?.eventType === 'RIDE_REQUESTED').event;
  assert.deepEqual([request.riderOfferNgn, request.paymentMethod], [2500, 'WALLET']);
  assert.equal(await bidState.getActiveRide(redis, user.id), request.rideId, 'the search is live');
  assert.equal(sent.length, before, 'not one chat message: the next thing the chat hears is a driver\'s offer');

  // A double tap on Find drivers is one search — the second is told it is already out.
  assert.match((await form('data_exchange', { action: 'set_price', price: '2500' })).data.headline, /Already searching/);
  assert.equal(published.filter((p) => p.event?.eventType === 'RIDE_REQUESTED').length, 1);
});

test('THE FORM: a new pickup AND a stop in one go → they SEE the new trip and fare before it is priced → Confirm → the price step, stops included', async () => {
  const { redis, sent, user, form, submit, deps, who, published } = await riderWithForm();
  const before = sent.length;

  const review = await submit({ pickup: 'unilag main gate', stop_1: 'sabo market' });
  assert.equal(review.screen, 'REVIEW_TRIP');
  assert.match(review.data.pickup_line, /UNILAG Main Gate/);
  assert.deepEqual([review.data.has_stop_1, review.data.has_stop_2], [true, false]);
  assert.match(review.data.stop_1_line, /Stop 1: Sabo Market/);
  assert.match(review.data.summary_line, /km · ~\d+ min · suggested fare ₦/);
  assert.equal(sent.length, before, 'nothing sent to the chat while they are still in the form');

  // Saved, NOT confirmed: if they swipe the form away here, the chat and the form still agree on the trip.
  const saved = await bidState.getPendingRoute(redis, user.id);
  assert.match(saved.pickupAddress, /UNILAG Main Gate/);
  assert.deepEqual(Object.keys(saved.stops[0]).sort(), ['address', 'lat', 'lng'], 'only what drivers need');
  assert.notEqual(saved.confirmed, true);
  assert.equal((await form('INIT')).data.stop_1, SABO.address, 're-opening shows the saved change');

  // An old cached copy of the form may drop our `action` tag: the screen it came from still says what it is.
  const price = await form('data_exchange', {}, 'REVIEW_TRIP');
  assert.equal(price.screen, 'SET_PRICE');
  assert.equal(sent.length, before, 'still nothing in the chat');

  await form('data_exchange', { action: 'set_price', price: '3000' });
  assert.equal(published.find((p) => p.event?.eventType === 'RIDE_REQUESTED').event.stops.length, 1, 'drivers see the stop');
  assert.equal(sent.length, before, 'two changes, a confirmation and a price: ZERO chat messages');

  // Emptying the box removes the stop (on a fresh booking).
  const again = await riderWithForm();
  await again.submit({ stop_1: 'sabo market' });
  const removed = await again.submit({ stop_1: '' });
  assert.equal(removed.data.has_stop_1, false);
  assert.deepEqual((await bidState.getPendingRoute(again.redis, again.user.id)).stops, []);
});

test('THE FORM: more than one match → a screen to pick from, in the same form — never a guess, never a chat message', async () => {
  const { redis, sent, user, form, submit } = await riderWithForm();
  const before = sent.length;

  const which = await submit({ stop_1: 'yaba market' });
  assert.equal(which.screen, 'PICK_PLACES');
  assert.deepEqual([which.data.show_stop_1, which.data.show_pickup, which.data.show_destination], [true, false, false]);
  assert.deepEqual(which.data.stop_1_options.map((o) => [o.id, o.title]), [['0', 'Sabo Market'], ['1', 'Tejuosho Market'], ['none', 'None of these']]);
  assert.ok(which.data.pickup_options.length >= 1, 'a hidden group still gets a data source (WhatsApp refuses an empty one)');

  assert.match((await form('data_exchange', { action: 'pick_places' })).data.error, /Pick the right stop 1/);
  const none = await form('data_exchange', { action: 'pick_places', pick_stop_1: 'none' });
  assert.equal(none.screen, 'PICK_PLACES');
  assert.match(none.data.error, /tap ← at the top and type the stop 1 again/);
  assert.equal((await bidState.getPendingRoute(redis, user.id)).stops ?? null, null, 'nothing saved');

  const picked = await form('data_exchange', { pick_stop_1: '1' });      // no `action` tag: the payload's shape says it
  assert.equal(picked.screen, 'REVIEW_TRIP');
  assert.match(picked.data.stop_1_line, /Tejuosho Market/);
  assert.equal(sent.length, before, 'still nothing in the chat — they have not confirmed');
});

test('THE FORM refuses out loud and keeps what they typed: unknown place, another city, the same place twice', async () => {
  const far = { lat: 7.3775, lng: 3.9470, address: 'Bodija Market, Ibadan', name: 'Bodija Market' };
  const { redis, sent, user, submit } = await riderWithForm({ places: (query) => (/bodija/i.test(query) ? far : /osaro/i.test(query) ? { ...YABA, name: 'Osaro Isokpan' } : null), geocode: (query) => (/nowhere/i.test(query) ? null : YABA) });
  const before = sent.length;

  const unknown = await submit({ stop_1: 'nowhere at all xyz' });
  assert.equal(unknown.screen, 'EDIT_TRIP');
  assert.match(unknown.data.error, /could not find "nowhere at all xyz" \(stop 1\)/);
  assert.equal(unknown.data.stop_1, 'nowhere at all xyz', 'their typing is not thrown away');

  assert.match((await submit({ stop_1: 'bodija market' })).data.error, /stop 1 I found \(Bodija Market, Ibadan\) is about \d+ km from your pickup/);
  assert.match((await submit({ stop_1: 'osaro isokpan' })).data.error, /stop 1 and your destination are the same place/);
  assert.match((await submit({ pickup: '' })).data.error, /needs a pickup and a destination/);
  assert.equal(sent.length, before, 'not one message to the chat in all of that');
  assert.equal((await bidState.getPendingRoute(redis, user.id)).stops ?? null, null);
});

test('THE FORM on a dead or running booking: it still OPENS on its first screen (WhatsApp allows no other) and says so; closing the form is not a message to answer', async () => {
  const { redis, deps, sent, who, user, form, submit } = await riderWithForm();

  // WhatsApp announces a closed form with an nfm_reply. The price step was sent on confirm — this gets no reply.
  const before = sent.length;
  const payload = { object: 'whatsapp_business_account', entry: [{ changes: [{ value: {
    contacts: [{ profile: { name: who.name }, wa_id: who.phone }],
    messages: [{ id: `wamid.nfm.${Date.now()}`, from: who.phone, type: 'interactive', interactive: { type: 'nfm_reply', nfm_reply: { name: 'flow', body: 'Sent', response_json: '{"flow_token":"x"}' } } }],
  } }] }] };
  const raw = Buffer.from(JSON.stringify(payload));
  await handleMetaWhatsappWebhookRoute({ method: 'POST', headers: {}, async *[Symbol.asyncIterator]() { yield raw; } }, { statusCode: 0, setHeader() {}, writeHead() { return this; }, end() {} }, deps);
  assert.equal(sent.length, before);

  await bidState.setActiveRide(redis, user.id, 'ride-out');
  const searching = await form('INIT');
  assert.equal(searching.screen, 'EDIT_TRIP');
  assert.match(searching.data.error, /Drivers are already looking at this trip/);
  assert.equal((await submit({ stop_1: 'sabo market' })).screen, 'DONE', 'and it edits nothing');
  assert.equal((await bidState.getPendingRoute(redis, user.id)).stops ?? null, null);

  await bidState.clearActiveRide(redis, user.id);
  await bidState.clearPendingRoute(redis, user.id);
  const expired = await form('INIT');
  assert.equal(expired.screen, 'EDIT_TRIP');
  assert.match(expired.data.error, /expired/);
  assert.match((await submit({})).data.headline, /expired/);
  assert.equal(sent.length, before);
});

/** What Meta would reject, or print literally, checked before it ever gets there. */
function checkFormJson(flow, screenIds) {
  const screens = Object.fromEntries(flow.screens.map((screen) => [screen.id, screen]));
  assert.deepEqual(Object.keys(screens), screenIds);
  assert.equal(flow.version, '5.1', 'the version the earlier flows proved on this account');
  for (const screen of flow.screens) {
    const bound = [...JSON.stringify(screen.layout).matchAll(/\$\{data\.([a-z0-9_]+)\}/g)].map((m) => m[1]);
    for (const name of bound) assert.ok(name in screen.data, `${screen.id} binds data.${name}, which it does not declare`);
    // v5.1 does not interpolate inside longer strings: a binding is the WHOLE value or it is printed literally.
    for (const value of JSON.stringify(screen.layout).match(/"[^"]*\$\{[^"]*"/g) ?? []) assert.match(value, /^"\$\{(data|form)\.[a-z0-9_]+\}"$/, `${screen.id}: ${value}`);
    const form = screen.layout.children[0];
    const inputs = form.children.filter((child) => child.name).map((child) => child.name);
    for (const used of [...JSON.stringify(form).matchAll(/\$\{form\.([a-z0-9_]+)\}/g)].map((m) => m[1])) assert.ok(inputs.includes(used), `${screen.id} sends form.${used}, which is not an input on it`);
  }
  // Forward-only, one entry: Meta rejects anything else.
  const order = Object.keys(flow.routing_model);
  for (const [from, tos] of Object.entries(flow.routing_model)) for (const to of tos) assert.ok(order.indexOf(to) > order.indexOf(from), `${from} → ${to} goes backwards`);
  const footer = (id) => screens[id].layout.children[0].children.find((child) => child.type === 'Footer');
  return { screens, footer };
}

test('the forms on Meta and the server agree: every binding exists, every box the server reads is sent, and the screens only go forward', () => {
  const fields = ['pickup', 'stop_1', 'stop_2', 'stop_3', 'destination'];
  const trip = checkFormJson(EDIT_TRIP_FLOW, ['EDIT_TRIP', 'PICK_PLACES', 'REVIEW_TRIP', 'SET_PRICE', 'DONE']);
  assert.equal(trip.footer('EDIT_TRIP').label, 'Confirm trip');
  assert.deepEqual(Object.keys(trip.footer('EDIT_TRIP')['on-click-action'].payload).sort(), ['action', ...fields].sort());
  assert.deepEqual(Object.keys(trip.footer('PICK_PLACES')['on-click-action'].payload).sort(), ['action', ...fields.map((f) => `pick_${f}`)].sort());
  assert.deepEqual(trip.footer('REVIEW_TRIP')['on-click-action'].payload, { action: 'confirm_trip' });
  assert.equal(trip.footer('SET_PRICE').label, 'Find drivers');
  assert.deepEqual(trip.footer('SET_PRICE')['on-click-action'].payload, { action: 'set_price', price: '${form.price}' });
  assert.equal(trip.footer('DONE')['on-click-action'].name, 'complete');

  const OFFERS_FORM = require('../apps/api-gateway/src/whatsapp-flows/offers-form-flow-definition.json');
  const offers = checkFormJson(OFFERS_FORM, ['OFFERS', 'CHANGE_PRICE', 'CANCEL_SEARCH', 'DONE']);
  assert.deepEqual(offers.footer('OFFERS')['on-click-action'].payload, { action: 'offers_choice', choice: '${form.choice}' });
  assert.deepEqual(offers.footer('CHANGE_PRICE')['on-click-action'].payload, { action: 'update_price', new_price: '${form.new_price}' });
  assert.deepEqual(offers.footer('CANCEL_SEARCH')['on-click-action'].payload, { action: 'cancel_search', reason: '${form.reason}' });
  assert.deepEqual(OFFERS_FORM.screens.filter((screen) => screen.terminal).map((screen) => screen.id), ['DONE']);
});

/* ── offers in the chat: tap one and it is yours ────────────────────────── */

/** Tap a reply BUTTON (an offer's "Accept ₦X"). */
async function tapButton(deps, who, id, title) {
  messageCounter += 1;
  const payload = {
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ value: {
      contacts: [{ profile: { name: who.name }, wa_id: who.phone }],
      messages: [{ id: `wamid.btn.${Date.now()}.${messageCounter}`, from: who.phone, type: 'interactive', interactive: { type: 'button_reply', button_reply: { id, title } } }],
    } }] }],
  };
  const raw = Buffer.from(JSON.stringify(payload));
  const req = { method: 'POST', headers: {}, async *[Symbol.asyncIterator]() { yield raw; } };
  const res = { statusCode: 0, setHeader() {}, writeHead() { return this; }, end() {} };
  await handleMetaWhatsappWebhookRoute(req, res, deps);
}

async function onlineDriver(name = 'Chinedu Okafor') {
  const user = await prisma.user.create({ data: { privyDid: `local:${Date.now()}-${Math.random()}`, role: 'DRIVER', name, phone: '+2348031234567' } });
  await prisma.wallet.create({ data: { userId: user.id, balanceNgn: 0 } });
  const driver = await prisma.driver.create({ data: { userId: user.id, status: 'ONLINE', kycStatus: 'APPROVED', lat: 6.52, lng: 3.38, lastSeenAt: new Date(), vehicleModel: 'Toyota Corolla', vehiclePlate: 'LND-174XA', totalRides: 412 } });
  return { userId: user.id, driverId: driver.id, name };
}
const offerFrom = (driver, priceNgn, extra = {}) => ({
  bidId: require('node:crypto').randomUUID(), driverId: driver.driverId, driverUserId: driver.userId, counterOfferNgn: priceNgn,
  driverName: driver.name, driverRating: 4.9, vehiclePlate: 'LND-174XA', vehicleModel: 'Toyota Corolla',
  etaSeconds: 240, distanceKm: 1.2, receivedAt: new Date().toISOString(), ...extra,
});

/** A rider whose price is out, with `walletNgn` in the wallet and the ride row ride-service would have written. */
async function searchingRider(walletNgn) {
  const redis = memoryRedis();
  const { deps, published } = makeDeps(redis);
  deps.appBaseUrl = 'https://app.wheelersng.com';
  const { sent } = installWorld({ geocode: () => YABA, places: () => null, intent: () => ({ intent: 'other' }) });
  const who = rider();
  const user = await riderWithPickup(deps, redis, who);
  await say(deps, who, 'Osaro Isokpan street');
  await say(deps, who, '2,000');
  const rideId = await bidState.getActiveRide(redis, user.id);
  assert.ok(rideId, 'the search is live');
  await prisma.ride.create({ data: { id: rideId, riderId: user.id, status: 'MATCHING', pickupLat: AKOKA.lat, pickupLng: AKOKA.lng, pickupAddress: AKOKA.address, destLat: YABA.lat, destLng: YABA.lng, destAddress: YABA.address } });
  await prisma.wallet.upsert({ where: { userId: user.id }, update: { balanceNgn: walletNgn }, create: { userId: user.id, balanceNgn: walletNgn } });
  const accepted = () => published.filter((p) => p.event?.eventType === 'RIDE_OFFER_ACCEPTED').map((p) => p.event);
  const publishedEvents = () => published.map((p) => p.event).filter(Boolean);
  return { redis, deps, sent, who, user, rideId, accepted, publishedEvents };
}
const offerId = (bid, shownPriceNgn = bid.counterOfferNgn) => `offer:${shownPriceNgn}:${bid.bidId}`;

test('TAP an offer with money in the wallet: fare held, ride confirmed — no "reply pay", no second step', async () => {
  const { redis, deps, sent, who, user, rideId, accepted } = await searchingRider(10_000);
  const bid = offerFrom(await onlineDriver(), 2400);
  await bidState.addBid(redis, rideId, bid);

  await tapButton(deps, who, offerId(bid), 'Accept ₦2,400');

  assert.deepEqual(accepted().map((e) => [e.rideId, e.bidId, e.agreedFareNgn, e.paymentMethod]), [[rideId, bid.bidId, 2400, 'WALLET']]);
  assert.equal(Number((await prisma.wallet.findUnique({ where: { userId: user.id } })).lockedNgn), 2400, 'the fare is held');
  assert.deepEqual(last(sent).interactive.action.buttons.map((b) => b.reply.title), ['Track live trip', '🆘 SOS'], 'the ride card');
  assert.match(textOf(last(sent)), /Ride confirmed & paid[\s\S]*Chinedu Okafor[\s\S]*LND-174XA/);
  assert.equal(sent.some((m) => /reply \*pay\*/i.test(textOf(m))), false);

  // A second tap on the same message: they are told their driver is coming, and nothing is charged twice.
  await tapButton(deps, who, offerId(bid), 'Accept ₦2,400');
  assert.match(textOf(last(sent)), /Chinedu Okafor\* is on the way/);
  assert.equal(accepted().length, 1);
});

test('a row tapped in the "Choose a driver" list, and a typed number, both take the offer the same way', async () => {
  for (const pick of ['row', 'number']) {
    const { redis, deps, who, rideId, accepted } = await searchingRider(10_000);
    const cheap = offerFrom(await onlineDriver('Aisha Bello'), 2200);
    const dear = offerFrom(await onlineDriver('Tunde Ade'), 2900);
    await bidState.addBid(redis, rideId, dear);
    await bidState.addBid(redis, rideId, cheap);

    if (pick === 'row') await tap(deps, who, offerId(cheap), '₦2,200 · Aisha');
    else {
      await say(deps, who, 'more');   // the list they would be answering: cheapest first
      await say(deps, who, '1');
    }
    assert.deepEqual(accepted().map((e) => [e.bidId, e.agreedFareNgn]), [[cheap.bidId, 2200]], pick);
  }
});

test('an OLD message must never hold a NEW price: the driver re-priced, so the tap shows the offers again instead', async () => {
  const { redis, deps, sent, who, user, rideId, accepted } = await searchingRider(10_000);
  const driver = await onlineDriver();
  const bid = offerFrom(driver, 2400);
  await bidState.addBid(redis, rideId, bid);
  await bidState.addBid(redis, rideId, { ...bid, counterOfferNgn: 3200 });     // same driver, dearer now

  await tapButton(deps, who, offerId(bid, 2400), 'Accept ₦2,400');

  assert.equal(accepted().length, 0);
  assert.equal(Number((await prisma.wallet.findUnique({ where: { userId: user.id } })).lockedNgn), 0, 'nothing was held');
  const fresh = last(sent).interactive;
  assert.match(fresh.body.text, /Chinedu Okafor changed their price to ₦3,200 \(it was ₦2,400\) — nothing was charged/);
  assert.equal(fresh.action.buttons[0].reply.title, 'Accept ₦3,200', 'and the new price is one tap away');

  // A driver who pulled out entirely.
  await bidState.removeBid(redis, rideId, driver.driverId);
  await tapButton(deps, who, offerId(bid, 3200), 'Accept ₦3,200');
  assert.match(textOf(last(sent)), /no longer on the table[\s\S]*Still asking drivers/);
  assert.equal(accepted().length, 0);
});

test('SHORT WALLET: the tap remembers the driver and sends ONE "Add money" button — and the deposit landing confirms the ride by itself', async () => {
  const { redis, deps, sent, who, user, rideId, accepted } = await searchingRider(400);
  const bid = offerFrom(await onlineDriver(), 2400);
  await bidState.addBid(redis, rideId, bid);

  await tapButton(deps, who, offerId(bid), 'Accept ₦2,400');

  assert.equal(accepted().length, 0, 'no ride on money that is not there');
  const ask = last(sent).interactive;
  assert.equal(ask.type, 'cta_url');
  assert.equal(ask.action.parameters.display_text, 'Add money');
  assert.match(ask.action.parameters.url, /\/widget\/wallet\/deposit\.html#t=/, 'the deposit flow — not the price page');
  assert.match(ask.body.text, /Add money to ride with Chinedu[\s\S]*Fare: ₦2,400 · your wallet: ₦400[\s\S]*Send \*₦2,051\* and ₦2,000 lands/, '(2000 + 30) / 0.99');
  assert.doesNotMatch(ask.body.text, /fee|charge|account number/i, 'one figure, no breakdown, no bank details in the chat');
  assert.equal((await bidState.getPendingAccept(redis, user.id)).bidId, bid.bidId);

  // The deposit page, opened from that button, skips "how much?".
  const { handleWalletPageRoute } = require('../apps/api-gateway/dist/http/wallet-page.route.js');
  const token = decodeURIComponent(ask.action.parameters.url.split('#t=')[1]);
  const res = { statusCode: 200, body: null, setHeader() {}, writeHead(code) { this.statusCode = code; return this; }, end(text) { this.body = text ? JSON.parse(text) : null; } };
  await handleWalletPageRoute({ method: 'GET', headers: { authorization: `Bearer ${token}` } }, res, { jwtSecret: deps.jwtSecret, redisClient: redis, paymentsClient: deps.paymentsClient, publisher: deps.publisher }, new URL('http://x/wallet-page/session'));
  assert.deepEqual(res.body.rideTopup, { driverName: 'Chinedu Okafor', fareNgn: 2400, landsNgn: 2000, sendNgn: 2051 });

  // They sent too little first: told what is still missing, the choice is kept.
  const finish = createWhatsappDepositFinisher(deps);
  await prisma.wallet.update({ where: { userId: user.id }, data: { balanceNgn: 1400 } });
  assert.equal(await finish({ userId: user.id, amountNgn: 1000, newBalanceNgn: 1400 }), true);
  assert.match(textOf(last(sent)), /₦1,000 received[\s\S]*not quite enough[\s\S]*Send \*₦1,041\* and ₦1,000 lands/);
  assert.equal(accepted().length, 0);

  // The rest lands: the ride confirms with nobody touching anything.
  await prisma.wallet.update({ where: { userId: user.id }, data: { balanceNgn: 2400 } });
  assert.equal(await finish({ userId: user.id, amountNgn: 1000, newBalanceNgn: 2400 }), true, 'the plain "deposit received" is not sent on top');
  assert.deepEqual(accepted().map((e) => [e.bidId, e.agreedFareNgn]), [[bid.bidId, 2400]]);
  assert.deepEqual(last(sent).interactive.action.buttons.map((b) => b.reply.title), ['Track live trip', '🆘 SOS'], 'the ride card');
  assert.equal(await bidState.getPendingAccept(redis, user.id), null);
});

test('money arrives but the driver did not wait: it stays in the wallet, they are told why, and the offers still there are one tap away', async () => {
  const { redis, deps, sent, who, user, rideId, accepted } = await searchingRider(0);
  const gone = await onlineDriver('Tunde Ade');
  const chosen = offerFrom(gone, 2400);
  const other = offerFrom(await onlineDriver('Aisha Bello'), 2600);
  await bidState.addBid(redis, rideId, chosen);
  await bidState.addBid(redis, rideId, other);
  await tap(deps, who, offerId(chosen), '₦2,400 · Tunde');
  await bidState.removeBid(redis, rideId, gone.driverId);

  const finish = createWhatsappDepositFinisher(deps);
  await prisma.wallet.update({ where: { userId: user.id }, data: { balanceNgn: 2400 } });
  assert.equal(await finish({ userId: user.id, amountNgn: 2400, newBalanceNgn: 2400 }), true);
  assert.equal(accepted().length, 0);
  assert.match(textOf(last(sent)), /₦2,400 received[\s\S]*Tunde Ade is no longer available[\s\S]*safe in your wallet/);
  assert.equal(last(sent).interactive.action.buttons[0].reply.title, 'Accept ₦2,600');
  assert.equal(await bidState.getPendingAccept(redis, user.id), null);

  // An ordinary deposit — nobody was chosen — is not ours to speak for.
  assert.equal(await finish({ userId: user.id, amountNgn: 500, newBalanceNgn: 2900 }), false);
});

test('the search ended while the transfer was on its way: said plainly, money kept, a way forward', async () => {
  const { redis, deps, sent, who, user, rideId } = await searchingRider(0);
  const bid = offerFrom(await onlineDriver(), 2400);
  await bidState.addBid(redis, rideId, bid);
  await tapButton(deps, who, offerId(bid), 'Accept ₦2,400');
  await bidState.clearActiveRide(redis, user.id);          // what the bid timeout does
  await bidState.cleanupRideKeys(redis, rideId);

  assert.equal(await createWhatsappDepositFinisher(deps)({ userId: user.id, amountNgn: 2400, newBalanceNgn: 2400 }), true);
  assert.match(textOf(last(sent)), /search ended while your transfer was on its way[\s\S]*safe in your wallet[\s\S]*search again/);

  // And a tap on the old message now says the same, instead of reaching the model as "Accept ₦2,400".
  await tapButton(deps, who, offerId(bid), 'Accept ₦2,400');
  assert.match(textOf(last(sent)), /That search has ended — nothing was charged/);
});

test('"cancel", then a tap on an offer instead of a reason: the tap wins — the ride is taken, not cancelled', async () => {
  const { redis, deps, who, rideId, accepted } = await searchingRider(10_000);
  const bid = offerFrom(await onlineDriver(), 2400);
  await bidState.addBid(redis, rideId, bid);
  await say(deps, who, 'cancel');
  await tapButton(deps, who, offerId(bid), 'Accept ₦2,400');
  assert.equal(accepted().length, 1);
});

/* ── the OFFERS FORM: accept, change price, decline all, cancel — one button, no extra messages ── */

const { handleOffersFormFlow } = require('../apps/api-gateway/dist/whatsapp-flows/offers-form-flow.js');
const offersNotifier = require('../apps/api-gateway/dist/whatsapp-flows/whatsapp-notifier.js');

/** A rider whose price is out, on a server where the offers form is published. */
async function riderWithOffersForm(walletNgn) {
  const at = await searchingRider(walletNgn);
  at.deps.whatsappOffersFormFlowId = 'flow-offers-form-1';
  const formDeps = { redisClient: at.redis, publisher: at.deps.publisher, ...createOffersFormChatHooks(at.deps) };
  const form = (action, data) => handleOffersFormFlow({ version: '3.0', action, flow_token: 'x', data }, at.user.id, formDeps);
  const events = (type) => at.publishedEvents().filter((e) => e.eventType === type);
  return { ...at, form, events };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 60));   // the chat is told without holding the form up

test('with the offers form published, offers are ONE message that says only HOW MANY drivers — and falls back to reply buttons if WhatsApp refuses it', async () => {
  const sent = [];
  global.fetch = async (_url, init) => { sent.push(JSON.parse(init.body)); return { ok: true, status: 200, text: async () => '' }; };
  const meta = { metaAccessToken: 't', metaPhoneNumberId: '1', offersFormFlowId: 'flow-offers-form-1', flowTokenSecret: 'test-secret-that-is-at-least-32-characters-long' };
  const driver = { driverId: 'd', userId: 'u', name: 'oke oyebade' };
  const one = [offerFrom(driver, 17000)];

  assert.equal(await offersNotifier.sendOffersInChat(meta, '+2348030000001', one, 17000, undefined, 'rider-1'), 'form');
  const message = sent[0].interactive;
  assert.equal(message.type, 'flow');
  assert.equal(message.action.parameters.flow_cta, 'See driver offers');
  assert.equal(verifyFlowToken(message.action.parameters.flow_token, meta.flowTokenSecret), 'bids:rider-1');
  assert.match(message.body.text, /\*1 driver found\* for your ₦17,000 offer/);
  assert.doesNotMatch(message.body.text, /oke oyebade|Camry|min away/, 'nothing that can go stale: who and how much live in the form');

  await offersNotifier.sendOffersInChat(meta, '+234', [...one, offerFrom(driver, 16000, { driverName: 'Aisha Bello' })], 17000, undefined, 'rider-1');
  assert.match(sent[1].interactive.body.text, /\*2 drivers found\*/);

  // Refused → the reply-button message, in the same call.
  sent.length = 0;
  global.fetch = async (_url, init) => { const body = JSON.parse(init.body); sent.push(body); return { ok: body.interactive.type !== 'flow', status: 200, text: async () => '' }; };
  assert.equal(await offersNotifier.sendOffersInChat(meta, '+234', one, 17000, undefined, 'rider-1'), 'buttons');
  assert.deepEqual(sent.map((m) => m.interactive.type), ['flow', 'button']);
  // No form published → reply buttons, as before.
  sent.length = 0;
  assert.equal(await offersNotifier.sendOffersInChat({ metaAccessToken: 't', metaPhoneNumberId: '1' }, '+234', one, 17000, undefined, 'rider-1'), 'buttons');
});

test('ONE unopened offers message at a time: more offers send nothing until the rider has opened the form — then the next offer buzzes again', async () => {
  const { announceOffers } = require('../apps/api-gateway/dist/kafka/consumer.js');
  const { redis, sent, user, rideId, form } = await riderWithOffersForm(10_000);
  const notifier = { metaAccessToken: 'meta-token', metaPhoneNumberId: '1234567890', offersFormFlowId: 'flow-offers-form-1', flowTokenSecret: 'test-secret-that-is-at-least-32-characters-long' };
  const consumerDeps = { redisClient: redis, whatsappNotifier: notifier };
  const first = offerFrom(await onlineDriver(), 2400);
  const second = offerFrom(await onlineDriver('Aisha Bello'), 2200);
  const offersMessages = () => sent.filter((m) => m.interactive?.type === 'flow' && m.interactive.action.parameters.flow_cta === 'See driver offers').length;

  await bidState.addBid(redis, rideId, first);
  await announceOffers(consumerDeps, '+2348030000001', rideId, user.id, [first], 2000);
  assert.equal(offersMessages(), 1);

  // A cheaper driver answers while that message sits unopened: no second message.
  await bidState.addBid(redis, rideId, second);
  await announceOffers(consumerDeps, '+2348030000001', rideId, user.id, [first, second], 2000, ['Aisha Bello joined at ₦2,200']);
  assert.equal(offersMessages(), 1, 'the form opens on the live list — the unopened message is still true');

  // They open the form: both drivers are there, cheapest first. Now they have looked.
  const opened = await form('INIT');
  assert.deepEqual(opened.data.choices.slice(0, 2).map((c) => c.title), ['₦2,200 · Aisha Bello', '₦2,400 · Chinedu Okafor']);
  const third = offerFrom(await onlineDriver('Tunde Ade'), 2100);
  await bidState.addBid(redis, rideId, third);
  await announceOffers(consumerDeps, '+2348030000001', rideId, user.id, [first, second, third], 2000);
  assert.equal(offersMessages(), 2, 'something new since they looked → one buzz');
  assert.match(textOf(last(sent)), /\*3 drivers found\*/);
});

test('OFFERS FORM · Change my price: a box, "Bid updated ✅" — drivers are told, and the chat gets NOTHING', async () => {
  const { redis, sent, rideId, form, events } = await riderWithOffersForm(10_000);
  await bidState.addBid(redis, rideId, offerFrom(await onlineDriver(), 2400));

  const opened = await form('INIT');
  assert.equal(opened.screen, 'OFFERS');
  assert.deepEqual(opened.data.choices.map((c) => c.title), ['₦2,400 · Chinedu Okafor', 'Change my price', 'Decline all', 'Cancel search']);
  assert.match(opened.data.offer_line, /Your price: ₦2,000/);

  const before = sent.length;
  const box = await form('data_exchange', { action: 'offers_choice', choice: 'change_price' });
  assert.equal(box.screen, 'CHANGE_PRICE');
  assert.equal(box.data.current_price, '2000', 'the box opens on their current price');

  const low = await form('data_exchange', { action: 'update_price', new_price: '100' });
  assert.equal(low.screen, 'CHANGE_PRICE');
  assert.match(low.data.error, /lowest price for this trip is ₦/);
  assert.equal(events('RIDE_RIDER_COUNTER_OFFER').length, 0);

  const updated = await form('data_exchange', { new_price: '2,800' });        // no `action` tag: the payload's shape says it
  assert.equal(updated.screen, 'DONE');
  assert.match(updated.data.headline, /Bid updated to ₦2,800/);
  assert.deepEqual(events('RIDE_RIDER_COUNTER_OFFER').map((e) => e.counterOfferNgn), [2800]);
  assert.equal((await bidState.getRideMeta(redis, rideId)).offerNgn, 2800);
  assert.equal(sent.length, before, 'not one chat message');
});

test('OFFERS FORM · Decline all keeps the search going; Cancel search asks why inside the form — neither sends a chat message', async () => {
  const { redis, sent, user, rideId, form, events } = await riderWithOffersForm(10_000);
  await bidState.addBid(redis, rideId, offerFrom(await onlineDriver(), 2400));
  const before = sent.length;

  const declined = await form('data_exchange', { action: 'offers_choice', choice: 'decline_all' });
  assert.equal(declined.screen, 'DONE');
  assert.match(declined.data.headline, /Offers declined/);
  assert.deepEqual(await bidState.getBids(redis, rideId), []);
  assert.equal(await bidState.getActiveRide(redis, user.id), rideId, 'still searching');
  assert.equal(events('RIDE_CANCELLED').length, 0);
  assert.deepEqual((await form('INIT')).data.choices.map((c) => c.id), ['change_price', 'cancel_search'], 'nothing to decline once nothing is on the table');

  const why = await form('data_exchange', { action: 'offers_choice', choice: 'cancel_search' });
  assert.equal(why.screen, 'CANCEL_SEARCH');
  assert.deepEqual(why.data.reasons.map((r) => r.id), ['1', '2', '3', '4']);
  assert.ok(why.data.reasons.every((r) => r.title.length <= 30));
  const cancelled = await form('data_exchange', { action: 'cancel_search', reason: '4' });
  assert.match(cancelled.data.headline, /Search cancelled/);
  assert.deepEqual(events('RIDE_CANCELLED').map((e) => [e.rideId, e.reason, e.cancelledBy]), [[rideId, 'Accidental request', 'rider']]);
  assert.equal(await bidState.getActiveRide(redis, user.id), null);
  assert.equal(sent.length, before, 'not one chat message for either');

  // The form can only OPEN on its first screen — a finished search says so there.
  const over = await form('INIT');
  assert.equal(over.screen, 'OFFERS');
  assert.match(over.data.error, /search has ended/);
  assert.deepEqual(over.data.choices.map((c) => c.id), ['close']);
});

test('OFFERS FORM · picking a driver: fare held, ride confirmed, and the chat gets the driver card — a re-priced offer is refused, a short wallet gets the Add money button', async () => {
  const { redis, sent, user, rideId, form, events } = await riderWithOffersForm(3_000);
  const driver = await onlineDriver();
  const bid = offerFrom(driver, 2400);
  const dear = offerFrom(await onlineDriver('Tunde Ade'), 9000);
  await bidState.addBid(redis, rideId, bid);
  await bidState.addBid(redis, rideId, dear);

  // The screen was left open while the driver re-priced: the old price is never held.
  await bidState.addBid(redis, rideId, { ...bid, counterOfferNgn: 2900 });
  const stale = await form('data_exchange', { action: 'offers_choice', choice: `offer:2400:${bid.bidId}` });
  assert.equal(stale.screen, 'OFFERS');
  assert.match(stale.data.error, /changed their price to ₦2,900 \(it was ₦2,400\)/);
  assert.equal(events('RIDE_OFFER_ACCEPTED').length, 0);

  // More than the wallet holds: the choice is remembered and ONE Add money button goes to the chat.
  const short = await form('data_exchange', { action: 'offers_choice', choice: `offer:9000:${dear.bidId}` });
  assert.equal(short.screen, 'DONE');
  assert.match(short.data.headline, /Add ₦6,000 to ride with Tunde/);
  assert.equal(last(sent).interactive.action.parameters.display_text, 'Add money');
  assert.equal((await bidState.getPendingAccept(redis, user.id)).bidId, dear.bidId);
  assert.equal(events('RIDE_OFFER_ACCEPTED').length, 0);

  const ok = await form('data_exchange', { action: 'offers_choice', choice: `offer:2900:${bid.bidId}` });
  assert.equal(ok.screen, 'DONE');
  assert.match(ok.data.headline, /Ride confirmed/);
  assert.deepEqual(events('RIDE_OFFER_ACCEPTED').map((e) => [e.bidId, e.agreedFareNgn]), [[bid.bidId, 2900]]);
  assert.equal(Number((await prisma.wallet.findUnique({ where: { userId: user.id } })).lockedNgn), 2900);
  await settle();
  assert.deepEqual(last(sent).interactive.action.buttons.map((b) => b.reply.title), ['Track live trip', '🆘 SOS'], 'the ride card');

  const after = await form('INIT');
  assert.match(after.data.error, /driver is already confirmed/);
});


/* ── always a way out ──────────────────────────────────────────────────── */

test('the second reply the bot cannot use brings buttons, not the same prompt again', async () => {
  const redis = memoryRedis();
  const { deps } = makeDeps(redis);
  const { sent } = installWorld({ geocode: () => YABA, places: () => null, intent: () => ({ intent: 'other' }) });
  const who = rider();
  const user = await riderWithPickup(deps, redis, who);
  await say(deps, who, 'Osaro Isokpan street');
  await tapButton(deps, who, 'trip_confirm', 'Confirm trip');

  await say(deps, who, 'hmm wetin be this');
  assert.equal(last(sent).type, 'text');
  assert.match(textOf(last(sent)), /Or reply \*change pickup\*, \*change destination\* or \*cancel\*/, 'the exits are named from the first miss');

  await say(deps, who, 'i no understand');
  assert.equal(last(sent).type, 'interactive');
  assert.deepEqual(last(sent).interactive.action.buttons.map((b) => b.reply.title), ['Change pickup', 'Change destination', 'Cancel ride']);

  // Tapping a button arrives as its title.
  await say(deps, who, 'Change destination');
  assert.equal(await bidState.getBookingStage(redis, user.id), 'editing_destination');
});

test('asking for help gets the buttons at once', async () => {
  const redis = memoryRedis();
  const { deps } = makeDeps(redis);
  const { sent } = installWorld({ geocode: () => YABA, places: () => null, intent: () => ({ intent: 'help' }) });
  const who = rider();
  await riderWithPickup(deps, redis, who);
  await say(deps, who, 'Osaro Isokpan street');
  await say(deps, who, 'abeg i need help with this thing');
  assert.equal(last(sent).type, 'interactive');
});

test('with the model down, the buttons and the plainest words still get the rider out', async () => {
  const redis = memoryRedis();
  const { deps } = makeDeps(redis);
  const { sent } = installWorld({ geocode: () => YABA, places: () => null, intent: () => 'down' });
  const who = rider();
  const user = await riderWithPickup(deps, redis, who);
  await say(deps, who, 'Osaro Isokpan street');

  await say(deps, who, 'Start again');
  assert.match(textOf(last(sent)), /start fresh/);
  assert.equal(await bidState.getBookingStage(redis, user.id), null);
});

/* ── the classifier's edges, no network ────────────────────────────────── */

test('a plain place never costs a model call; anything that might be more does', () => {
  for (const place of ['Shoprite Ikeja', 'No 7 osaro isokpan', 'Yaba', '15 Aiyetoro Street Akoka', 'unilag main gate']) {
    assert.equal(mightNotBeAnAddress(place), false, place);
  }
  for (const more of ['cancel first order', 'abeg leave am', 'start afresh', 'actually pick me from the gate', 'i dont understand', 'wrong place', 'book a ride', 'customer care']) {
    assert.equal(mightNotBeAnAddress(more), true, more);
  }
});

test('the model is told which address a resent place matches', () => {
  const shared = sharedPlaceWords('No 7 osaro isokpan Lagos', { pickupAddress: AKOKA.address, destinationAddress: BENIN.address });
  assert.deepEqual(shared.destination, ['isokpan']);
  assert.deepEqual(shared.pickup, [], '"Lagos" is in both — it says nothing about which');
});

test('the model\'s answer is used as-is; nonsense from it falls back safely', async () => {
  const saying = (answer) => ({ configured: true, completeJson: async () => answer });
  const ask = (groq, step, message) => classifyBookingIntent(groq, { step, message, context: {} });

  assert.deepEqual(await ask(saying({ intent: 'cancel', address: 'x' }), 'price', 'm'), { intent: 'cancel' }, 'an address only rides along with a change');
  assert.deepEqual(await ask(saying({ intent: 'change_destination', address: ' Yaba ' }), 'price', 'm'), { intent: 'change_destination', address: 'Yaba' });
  assert.deepEqual(await ask(saying({ intent: 'change_destination', address: 'Yaba' }), 'destination', 'm'), { intent: 'answer' }, 'asked for the destination and given one: that is the answer');
  for (const odd of [{ intent: 'book_everything' }, {}, null, { intent: 7 }]) {
    assert.equal((await ask(saying(odd), 'price', 'hello')).intent, 'other');
    assert.equal((await ask(saying(odd), 'destination', 'Yaba')).intent, 'answer');
  }
  const broken = { configured: true, completeJson: async () => { throw new Error('timeout'); } };
  assert.equal((await ask(broken, 'price', 'cancel this')).intent, 'cancel');
});
