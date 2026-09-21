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

const { handleMetaWhatsappWebhookRoute, placeChoiceRows } = require('../apps/api-gateway/dist/http/whatsapp.route.js');
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
    if (href.includes('/maps/api/place/')) {
      const params = new URL(href).searchParams;
      calls.places.push({ input: params.get('input'), bias: params.get('locationbias') });
      const place = world.places?.(params.get('input'), params.get('locationbias')) ?? null;
      return {
        ok: true,
        json: async () => (place
          ? { status: 'OK', candidates: [{ name: '', formatted_address: place.address, geometry: { location: place }, types: ['street_address'] }] }
          : { status: 'ZERO_RESULTS', candidates: [] }),
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
        planRoute: async ({ origin, destination }) => {
          const distanceKm = kmBetween(origin, destination) * 1.3;
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
test.after(async () => { await prisma.$disconnect(); });

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
  assert.deepEqual(rows.map((r) => r.description), ['Lekki', 'Lekki']);
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
  assert.equal(await bidState.getBookingStage(redis, user.id), 'awaiting_price');
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

/* ── searching near the pickup ─────────────────────────────────────────── */

test('a destination search leans towards the pickup, and asks Places before believing another city', async () => {
  const { calls } = installWorld({
    geocode: () => BENIN, // the street geocoder insists on Benin, bias or not
    places: (_q, bias) => (bias.startsWith('circle:') ? YABA : null),
    intent: () => ({ intent: 'other' }),
  });

  const [best] = await geocodeAddressCandidates('k', 'No 7 osaro isokpan', 3, { near: AKOKA });
  assert.equal(best.formattedAddress, YABA.address, 'the match 2 km away beats the one 245 km away');
  assert.match(calls.geocode[0].bounds, /^6\.02\d*,2\.88\d*\|7\.02\d*,3\.88\d*$/, 'Google was told where the trip is');
  assert.match(calls.places[0].bias, /^circle:50000@6\.5244,3\.387$/);

  const single = await geocodeAddress('k', 'No 7 osaro isokpan', { near: AKOKA });
  assert.equal(single.formattedAddress, YABA.address);

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
  assert.match(reply, /Suggested fare: ₦1,[0-9]{3}\b/, 'a city fare, not ₦97,100');
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
  assert.equal(await bidState.getBookingStage(redis, user.id), 'awaiting_price');

  // A different rider who really is going to Benin.
  const traveller = rider();
  const travellerUser = await riderWithPickup(deps, redis, traveller);
  await say(deps, traveller, 'Isokpan street');
  await say(deps, traveller, 'yes');
  assert.match(textOf(last(sent)), /Destination: \*Isokpan St, Use, Benin City/);
  assert.equal(await bidState.getBookingStage(redis, travellerUser.id), 'awaiting_price');
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

  await say(deps, who, 'ok book it');
  assert.match(textOf(last(sent)), /just tell me your price/);
  await say(deps, who, 'two thousand five hundred');
  assert.match(textOf(last(sent)), /send it in figures/);
  assert.equal(published.filter((p) => p.event?.eventType === 'RIDE_REQUESTED').length, 0, 'nothing was booked on a guess');
});

/* ── always a way out ──────────────────────────────────────────────────── */

test('the second reply the bot cannot use brings buttons, not the same prompt again', async () => {
  const redis = memoryRedis();
  const { deps } = makeDeps(redis);
  const { sent } = installWorld({ geocode: () => YABA, places: () => null, intent: () => ({ intent: 'other' }) });
  const who = rider();
  const user = await riderWithPickup(deps, redis, who);
  await say(deps, who, 'Osaro Isokpan street');

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
