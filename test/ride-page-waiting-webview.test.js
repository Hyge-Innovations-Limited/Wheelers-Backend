// Waiting time on the ride page (Timi, 12 Nov 2026): while the driver waits, the free minutes count down,
// then the fee ticks up (₦70 a minute after 5 free); after the start, one line says what it came to.
// The meter runs on the server's clock (state.trip.waiting.now), never the phone's.
//   node scripts/run-with-env.cjs node --test --test-force-exit test/ride-page-waiting-webview.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const WIDGET = path.join(__dirname, '../apps/api-gateway/widget');
const COMMON = fs.readFileSync(path.join(WIDGET, 'wallet/common.js'), 'utf8');
const RIDE = fs.readFileSync(path.join(WIDGET, 'ride/ride.js'), 'utf8');

function makeElement(id) {
  const listeners = {};
  const node = {
    id, lastChild: { textContent: '' }, parentNode: { classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } } }, children: [], style: {}, dataset: {}, textContent: '', get innerHTML() { return ''; }, set innerHTML(v) { if (v === '') node.children.length = 0; }, value: '', disabled: false,
    hidden: /^(sheet-|overlay)/.test(id || ''), className: '', onclick: null, scrollTop: 0, attrs: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener() {},
    appendChild(child) {
      const old = child.parentNode;
      if (old && old.children && old !== node) { const i = old.children.indexOf(child); if (i >= 0) old.children.splice(i, 1); }
      node.children.push(child); child.parentNode = node; return child;
    },
    removeChild() {}, insertBefore(child) { node.children.push(child); return child; },
    setAttribute(k, v) { node.attrs[k] = v; }, getAttribute(k) { return node.attrs[k] === undefined ? null : node.attrs[k]; },
    removeAttribute() {}, focus() {}, blur() {}, select() {}, scrollIntoView() {}, remove() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0 }; },
    click() { (listeners.click || []).forEach((fn) => fn({ preventDefault() {}, stopPropagation() {}, target: node })); if (node.onclick) node.onclick(); },
    fire(type, event) { (listeners[type] || []).forEach((fn) => fn(event || {})); },
    listeners,
  };
  return node;
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
  const copied = [];
  // A history that remembers every step: entries pushed, and how far back() / go(n) moved.
  const history = {
    stack: [null], moves: [],
    get state() { return this.stack[this.stack.length - 1]; },
    pushState(s) { this.stack.push(s); }, replaceState(s) { this.stack[this.stack.length - 1] = s; },
    under: false,
    // Like a browser, back() lands later: the state read in the meantime is still the old one.
    back() { this.go(-1); },
    go(n) { this.moves.push(n); setImmediate(() => { for (let i = 0; i < -n; i++) { if (this.stack.length > 1) this.stack.pop(); else this.under = true; } if (this.onMove) this.onMove(); }); },
    // Every entry this page pushed has been stepped back over, once, and none further.
    settled() { return this.stack.length === 1 && !this.under; },
  };
  const docListeners = {};
  const winListeners = {};
  history.onMove = () => (winListeners.popstate || []).forEach((fn) => fn({ state: history.state }));
  const document = {
    hidden: false, activeElement: null, body: makeElement('body'), head: makeElement('head'),
    getElementById(id) { return (elements[id] = elements[id] || makeElement(id)); },
    createElement() { return makeElement(''); },
    createElementNS() { return makeElement(''); },
    createTextNode(t) { return { textContent: t }; },
    querySelector() { return makeElement('q'); },
    querySelectorAll() { return []; },
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
    history,
    navigator: { clipboard: { writeText: async (text) => { copied.push(text); } }, geolocation: null, userAgent: 'test' },
    sessionStorage: { getItem() { return null; }, setItem() {} },
    location: window.location,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    requestAnimationFrame: (fn) => { timers.push({ fn, ms: 0 }); return 1; },
    URL, Intl, Symbol, Map, Set, parseFloat: parseFloat,
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
    calls, elements, settle, document, history, copied,
    toasts: () => document.getElementById('toasts').children.map((c) => c.textContent),
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
  return page;
}

function makeServer(state) {
  const server = {
    state,
    async answer(method, url) {
      if (url.startsWith('/ride-page/state')) return { status: 200, json: server.state };
      return { status: 200, json: {} };
    },
  };
  return server;
}
const AT = Date.parse('2026-11-12T10:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
/** The trip while the driver waits; `waitedS`: seconds since Arrived on the SERVER's clock. */
const arrived = (waitedS, extra = {}) => ({
  phase: 'confirmed', rideId: 'ride-1', balanceNgn: 1000, offerNgn: 12000,
  route: { pickupAddress: 'Unilag', destAddress: 'Ikorodu', stopAddresses: [] },
  driver: { name: 'Tunde Adebayo', rating: 4.9, fareNgn: 12000 },
  tripCode: '4821',
  trip: {
    status: 'ARRIVED',
    waiting: { freeSeconds: 300, ngnPerMinute: 70, now: iso(AT + waitedS * 1000), arrivedAt: iso(AT), stoppedAt: null, minutes: null, feeNgn: null, paid: null, ...extra },
  },
});

test('free waiting: the minutes left count down, a bar drains, "Then ₦70/min"', async () => {
  const page = await loadPage(makeServer(arrived(48)));
  assert.equal(page.el('d-wait').hidden, false);
  assert.equal(page.el('d-wait-label').textContent, 'Free waiting');
  assert.equal(page.el('d-wait-figure').textContent, '4:12');
  assert.equal(page.el('d-wait-note').textContent, 'Then ₦70/min');
  assert.equal(page.el('d-wait-bar').hidden, false);
  assert.equal(page.el('d-wait-fill').style.width, '84%');
  assert.equal(page.el('d-wait-dot').hidden, true);
  assert.equal(page.el('d-wait').attrs['aria-label'], 'Free waiting, 4:12 left');
  assert.equal(page.el('d-wait-done').hidden, true);
});

test('the phone\'s clock does not matter: the server\'s "now" sets the meter', async () => {
  // The phone thinks it is 2 hours later; the server says 48 s after Arrived.
  const server = makeServer(arrived(48));
  const page = await loadPage(server);
  await page.advanceClock(2 * 60 * 60 * 1000);
  server.state = arrived(50);
  await page.poll();
  assert.equal(page.el('d-wait-figure').textContent, '4:10');
});

test('after the free minutes: the fee ticks up, with the minutes and the rate', async () => {
  const page = await loadPage(makeServer(arrived(300 + 3 * 60 + 20)));
  assert.equal(page.el('d-wait-label').textContent, 'Waiting time');
  assert.equal(page.el('d-wait-figure').textContent, '₦210');
  assert.equal(page.el('d-wait-figure').className, 'wait-figure on');
  assert.equal(page.el('d-wait-note').textContent, '3 min · ₦70/min after 5 free');
  assert.equal(page.el('d-wait-bar').hidden, true);
  assert.equal(page.el('d-wait-dot').hidden, false, 'a live dot while it runs');
  assert.equal(page.el('d-wait').attrs['aria-label'], 'Waiting time 3 minutes, ₦210');
});

test('stopped (the driver was told it could not be collected): the figure stays, the dot goes', async () => {
  const page = await loadPage(makeServer(arrived(900, { stoppedAt: iso(AT + (300 + 4 * 60) * 1000) })));
  assert.equal(page.el('d-wait-figure').textContent, '₦280', 'frozen at the stop, not at now');
  assert.equal(page.el('d-wait-dot').hidden, true);
});

test('after the start: one line, paid from the wallet or to pay the driver; the card goes', async () => {
  const paid = arrived(0, { minutes: 4, feeNgn: 280, paid: true });
  paid.trip.status = 'IN_PROGRESS';
  const page = await loadPage(makeServer(paid));
  assert.equal(page.el('d-wait').hidden, true);
  assert.equal(page.el('d-wait-done').hidden, false);
  assert.equal(page.el('d-wait-done').textContent, 'Waiting time: 4 min · ₦280, paid from your wallet.');

  const unpaid = arrived(0, { minutes: 4, feeNgn: 280, paid: false });
  unpaid.trip.status = 'IN_PROGRESS';
  const second = await loadPage(makeServer(unpaid));
  assert.equal(second.el('d-wait-done').textContent, "Waiting time: 4 min · ₦280. Your wallet couldn't cover it, so pay your driver.");
});

test('no waiting data (an older server, not arrived yet, or the fee switched off): nothing shows', async () => {
  const none = arrived(0);
  delete none.trip.waiting;
  const page = await loadPage(makeServer(none));
  assert.equal(page.el('d-wait').hidden, true);
  assert.equal(page.el('d-wait-done').hidden, true);
  const off = await loadPage(makeServer(arrived(400, { ngnPerMinute: 0 })));
  assert.equal(off.el('d-wait').hidden, true);
  // Started inside the free minutes: no fee was written, so no line, and the meter is gone.
  const quick = arrived(200);
  quick.trip.status = 'IN_PROGRESS';
  const third = await loadPage(makeServer(quick));
  assert.match(third.el('trip-title').textContent, /Heading to/);
  assert.equal(third.el('d-wait').hidden, true);
  assert.equal(third.el('d-wait-done').hidden, true);
});

test('markup: the card sits under the driver, before the trip code', () => {
  const html = fs.readFileSync(path.join(WIDGET, 'ride/ride.html'), 'utf8');
  const confirmed = html.slice(html.indexOf('<section data-view="confirmed"'));
  assert.ok(confirmed.indexOf('id="d-wait"') > confirmed.indexOf('class="driver-row"'));
  assert.ok(confirmed.indexOf('id="d-wait"') < confirmed.indexOf('id="d-code-box"'));
  assert.match(confirmed, /id="d-wait" role="timer" hidden/);
  assert.doesNotMatch(confirmed.slice(confirmed.indexOf('id="d-wait"'), confirmed.indexOf('id="d-code-box"')), /style="/, 'no inline styles (the page\'s CSP)');
});
