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
    get lastChild() { return node.children[node.children.length - 1] || (node._last = node._last || makeElement('last')); }, get firstChild() { return node.children[0] || null; },
    querySelector() { return makeElement('q'); }, querySelectorAll() { return []; }, closest() { return null; }, contains() { return false; },
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



/** One trip box as the page's markup has it: chips People n (1 → 4 → 1), Luggage and Pet (on / off), Note (opens the field). */
function tripBox() {
  const parts = {
    count: makeElement('count'), people: makeElement('people'), luggage: makeElement('luggage'), pet: makeElement('pet'),
    'note-open': makeElement('note-open'), note: makeElement('note'),
  };
  for (const k of ['people', 'luggage', 'pet', 'note-open']) {
    parts[k].attrs['data-trip'] = k;
    parts[k].closest = () => parts[k];
  }
  const box = makeElement('trip-box');
  box.querySelector = (selector) => {
    const m = /data-trip="([\w-]+)"/.exec(selector);
    return m ? parts[m[1]] : null;
  };
  box.querySelectorAll = () => [];
  const press = (b) => box.fire('click', { target: b });
  const on = (what) => parts[what].attrs['aria-pressed'] === 'true';
  const count = () => Number(parts.count.textContent);
  return {
    box, parts,
    /** One more person (a tap on the chip; past 4 it goes back to 1). */
    plus: () => press(parts.people),
    /** One fewer: three taps round the 1 → 4 → 1 circle. */
    minus: () => { if (count() > 1) for (let i = 0; i < 3; i++) press(parts.people); },
    yes: (what) => { if (!on(what)) press(parts[what]); },
    no: (what) => { if (on(what)) press(parts[what]); },
    openNote: () => press(parts['note-open']),
    type: (text) => { parts.note.value = text; parts.note.fire('input'); },
    pressed: (what) => [on(what) ? 'yes' : 'no'],
  };
}

function priceServer(boxes) {
  const s = {
    boxes,
    state: {
      phase: 'price', balanceNgn: 0, minOfferNgn: 4100, tripDetailsBox: true,
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
  // One row of chips: People, Luggage, Pet, Note.
  assert.deepEqual([...price.matchAll(/class="trip-chip" type="button" data-trip="([\w-]+)"/g)].map((m) => m[1]), ['people', 'luggage', 'pet', 'note-open']);
});

test('untouched: 1 person, luggage and pet Yes (the default), no note; what the rider sets goes with Find drivers', async () => {
  const a = tripBox();
  const b = tripBox();
  const page = await loadPage(priceServer([a.box, b.box]));
  assert.equal(a.parts.count.textContent, '1');
  assert.deepEqual(a.pressed('luggage'), ['yes']);
  assert.deepEqual(a.pressed('pet'), ['yes']);
  assert.equal(a.parts.note.hidden, true, 'the note field waits for its chip');

  for (let i = 0; i < 3; i++) a.plus();
  assert.equal(a.parts.count.textContent, '4', 'at most 4');
  a.plus();
  assert.equal(a.parts.count.textContent, '1', 'past 4 the chip goes back to 1');
  for (let i = 0; i < 3; i++) a.plus();
  a.minus();
  a.openNote();
  assert.equal(a.parts.note.hidden, false, 'the Note chip opens the field');
  a.no('luggage');
  a.no('pet');
  a.yes('pet');
  a.type('  Small dog   in a carrier ');
  assert.equal(b.parts.count.textContent, '3', 'one trip: the other box shows the same answers');
  assert.deepEqual(b.pressed('luggage'), ['no'], 'the No tapped in one box shows in the other');

  await page.tap(page.el('find'));
  const find = page.calls.find((c) => c.url === '/ride-page/find');
  assert.deepEqual(find.body.tripDetails, { passengers: 3, luggage: false, pet: true, note: 'Small dog in a carrier' });
});

test('Find drivers without touching the box sends the defaults, no note', async () => {
  const page = await loadPage(priceServer([tripBox().box]));
  await page.tap(page.el('find'));
  const find = page.calls.find((c) => c.url === '/ride-page/find');
  assert.deepEqual(find.body.tripDetails, { passengers: 1, luggage: true, pet: true });
});

test('what the rider said in the chat ("3 of us, with my dog") fills the box; once they change it, theirs stays', async () => {
  const a = tripBox();
  const server = priceServer([a.box]);
  server.state.tripDetails = { passengers: 3, luggage: false, pet: true };
  const page = await loadPage(server);
  assert.equal(a.parts.count.textContent, '3');
  assert.deepEqual(a.pressed('pet'), ['yes']);
  a.minus();
  await page.poll();
  assert.equal(a.parts.count.textContent, '2', 'a poll does not undo the rider');
  await page.tap(page.el('find'));
  assert.deepEqual(page.calls.find((c) => c.url === '/ride-page/find').body.tripDetails, { passengers: 2, luggage: false, pet: true });
});

test('after a search goes out the box starts again; Later after a search nobody took stays at the defaults', async () => {
  const a = tripBox();
  const server = priceServer([a.box]);
  const page = await loadPage(server);
  a.plus();
  a.no('pet');
  await page.tap(page.el('find'));
  assert.equal(a.parts.count.textContent, '1', 'the next trip does not carry this one\'s details');
  assert.deepEqual(a.pressed('pet'), ['yes']);

  // Nobody took it: Home with the last search (and its details). Later is a trip of its own.
  server.state = { phase: 'idle', balanceNgn: 50000, tripDetailsBox: true, canSchedule: true, lastSearch: { offerNgn: 5000, route: { pickupAddress: 'Yaba', destAddress: 'Ikeja City Mall' }, tripDetails: { passengers: 2, luggage: false, pet: true, note: 'Small dog' } } };
  await page.poll();
  await page.tap(page.el('home-later'));
  await page.poll();
  await page.poll();
  assert.equal(a.parts.count.textContent, '1', 'polls never put the last search\'s details back');
  assert.deepEqual(a.pressed('pet'), ['yes']);
  assert.equal(a.parts.note.value, '');
});

test('the rider changed the box, then another trip comes to price (from the chat): it starts at the defaults', async () => {
  const a = tripBox();
  const server = priceServer([a.box]);
  const page = await loadPage(server);
  a.plus();
  a.no('luggage');
  await page.poll();
  assert.equal(a.parts.count.textContent, '2', 'the same trip polled: theirs stays');
  server.state = { ...server.state, route: { ...server.state.route, destAddress: 'Lekki Phase 1' } };
  await page.poll();
  assert.equal(a.parts.count.textContent, '1');
  assert.deepEqual(a.pressed('luggage'), ['yes']);
});

test('the note is cut at 60 characters without breaking an emoji', async () => {
  const a = tripBox();
  const page = await loadPage(priceServer([a.box]));
  a.type('a'.repeat(59) + String.fromCodePoint(0x1f600));
  await page.tap(page.el('find'));
  assert.equal(page.calls.find((c) => c.url === '/ride-page/find').body.tripDetails.note, 'a'.repeat(59));
});

test('a server that does not take them (older, or switched off): no box, and Find sends none', async () => {
  const a = tripBox();
  const server = priceServer([a.box]);
  delete server.state.tripDetailsBox;
  const page = await loadPage(server);
  assert.equal(a.box.hidden, true);
  await page.tap(page.el('find'));
  assert.equal('tripDetails' in page.calls.find((c) => c.url === '/ride-page/find').body, false);
});

test('a different trip to price, with nothing said for it, starts at the defaults', async () => {
  const a = tripBox();
  const server = priceServer([a.box]);
  server.state.tripDetails = { passengers: 3, luggage: false, pet: false };
  const page = await loadPage(server);
  assert.equal(a.parts.count.textContent, '3');
  // The rider cancels and plans another trip: its price state says nothing about details.
  server.state = { ...server.state, route: { ...server.state.route, destAddress: 'Lekki' } };
  delete server.state.tripDetails;
  await page.poll();
  assert.equal(a.parts.count.textContent, '1');
  assert.deepEqual(a.pressed('pet'), ['yes']);
});

/** Set your price for a trip the page can change (Plan your trip over it), and the page's answers. */
function editableServer(boxes) {
  const s = priceServer(boxes);
  const YABA = { lat: 6.5095, lng: 3.3711, address: 'Yaba' };
  const MALL = { lat: 6.6018, lng: 3.3515, address: 'Ikeja City Mall' };
  s.state.canEditTrip = true;
  s.state.places = { pickup: YABA, destination: MALL, stops: [] };
  s.routeAnswer = null;
  const base = s.answer;
  s.answer = async (method, url, body) => {
    if (url === '/ride-page/route') return { status: 200, json: s.routeAnswer(body) };
    return base(method, url, body);
  };
  return s;
}

test('changing this trip from Set your price keeps what the rider set; re-saving it unchanged never carries it to another trip', async () => {
  const a = tripBox();
  const server = editableServer([a.box]);
  const page = await loadPage(server);
  a.plus();
  a.no('pet');
  // Edit (the destination), then Go: the server answers the changed trip.
  server.routeAnswer = () => (server.state = { ...server.state, route: { ...server.state.route, destAddress: 'Ikeja City Mall, Gate 2', suggestedFareNgn: 5400 } });
  await page.tap(page.el('route-edit'));
  await page.tap(page.el('plan-go'));
  assert.ok(page.calls.some((c) => c.url === '/ride-page/route'), 'the trip was changed through the page');
  assert.equal(a.parts.count.textContent, '2', 'the same booking: kept');
  assert.deepEqual(a.pressed('pet'), ['no']);

  // Saved again unchanged, then another trip arrives from the chat: it starts fresh.
  server.routeAnswer = () => server.state;
  await page.tap(page.el('route-edit'));
  await page.tap(page.el('plan-go'));
  server.state = { ...server.state, route: { ...server.state.route, destAddress: 'Lekki Phase 1' } };
  await page.poll();
  assert.equal(a.parts.count.textContent, '1');
  assert.deepEqual(a.pressed('pet'), ['yes']);
});

test('search again sends no trip details: the server sends the last search\'s', async () => {
  const a = tripBox();
  const server = priceServer([a.box]);
  server.state = { phase: 'idle', balanceNgn: 0, tripDetailsBox: true, lastSearch: { offerNgn: 5000, route: { pickupAddress: 'Yaba', destAddress: 'Ikeja City Mall' }, tripDetails: { passengers: 2, luggage: false, pet: true } } };
  const page = await loadPage(server);
  await page.tap(page.el('nd-again'));
  const again = page.calls.find((c) => c.url === '/ride-page/search-again');
  assert.ok(again, 'searched again');
  assert.equal('tripDetails' in again.body, false);
});
