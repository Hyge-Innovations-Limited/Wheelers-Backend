// The WhatsApp ride page's trip details box (people, luggage, pet, a note): what the
// rider sets is sent with Find drivers. Runs the real widget/ride/ride.js (with
// wallet/common.js) on a stand-in DOM, as the other page tests.
//
//   node --test test/ride-page-trip-details-webview.test.js

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
    id, parentNode: { classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } } }, children: [], style: {}, dataset: {}, textContent: '', innerHTML: '', value: '', disabled: false,
    hidden: /^(sheet-|overlay)/.test(id || ''), className: '', onclick: null, scrollTop: 0, attrs: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener() {},
    appendChild(child) { node.children.push(child); return child; },
    removeChild() {}, insertBefore(child) { node.children.push(child); return child; },
    setAttribute(k, v) { node.attrs[k] = v; }, getAttribute(k) { return node.attrs[k] === undefined ? null : node.attrs[k]; },
    removeAttribute() {}, focus() {}, blur() {}, select() {}, scrollIntoView() {}, remove() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0 }; },
    click() { (listeners.click || []).forEach((fn) => fn.call(node, { preventDefault() {}, stopPropagation() {}, target: node })); if (node.onclick) node.onclick(); },
    fire(type, event) { (listeners[type] || []).forEach((fn) => fn.call(node, event || {})); },
    listeners,
  };
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



/** One trip box as the page's markup has it: People − n +, Luggage No/Yes, Pet No/Yes, the note. */
function tripBox() {
  const parts = {
    count: makeElement('count'), minus: makeElement('minus'), plus: makeElement('plus'), note: makeElement('note'),
  };
  parts.minus.attrs['data-trip'] = 'minus';
  parts.plus.attrs['data-trip'] = 'plus';
  const seg = [];
  for (const what of ['luggage', 'pet']) for (const val of ['no', 'yes']) {
    const b = makeElement(`${what}-${val}`);
    b.attrs['data-trip'] = what;
    b.attrs['data-val'] = val;
    seg.push(b);
  }
  for (const b of [parts.minus, parts.plus, ...seg]) b.closest = () => b;
  const box = makeElement('trip-box');
  box.querySelector = (selector) => {
    const m = /data-trip="(\w+)"/.exec(selector);
    return m ? parts[m[1]] : null;
  };
  box.querySelectorAll = (selector) => (selector === '[data-val]' ? seg : []);
  const press = (b) => box.fire('click', { target: b });
  return {
    box, parts, seg,
    plus: () => press(parts.plus),
    minus: () => press(parts.minus),
    yes: (what) => press(seg.find((b) => b.attrs['data-trip'] === what && b.attrs['data-val'] === 'yes')),
    no: (what) => press(seg.find((b) => b.attrs['data-trip'] === what && b.attrs['data-val'] === 'no')),
    type: (text) => { parts.note.value = text; parts.note.fire('input'); },
    pressed: (what) => seg.filter((b) => b.attrs['data-trip'] === what && b.attrs['aria-pressed'] === 'true').map((b) => b.attrs['data-val']),
  };
}

function priceServer(boxes) {
  const s = {
    boxes,
    state: {
      phase: 'price', balanceNgn: 0, minOfferNgn: 4100,
      route: { pickupAddress: 'Yaba', destAddress: 'Ikeja City Mall', stopAddresses: [], suggestedFareNgn: 5000, distanceKm: 14.2, durationMin: 38 },
    },
    async answer(method, url) {
      if (url.startsWith('/ride-page/state')) return { status: 200, json: s.state };
      if (url === '/ride-page/find') return { status: 200, json: { ...s.state, phase: 'offers', rideId: 'ride-1', offerNgn: 5000, offers: [] } };
      return { status: 200, json: {} };
    },
  };
  return s;
}

test('the box is on Set your price and on the ride for later\'s confirm, before the price', () => {
  assert.equal((HTML.match(/class="trip-box"/g) || []).length, 2);
  const price = HTML.slice(HTML.indexOf('data-view="price"'), HTML.indexOf('data-view="offers"'));
  assert.ok(price.indexOf('trip-box') > 0 && price.indexOf('trip-box') < price.indexOf('price-card'));
  assert.match(price, /placeholder="Note for driver \(optional\)"/);
});

test('untouched: 1 person, no luggage, no pet, no note; what the rider sets goes with Find drivers', async () => {
  const a = tripBox();
  const b = tripBox();
  const page = await loadPage(priceServer([a.box, b.box]));
  assert.equal(a.parts.count.textContent, '1');
  assert.equal(a.parts.minus.disabled, true);
  assert.deepEqual(a.pressed('luggage'), ['no']);
  assert.deepEqual(a.pressed('pet'), ['no']);

  for (let i = 0; i < 6; i++) a.plus();
  assert.equal(a.parts.count.textContent, '4', 'at most 4');
  assert.equal(a.parts.plus.disabled, true);
  a.minus();
  a.yes('luggage');
  a.yes('pet');
  a.no('pet');
  a.yes('pet');
  a.type('  Small dog   in a carrier ');
  assert.equal(b.parts.count.textContent, '3', 'one trip: the other box shows the same answers');
  assert.deepEqual(b.pressed('luggage'), ['yes']);

  await page.tap(page.el('find'));
  const find = page.calls.find((c) => c.url === '/ride-page/find');
  assert.deepEqual(find.body.tripDetails, { passengers: 3, luggage: true, pet: true, note: 'Small dog in a carrier' });
});

test('Find drivers without touching the box sends the defaults, no note', async () => {
  const page = await loadPage(priceServer([tripBox().box]));
  await page.tap(page.el('find'));
  const find = page.calls.find((c) => c.url === '/ride-page/find');
  assert.deepEqual(find.body.tripDetails, { passengers: 1, luggage: false, pet: false });
});
