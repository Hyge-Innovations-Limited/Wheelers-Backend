// The WhatsApp ride page: a declined driver's next bid shows again, and the rider can type their
// own price (booking, and raising during the search). Runs the real widget/ride/ride.js on a
// stand-in DOM, as the other page tests.
//
//   node --test test/ride-page-offer-typing-webview.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const WIDGET = path.join(__dirname, '../apps/api-gateway/widget');
const COMMON = fs.readFileSync(path.join(WIDGET, 'wallet/common.js'), 'utf8');
const RIDE = fs.readFileSync(path.join(WIDGET, 'ride/ride.js'), 'utf8');
const HTML = fs.readFileSync(path.join(WIDGET, 'ride/ride.html'), 'utf8');

const opened = [];
class FakeWebSocket {
  constructor(url) { this.url = url; opened.push(this); }
  close() { if (this.onclose) this.onclose(); }
  /** The server: the socket is up. */
  up() { this.onopen && this.onopen(); }
  push(type, payload) { this.onmessage && this.onmessage({ data: JSON.stringify({ type, payload }) }); }
}

function makeElement(id) {
  const listeners = {};
  const node = {
    id, parentNode: { classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } } }, children: [], style: {}, dataset: {}, textContent: '', value: '', disabled: false,
    hidden: /^(sheet-|overlay)/.test(id || ''), className: '', onclick: null, scrollTop: 0, attrs: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener() {},
    appendChild(child) { node.children.push(child); return child; },
    removeChild() {}, insertBefore(child) { node.children.push(child); return child; },
    setAttribute(k, v) { node.attrs[k] = v; }, getAttribute(k) { return node.attrs[k] === undefined ? null : node.attrs[k]; },
    removeAttribute() {}, focus() {}, blur() {}, select() {}, scrollIntoView() {}, remove() {},
    get lastChild() { return node.children[node.children.length - 1] || (node._last = node._last || makeElement('last')); }, get firstChild() { return node.children[0] || null; },
    querySelector() { return makeElement('q'); }, querySelectorAll() { return []; }, closest() { return null; }, contains() { return false; },
    getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0 }; },
    click() { (listeners.click || []).forEach((fn) => fn.call(node, { preventDefault() {}, stopPropagation() {}, target: node })); if (node.onclick) node.onclick(); },
    fire(type, event) { (listeners[type] || []).forEach((fn) => fn.call(node, event || {})); },
    listeners,
  };
  // innerHTML = '' empties the element, as in a browser.
  let html = '';
  Object.defineProperty(node, 'innerHTML', { get() { return html; }, set(v) { html = v; node.children.length = 0; } });
  return node;
}

function offerState(extra) {
  return {
    phase: 'offers', rideId: 'ride-1', balanceNgn: 5000, amountNgn: 2000, offerNgn: 2000,
    route: { pickupAddress: 'Yaba', destAddress: 'Lekki', stopAddresses: [] },
    offers: [
      { key: 'bid-A', driverName: 'Ada Driver', priceNgn: 2000 },
      { key: 'bid-B', driverName: 'Bayo Driver', priceNgn: 2200 },
    ],
    ...extra,
  };
}

/** The page, loaded. `server.state` is what /ride-page/state answers; `server.accept` answers /ride-page/accept. */
async function loadPage(server) {
  const elements = {};
  const timers = [];
  const clock = { skew: 0 };
  const RealDate = Date;
  class FakeDate extends RealDate {
    constructor(...args) { if (args.length) super(...args); else super(RealDate.now() + clock.skew); }
    static now() { return RealDate.now() + clock.skew; }
  }
  const calls = [];
  const docListeners = {};
  const winListeners = {};
  const document = {
    hidden: false, activeElement: null, body: makeElement('body'), head: makeElement('head'),
    getElementById(id) { return (elements[id] = elements[id] || makeElement(id)); },
    createElement() { return makeElement(''); },
    createElementNS() { return makeElement(''); },
    createTextNode(t) { return { textContent: t }; },
    querySelector() { return makeElement('q'); },
    querySelectorAll(selector) { return selector === '.trip-box' ? server.boxes || [] : []; },
    addEventListener(type, fn) { (docListeners[type] = docListeners[type] || []).push(fn); },
  };
  const fetchStub = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method: init.method || 'GET', url, body, keepalive: Boolean(init.keepalive) });
    const answer = await server.answer(init.method || 'GET', url, body);
    return { ok: answer.status === 200, status: answer.status, json: async () => answer.json };
  };
  const window = {
    location: { hash: '#t=tok', pathname: '/widget/ride/', search: '' },
    __wheelersToken: 'tok', document, scrollTo() {}, innerHeight: 800, innerWidth: 400,
    addEventListener(type, fn) { (winListeners[type] = winListeners[type] || []).push(fn); },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
  };
  const sandbox = {
    window, document, fetch: fetchStub, console, Promise, JSON, Math, Date: FakeDate, Object, Array, String, Number, Boolean, Error, RegExp, isFinite, parseFloat, parseInt, encodeURIComponent, decodeURIComponent,
    history: { state: null, pushState() {}, replaceState() {}, back() {} },
    navigator: { clipboard: null, geolocation: null, userAgent: 'test' },
    sessionStorage: { getItem() { return null; }, setItem() {} },
    location: window.location,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    requestAnimationFrame: (fn) => { timers.push({ fn, ms: 0 }); return 1; },
    URL, Intl, Symbol, Map, Set, parseFloat: parseFloat,
    WebSocket: FakeWebSocket,
  };
  sandbox.window.window = window;
  vm.createContext(sandbox);
  // The window's own globals the scripts read bare (like a browser).
  Object.assign(sandbox, { addEventListener: window.addEventListener, scrollTo() {} });
  vm.runInContext(COMMON, sandbox);
  vm.runInContext(RIDE, sandbox);
  const settle = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r)); };
  await settle();
  const page = {
    calls, elements, settle, document,
    el: (id) => document.getElementById(id),
    paying: () => calls.filter((c) => c.url === '/ride-page/paying').map((c) => `${c.body.offerKey}:${c.body.open ? 'open' : 'close'}`),
    async tap(target) { target.click(); await settle(); },
    /** The Accept button the page drew for an offer (the nth offer card). */
    acceptButtons() {
      const out = [];
      const walk = (node) => { (node.children || []).forEach((c) => { if (c.className && /accept/.test(c.className) && /^Accept/.test(c.textContent)) out.push(c); walk(c); }); };
      walk(document.getElementById('offer-list'));
      return out;
    },
    async poll() { page.runTimers(); await settle(); },
    // The page's own timers (polls, swipes); the 8 s limit on a paying request waits for fireLimit().
    runTimers() { const due = timers.filter((t) => t.ms !== 8000 && t.ms !== 20000); due.forEach((t) => timers.splice(timers.indexOf(t), 1)); due.forEach((t) => { try { t.fn(); } catch (e) { /* a timer of the page */ } }); },
    // The page's 20 s limit on its own requests (a hung accept).
    async fireRequestLimit() { const due = timers.filter((t) => t.ms === 20000); due.forEach((t) => timers.splice(timers.indexOf(t), 1)); due.forEach((t) => t.fn()); await settle(); },
    async advanceClock(ms) { clock.skew += ms; },
    async fireLimit() { const due = timers.filter((t) => t.ms === 8000); due.forEach((t) => timers.splice(timers.indexOf(t), 1)); due.forEach((t) => t.fn()); await settle(); },
    fireWindow(type, event) { (winListeners[type] || []).forEach((fn) => fn(event || {})); },
  };
  page.timers = timers;
  return page;
}




function declineButtons(page) {
  const out = [];
  const walk = (node) => { (node.children || []).forEach((c) => { if (c.className && /decline-one/.test(c.className)) out.push(c); walk(c); }); };
  walk(page.el('offer-list'));
  return out;
}
function cardPrices(page) {
  const out = [];
  const walk = (node) => { (node.children || []).forEach((c) => { if (c.className === 'price') out.push(c.textContent); walk(c); }); };
  walk(page.el('offer-list'));
  return out;
}
function bidsServer(offers) {
  const s = {
    offers,
    declineGate: null,
    base() { return { phase: 'offers', rideId: 'ride-1', balanceNgn: 9000, amountNgn: 5000, offerNgn: 5000, minOfferNgn: 4100, route: { pickupAddress: 'Yaba', destAddress: 'Lekki', stopAddresses: [] }, offers: s.offers }; },
    async answer(method, url) {
      if (url.startsWith('/ride-page/state')) return { status: 200, json: s.base() };
      if (url === '/ride-page/decline') {
        if (s.declineGate) await s.declineGate;
        s.offers = s.offers.filter((o) => o.key !== 'bid-A');
        return { status: 200, json: s.base() };
      }
      return { status: 200, json: {} };
    },
  };
  return s;
}
const bidA = (price, at) => ({ key: 'bid-A', driverName: 'Ada Driver', priceNgn: price, receivedAt: at });

test('declined, then the same driver bids the same price: the card is back with no reload, as new', async () => {
  const server = bidsServer([bidA(5000, 't1')]);
  const page = await loadPage(server);
  await page.poll();
  assert.deepEqual(cardPrices(page), ['\u20a65,000']);
  await page.tap(declineButtons(page)[0]);
  assert.deepEqual(cardPrices(page), [], 'declined: gone');
  server.offers = [bidA(5000, 't2')];
  await page.poll();
  assert.deepEqual(cardPrices(page), ['\u20a65,000'], 'the re-bid shows');
  const card = page.el('offer-list').children[0];
  assert.match(card.className, /\bin\b/, 'slides in as a new offer');
});

test('declined, then the same driver bids a different price: shows', async () => {
  const server = bidsServer([bidA(5000, 't1')]);
  const page = await loadPage(server);
  await page.poll();
  await page.tap(declineButtons(page)[0]);
  server.offers = [bidA(4800, 't2')];
  await page.poll();
  assert.deepEqual(cardPrices(page), ['\u20a64,800']);
});

test('the decline in flight: an answer that still holds the old bid does not bring the card back; a real re-bid does', async () => {
  const server = bidsServer([bidA(5000, 't1')]);
  const page = await loadPage(server);
  await page.poll();
  let release;
  server.declineGate = new Promise((r) => { release = r; });
  page.tap(declineButtons(page)[0]);
  await page.settle();
  await page.poll();                       // answered before the decline was processed: still has t1
  assert.deepEqual(cardPrices(page), [], 'no flash back');
  release();
  await page.settle();
  assert.deepEqual(cardPrices(page), []);
  server.offers = [bidA(5000, 't2')];
  await page.poll();
  assert.deepEqual(cardPrices(page), ['\u20a65,000'], 'the real re-bid shows');
});

test('an older answer still holding the declined bid (same time) leaves it hidden', async () => {
  const server = bidsServer([bidA(5000, 't1')]);
  const page = await loadPage(server);
  await page.poll();
  await page.tap(declineButtons(page)[0]);
  server.offers = [bidA(5000, 't1')];      // an older answer again
  await page.poll();
  assert.deepEqual(cardPrices(page), [], 'the old bid stays hidden');
});

test('a re-bid after a decline says "New offer"; a withdrawal after it says the offer ended', async () => {
  const server = bidsServer([bidA(5000, 't1')]);
  const page = await loadPage(server);
  await page.poll();
  await page.tap(declineButtons(page)[0]);
  server.offers = [bidA(5000, 't2')];
  await page.poll();
  assert.deepEqual(cardPrices(page), ['\u20a65,000']);
  const toasts = () => page.el('toasts').children.map((c) => c.textContent);
  assert.ok(toasts().includes('New offer'), 'toasts: ' + toasts());
  server.offers = [];
  await page.poll();
  assert.ok(toasts().some((t) => /Ada.s offer ended/.test(t)), 'toasts: ' + toasts());
});

/* ── typing the price ── */

function priceState(extra) {
  return { phase: 'price', balanceNgn: 0, minOfferNgn: 4100, route: { pickupAddress: 'Yaba', destAddress: 'Ikeja', stopAddresses: [], suggestedFareNgn: 5000 }, ...extra };
}
function priceOnly(extra) {
  const s = { state: priceState(extra), async answer(method, url) { return url.startsWith('/ride-page/state') ? { status: 200, json: s.state } : { status: 200, json: {} }; } };
  return s;
}
async function typeIn(page, figure, field, text) {
  await page.tap(page.el(figure));
  assert.equal(page.el(field).hidden, false, 'the box opens');
  assert.equal(page.el(figure).hidden, true);
  page.el(field).value = text;
  page.el(field).fire('blur');
  await page.settle();
  assert.equal(page.el(field).hidden, true);
}

test('markup: both figures tap to type, number keyboard, labelled', () => {
  for (const id of ['price', 'offer']) {
    assert.match(HTML, new RegExp(`<output[^>]*role="button"[^>]*aria-label="Type[^>]*id="${id}-figure"`));
    assert.match(HTML, new RegExp(`id="${id}-type" type="text" inputmode="numeric"[^>]*aria-label="Type`));
  }
});

test('booking: typed price rounds to the nearest 50; the lowest with one line; steps still work', async () => {
  const page = await loadPage(priceOnly());
  await typeIn(page, 'price-figure', 'price-type', '5,530');
  assert.equal(page.el('price-figure').textContent, '\u20a65,550');
  assert.equal(page.el('price-low').hidden, true);
  assert.equal(page.el('find').textContent, 'Find drivers at \u20a65,550');
  await typeIn(page, 'price-figure', 'price-type', '1000');
  assert.equal(page.el('price-figure').textContent, '\u20a64,100');
  assert.equal(page.el('price-low').hidden, false);
  assert.equal(page.el('price-low').textContent, 'Lowest is \u20a64,100');
  await page.tap(page.el('price-up'));
  assert.equal(page.el('price-figure').textContent, '\u20a64,200');
  assert.equal(page.el('price-low').hidden, true, 'the line goes with the next change');
  await typeIn(page, 'price-figure', 'price-type', '');
  assert.equal(page.el('price-figure').textContent, '\u20a64,200', 'empty: unchanged');
});

test('Enter finishes typing too, and the find sends the typed price', async () => {
  const page = await loadPage(priceOnly());
  await page.tap(page.el('price-figure'));
  page.el('price-type').value = '6120';
  page.el('price-type').fire('keydown', { key: 'Enter', preventDefault() {} });
  await page.settle();
  assert.equal(page.el('price-figure').textContent, '\u20a66,100');
  await page.tap(page.el('find'));
  assert.equal(page.calls.find((c) => c.url === '/ride-page/find').body.amountNgn, 6100);
});

test('raising during the search: New offer types the same way', async () => {
  const server = bidsServer([]);
  const page = await loadPage(server);
  await page.poll();
  await page.tap(page.el('change-offer'));
  await typeIn(page, 'offer-figure', 'offer-type', '4999');
  assert.equal(page.el('offer-figure').textContent, '\u20a65,000');
  await typeIn(page, 'offer-figure', 'offer-type', '100');
  assert.equal(page.el('offer-figure').textContent, '\u20a64,100');
  assert.equal(page.el('offer-low').textContent, 'Lowest is \u20a64,100');
  assert.equal(page.el('offer-save').textContent, 'Update price to \u20a64,100');
  await page.tap(page.el('offer-up'));
  assert.equal(page.el('offer-low').hidden, true);
});

test('Find tapped while the box is still open (no blur, no Enter) sends the typed amount', async () => {
  const page = await loadPage(priceOnly());
  await page.tap(page.el('price-figure'));
  page.el('price-type').value = '6000';
  await page.tap(page.el('find'));
  assert.equal(page.calls.find((c) => c.url === '/ride-page/find').body.amountNgn, 6000);
});

test('Update price tapped with the box open sends the typed amount to /ride-page/offer', async () => {
  const page = await loadPage(bidsServer([]));
  await page.poll();
  await page.tap(page.el('change-offer'));
  await page.tap(page.el('offer-figure'));
  page.el('offer-type').value = '5600';
  await page.tap(page.el('offer-save'));
  assert.equal(page.calls.find((c) => c.url === '/ride-page/offer').body.amountNgn, 5600);
});

test('typing under 50 (or nothing usable) leaves the price as it was', async () => {
  const page = await loadPage(priceOnly());
  await typeIn(page, 'price-figure', 'price-type', '20');
  assert.equal(page.el('price-figure').textContent, '\u20a65,000');
});

test('the figure names the amount for a screen reader', async () => {
  const page = await loadPage(priceOnly());
  assert.equal(page.el('price-figure').attrs['aria-label'], '\u20a65,000, tap to type your offer');
});

test('search again: the sheet types, and what is typed is what is sent; a tiny entry is never sent as zero', async () => {
  const server = {
    state: { phase: 'idle', balanceNgn: 0, lastSearch: { offerNgn: 5000, route: { pickupAddress: 'Yaba', destAddress: 'Lekki', stopAddresses: [], suggestedFareNgn: 5000 } } },
    async answer(method, url) { return url.startsWith('/ride-page/state') ? { status: 200, json: server.state } : { status: 200, json: {} }; },
  };
  const page = await loadPage(server);
  await page.tap(page.el('nd-other'));
  await page.tap(page.el('offer-figure'));
  page.el('offer-type').value = '3';
  await page.tap(page.el('offer-save'));
  assert.equal(page.calls.some((c) => c.url === '/ride-page/search-again' && !(c.body.amountNgn > 0)), false);
  await page.tap(page.el('offer-figure'));
  page.el('offer-type').value = '5230';
  await page.tap(page.el('offer-save'));
  assert.equal(page.calls.find((c) => c.url === '/ride-page/search-again').body.amountNgn, 5250);
});

test('a fresh quote closes an open typing box: the stale typed amount is not committed', async () => {
  const server = priceOnly();
  const page = await loadPage(server);
  await page.tap(page.el('price-figure'));
  page.el('price-type').value = '5000';
  server.state = priceState({ minOfferNgn: 7000, route: { pickupAddress: 'Yaba', destAddress: 'Epe', stopAddresses: [], suggestedFareNgn: 9000 } });
  await page.poll();
  assert.equal(page.el('price-type').hidden, true);
  assert.equal(page.el('price-figure').textContent, '\u20a69,000');
  await page.tap(page.el('find'));
  assert.equal(page.calls.find((c) => c.url === '/ride-page/find').body.amountNgn, 9000);
});

test('one line, not two: "Lowest is" hides the minimum hint; the next change, and re-opening, bring the hint back', async () => {
  const page = await loadPage(priceOnly());
  await typeIn(page, 'price-figure', 'price-type', '1000');
  assert.equal(page.el('price-low').hidden, false);
  assert.equal(page.el('price-hint').hidden, true);
  await page.tap(page.el('price-figure'));          // re-opened
  assert.equal(page.el('price-low').hidden, true);
  assert.equal(page.el('price-hint').hidden, false);
  page.el('price-type').value = '';                  // nothing usable: as it is
  page.el('price-type').fire('blur');
  await page.settle();
  assert.equal(page.el('price-hint').hidden, false);
  await typeIn(page, 'price-figure', 'price-type', '10');
  await typeIn(page, 'price-figure', 'price-type', '1000');
  await page.tap(page.el('price-up'));
  assert.equal(page.el('price-low').hidden, true);
  assert.equal(page.el('price-hint').hidden, false);
});

test('the sheet too: the minimum line is replaced by "Lowest is", then comes back', async () => {
  const page = await loadPage(bidsServer([]));
  await page.poll();
  await page.tap(page.el('change-offer'));
  assert.equal(page.el('offer-min').hidden, false);
  await typeIn(page, 'offer-figure', 'offer-type', '100');
  assert.equal(page.el('offer-low').hidden, false);
  assert.equal(page.el('offer-min').hidden, true);
  await page.tap(page.el('offer-up'));
  assert.equal(page.el('offer-low').hidden, true);
  assert.equal(page.el('offer-min').hidden, false);
});
