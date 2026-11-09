// The booking page, live: it opens the socket with its link, draws each state the
// server sends at once (no request back), keeps a slow poll as the backup, and says
// Decline with one offer, Decline all with two or more. Runs the real
// widget/ride/ride.js (with wallet/common.js) on a stand-in DOM, as the other page tests.
//
//   node --test test/ride-page-live-webview.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const WIDGET = path.join(__dirname, '../apps/api-gateway/widget');
const COMMON = fs.readFileSync(path.join(WIDGET, 'wallet/common.js'), 'utf8');
const RIDE = fs.readFileSync(path.join(WIDGET, 'ride/ride.js'), 'utf8');

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
    click() { (listeners.click || []).forEach((fn) => fn({ preventDefault() {}, stopPropagation() {}, target: node })); if (node.onclick) node.onclick(); },
    fire(type, event) { (listeners[type] || []).forEach((fn) => fn(event || {})); },
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


const offer = (key, priceNgn) => ({ key, driverName: `Driver ${key}`, priceNgn });
function offerState(offers) {
  return { phase: 'offers', rideId: 'ride-1', balanceNgn: 50000, offerNgn: 2000, route: { pickupAddress: 'Yaba', destAddress: 'Lekki', stopAddresses: [] }, offers };
}
function server(offers) {
  const s = { state: offerState(offers), async answer(method, url) { return url.startsWith('/ride-page/state') ? { status: 200, json: s.state } : { status: 200, json: {} }; } };
  return s;
}
const stateGets = (page) => page.calls.filter((c) => c.url.startsWith('/ride-page/state')).length;

test('the page opens the socket with its own link', async () => {
  opened.length = 0;
  await loadPage(server([offer('A', 2000)]));
  assert.equal(opened.length, 1);
  assert.match(opened[0].url, /\/ws\?token=tok$/);
});

test('a state sent down the socket is drawn at once, with no request back', async () => {
  opened.length = 0;
  const page = await loadPage(server([offer('A', 2000)]));
  const ws = opened[0];
  ws.up();
  await page.settle();
  const before = stateGets(page);
  assert.equal(page.el('offers-title').textContent, '1 driver offer');
  ws.push('ride-page:state', offerState([offer('A', 2000), offer('B', 2300), offer('C', 2500)]));
  await page.settle();
  assert.equal(page.el('offers-title').textContent, '3 driver offers');
  assert.equal(stateGets(page), before, 'drawn from the socket alone');
});

test('the poll is the backup: every 10 s with the socket up, every 3 s without', async () => {
  opened.length = 0;
  const page = await loadPage(server([offer('A', 2000)]));
  assert.ok(page.timers.some((t) => t.ms === 3000), 'no socket yet: 3 s');
  opened[0].up();
  await page.settle();
  await page.poll();
  await page.settle();
  assert.ok(page.timers.some((t) => t.ms === 10000), 'socket up: 10 s');
});

test('Decline with one offer, Decline all with two or more', async () => {
  opened.length = 0;
  const one = await loadPage(server([offer('A', 2000)]));
  assert.equal(one.el('decline-all').textContent, 'Decline');
  const two = await loadPage(server([offer('A', 2000), offer('B', 2300)]));
  assert.equal(two.el('decline-all').textContent, 'Decline all');
  opened[opened.length - 1].up();
  opened[opened.length - 1].push('ride-page:state', offerState([offer('B', 2300)]));
  await two.settle();
  assert.equal(two.el('decline-all').textContent, 'Decline', 'down to one');
});
