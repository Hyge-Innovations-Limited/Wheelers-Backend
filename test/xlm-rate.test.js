// The XLM price: asked for once, then kept for 30 minutes — a rider paying in
// XLM sees one rate for half an hour — and asked for again after that.
//
//   npm -w @wheleers/api-gateway run build && node --test test/xlm-rate.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRateProvider, FRESH_MS } = require('../apps/api-gateway/dist/stellar/rates.js');

test('the price is refreshed every 30 minutes, not on every look', async () => {
  assert.equal(FRESH_MS, 30 * 60 * 1000);
  let clock = Date.parse('2026-10-01T12:00:00Z');
  let asked = 0;
  let price = 1800;
  const fetcher = async (url) => {
    if (url.includes('coingecko')) { asked += 1; return { ok: true, json: async () => ({ stellar: { ngn: price } }) }; }
    return { ok: false, json: async () => ({}) };   // the Stellar market path is down: CoinGecko answers
  };
  const rates = createRateProvider({ fetcher, now: () => clock });

  assert.equal((await rates.current()).ngnPerXlm, 1800);
  price = 1900;
  clock += 29 * 60 * 1000;
  assert.equal((await rates.current()).ngnPerXlm, 1800, 'inside 30 minutes: the same rate');
  assert.equal(asked, 1);
  clock += 2 * 60 * 1000;
  assert.equal((await rates.current()).ngnPerXlm, 1900, 'after 30 minutes: asked again');
  assert.equal(asked, 2);
});
