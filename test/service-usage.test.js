// The outbound-call meter behind /admin/usage/services: every call to Google,
// Gemini, Groq, Paystack, Meta… is counted per service per day, in Redis, and
// nothing else changes about the call.
//
//   node --test --test-force-exit test/service-usage.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const usage = require('../apps/api-gateway/dist/usage/service-usage.js');

/** Just enough Redis for the hashes the meter writes. */
function memoryRedis() {
  const hashes = new Map();
  return {
    hashes,
    async send(cmd, key, ...args) {
      if (cmd === 'HINCRBY') { const h = hashes.get(key) ?? {}; h[args[0]] = (h[args[0]] ?? 0) + Number(args[1]); hashes.set(key, h); return h[args[0]]; }
      if (cmd === 'HGETALL') { const h = hashes.get(key); return h ? Object.entries(h).flatMap(([k, v]) => [k, String(v)]) : []; }
      if (cmd === 'EXPIRE') return 1;
      throw new Error(`unexpected ${cmd}`);
    },
  };
}

test('URLs are classified by vendor and product — and anything else is left alone', () => {
  const key = (url) => usage.classify(url)?.key ?? null;
  assert.equal(key('https://maps.googleapis.com/maps/api/geocode/json?address=x'), 'google_geocoding');
  assert.equal(key('https://places.googleapis.com/v1/places:autocomplete'), 'google_places');
  assert.equal(key('https://routes.googleapis.com/directions/v2:computeRoutes'), 'google_routes');
  assert.equal(key('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent'), 'gemini');
  assert.equal(key('https://api.groq.com/openai/v1/chat/completions'), 'groq');
  assert.equal(key('https://graph.facebook.com/v21.0/123/messages'), 'meta_whatsapp');
  assert.equal(key('https://api.paystack.co/transfer'), 'paystack');
  assert.equal(key('https://verify.twilio.com/v2/Services/x/Verifications'), 'twilio');
  assert.equal(key('https://api.resend.com/emails'), 'resend');
  assert.equal(key('https://app.wheelersng.com/webhooks/whatsapp-flow'), null, 'our own server');
  assert.equal(key('https://a.tile.openstreetmap.org/1/2/3.png'), null);
  assert.equal(key('not a url'), null);
});

test('the wrapped fetch counts calls, failures and time per service per day — and passes every call through untouched', async () => {
  const redis = memoryRedis();
  const seen = [];
  const realFetch = global.fetch;
  global.fetch = async (input, init) => {
    seen.push({ url: String(input), method: init?.method ?? 'GET' });
    if (String(input).includes('groq')) return { ok: false, status: 429 };
    if (String(input).includes('paystack')) throw new Error('network down');
    return { ok: true, status: 200 };
  };
  try {
    const original = usage.meterOutboundCalls(redis);
    assert.equal(usage.meterOutboundCalls(redis), original, 'wrapping twice would double-count: the second call is a no-op');

    assert.equal((await fetch('https://maps.googleapis.com/maps/api/geocode/json?address=Yaba', { method: 'GET' })).ok, true);
    await fetch('https://maps.googleapis.com/maps/api/geocode/json?address=Ikeja');
    assert.equal((await fetch('https://api.groq.com/openai/v1/chat/completions', { method: 'POST' })).status, 429, 'the response is the vendor\'s, not ours');
    await assert.rejects(() => fetch('https://api.paystack.co/transfer'), /network down/, 'a thrown error still throws');
    await fetch('https://app.wheelersng.com/health');
    await new Promise((r) => setTimeout(r, 20));      // the count is fire-and-forget

    const today = usage.dayKey();
    assert.deepEqual(seen.map((s) => s.method), ['GET', 'GET', 'POST', 'GET', 'GET'], 'every call went out exactly as asked');
    assert.equal(redis.hashes.get(`usage:google_geocoding:${today}`).calls, 2);
    assert.equal(redis.hashes.get(`usage:groq:${today}`).failed, 1, 'a 4xx/5xx is a failure');
    assert.equal(redis.hashes.get(`usage:paystack:${today}`).failed, 1, 'so is a network error');
    assert.equal([...redis.hashes.keys()].some((k) => k.includes('wheelersng')), false, 'our own server is not a "service"');

    const report = await usage.serviceUsage(redis, 7);
    const geo = report.find((s) => s.key === 'google_geocoding');
    assert.equal(geo.days.length, 7);
    assert.equal(geo.today.calls, 2);
    assert.equal(geo.totalCalls, 2);
    assert.equal(geo.days[0].calls, 0, 'zeros where nothing happened, so a chart has every day');
    assert.ok(geo.today.avgMs !== null && geo.today.avgMs >= 0);
    assert.match(geo.pricing, /\$5 per 1,000/);
    assert.equal(report.find((s) => s.key === 'resend').totalCalls, 0, 'every service is listed, called or not');
  } finally {
    global.fetch = realFetch;
  }
});
