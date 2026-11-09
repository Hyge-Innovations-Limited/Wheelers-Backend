// The ride page's pay sheet tells the server "the rider is paying this driver" (POST /ride-page/paying)
// so the driver's card can say so. The rider sees nothing of it. Runs the real widget/ride/ride.js
// (with the real wallet/common.js) against a small stand-in DOM and a fake server.
//
//   node scripts/run-with-env.cjs node --test --test-force-exit --test-reporter=tap test/ride-page-paying-signal.test.js

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
  return page;
}

function makeServer(opts = {}) {
  const server = {
    state: offerState(),
    payingStatus: opts.payingStatus || 200, hold: false, held: [],
    accept: opts.accept || (() => ({ status: 200, json: { ...offerState(), phase: 'confirmed' } })),
    async answer(method, url, body) {
      if (url.startsWith('/ride-page/state')) return { status: 200, json: server.state };
      if (url === '/ride-page/paying' && server.hold) return new Promise((resolve) => { server.held.push(() => resolve({ status: 200, json: { ok: true } })); });
      if (url === '/ride-page/paying') return { status: server.payingStatus, json: server.payingStatus === 200 ? { ok: true } : { error: 'x' } };
      if (url === '/ride-page/accept') return server.accept(body);
      if (url === '/ride-page/keep-looking') return { status: 200, json: server.state };
      return { status: 200, json: {} };
    },
  };
  return server;
}

async function onPaySheet(opts) {
  const server = makeServer(opts);
  const page = await loadPage(server);
  const buttons = page.acceptButtons();
  assert.equal(buttons.length, 2, 'two offers drawn');
  return { server, page, buttons };
}

test('opening the pay sheet posts open once; Back closes it once', async () => {
  const { page, buttons } = await onPaySheet();
  await page.tap(buttons[0]);
  assert.equal(page.el('sheet-pay').hidden, false);
  assert.deepEqual(page.paying(), ['bid-A:open']);
  await page.tap(page.el('overlay'));
  assert.deepEqual(page.paying(), ['bid-A:open', 'bid-A:close']);
  await page.tap(page.el('overlay'));
  assert.deepEqual(page.paying(), ['bid-A:open', 'bid-A:close'], 'a second put-away sends nothing');
});

test('swipe down on the pay sheet closes it once', async () => {
  const { page, buttons } = await onPaySheet();
  await page.tap(buttons[0]);
  const sheet = page.el('sheet-pay');
  sheet.fire('touchstart', { touches: [{ clientY: 100 }] });
  sheet.fire('touchmove', { touches: [{ clientY: 260 }], cancelable: true, preventDefault() {} });
  sheet.fire('touchend', {});
  page.runTimers();
  await page.settle();
  assert.deepEqual(page.paying(), ['bid-A:open', 'bid-A:close']);
});

test('choosing another driver closes the old sheet, then opens the new one', async () => {
  const { page, buttons } = await onPaySheet();
  await page.tap(buttons[0]);
  await page.tap(page.el('overlay'));
  await page.tap(buttons[1]);
  assert.deepEqual(page.paying(), ['bid-A:open', 'bid-A:close', 'bid-B:open']);
  await page.tap(page.el('overlay'));
  assert.deepEqual(page.paying(), ['bid-A:open', 'bid-A:close', 'bid-B:open', 'bid-B:close']);
});

test('booked sends no close: booking ends it on the server', async () => {
  const { page, buttons } = await onPaySheet();
  await page.tap(buttons[0]);
  await page.tap(page.el('pay-go'));
  assert.equal(page.calls.filter((c) => c.url === '/ride-page/accept').length, 1);
  await page.poll();
  page.fireWindow('pagehide');
  await page.settle();
  assert.deepEqual(page.paying(), ['bid-A:open']);
});

test('a short wallet moves to add-money on the same sheet: still one open, then one close on Back', async () => {
  const { page, buttons } = await onPaySheet({
    accept: () => ({ status: 402, json: { code: 'WALLET_SHORT', error: 'Add money', fareNgn: 2000, sendNgn: 500, balanceNgn: 1500, account: { bankName: 'B', accountNumber: '1', accountName: 'N' } } }),
  });
  await page.tap(buttons[0]);
  await page.tap(page.el('pay-go'));
  assert.deepEqual(page.paying(), ['bid-A:open'], 'add-money keeps the same open');
  await page.tap(page.el('overlay'));
  assert.deepEqual(page.paying(), ['bid-A:open', 'bid-A:close']);
  assert.ok(page.calls.some((c) => c.url === '/ride-page/keep-looking'), 'keep looking still goes as before');
});

test('a refused accept closes once', async () => {
  const { page, buttons } = await onPaySheet({ accept: () => ({ status: 409, json: { code: 'OFFER_GONE', error: 'Gone' } }) });
  await page.tap(buttons[0]);
  await page.tap(page.el('pay-go'));
  assert.deepEqual(page.paying(), ['bid-A:open', 'bid-A:close']);
});

test('the search ending under an open sheet closes it once', async () => {
  const { server, page, buttons } = await onPaySheet();
  await page.tap(buttons[0]);
  server.state = { phase: 'idle' };
  await page.poll();
  assert.deepEqual(page.paying(), ['bid-A:open', 'bid-A:close']);
  await page.poll();
  assert.deepEqual(page.paying(), ['bid-A:open', 'bid-A:close']);
});

test('page hide closes an open sheet at once, with keepalive, once', async () => {
  const { page, buttons } = await onPaySheet();
  await page.tap(buttons[0]);
  page.fireWindow('pagehide');
  page.fireWindow('pagehide');
  await page.settle();
  assert.deepEqual(page.paying(), ['bid-A:open', 'bid-A:close']);
  assert.ok(page.calls.filter((c) => c.url === '/ride-page/paying').every((c) => c.keepalive));
});

test('every non-200 answer is silent: no retry, nothing on screen, the pay flow goes on', async () => {
  for (const status of [404, 409, 429]) {
    const { page, buttons } = await onPaySheet({ payingStatus: status, accept: () => ({ status: 409, json: { code: 'OFFER_GONE', error: 'Gone' } }) });
    await page.tap(buttons[0]);
    assert.equal(page.el('sheet-pay').hidden, false);
    await page.tap(page.el('pay-go'));
    await page.settle();
    assert.equal(page.paying().length, 2, `status ${status}: one open, one close, no retries`);
    assert.equal(page.calls.filter((c) => c.url === '/ride-page/accept').length, 1);
    assert.equal(page.el('toasts').children.length, 1, `status ${status}: only the accept's own refusal note`);
    assert.ok(!/paying|Too many/i.test(page.el('toasts').children[0].textContent), 'nothing about the paying call is shown');
  }
});

test('TIMEOUT: stays open, then closes on the next poll that shows offers', async () => {
  const { server, page, buttons } = await onPaySheet();
  server.accept = () => new Promise(() => {});
  await page.tap(buttons[0]);
  await page.tap(page.el('pay-go'));
  await page.settle();
  assert.deepEqual(page.paying(), ['bid-A:open'], 'waiting for the answer: still paying');
  await page.fireRequestLimit();   // no answer in time: the page asks at once; the server still shows offers
  assert.deepEqual(page.paying(), ['bid-A:open', 'bid-A:close']);
  await page.poll();
  assert.deepEqual(page.paying(), ['bid-A:open', 'bid-A:close']);
});

test('TIMEOUT then the poll finds it confirmed: cleared, nothing sent', async () => {
  const { server, page, buttons } = await onPaySheet();
  server.accept = () => new Promise(() => {});
  await page.tap(buttons[0]);
  await page.tap(page.el('pay-go'));
  server.state = { ...offerState(), phase: 'confirmed' };
  await page.fireRequestLimit();
  await page.poll();
  page.fireWindow('pagehide');
  await page.settle();
  assert.deepEqual(page.paying(), ['bid-A:open']);
});

test('a refused link (401) while paying closes once', async () => {
  const { page, buttons } = await onPaySheet({ accept: () => ({ status: 401, json: { error: 'Link' } }) });
  await page.tap(buttons[0]);
  await page.tap(page.el('pay-go'));
  assert.deepEqual(page.paying(), ['bid-A:open', 'bid-A:close']);
});

test('add-money: the driver changing the price closes once', async () => {
  const { server, page, buttons } = await onPaySheet({
    accept: () => ({ status: 402, json: { code: 'WALLET_SHORT', error: 'Add money', fareNgn: 2000, sendNgn: 500, balanceNgn: 1500, account: { bankName: 'B', accountNumber: '1', accountName: 'N' } } }),
  });
  await page.tap(buttons[0]);
  await page.tap(page.el('pay-go'));
  server.state = offerState({ offers: [{ key: 'bid-A', driverName: 'Ada Driver', priceNgn: 2500 }, { key: 'bid-B', driverName: 'Bayo Driver', priceNgn: 2200 }] });
  await page.poll();
  assert.deepEqual(page.paying(), ['bid-A:open', 'bid-A:close']);
});

test('add-money: money in but still offers closes once', async () => {
  const { server, page, buttons } = await onPaySheet({
    accept: () => ({ status: 402, json: { code: 'WALLET_SHORT', error: 'Add money', fareNgn: 2000, sendNgn: 500, balanceNgn: 1500, account: { bankName: 'B', accountNumber: '1', accountName: 'N' } } }),
  });
  await page.tap(buttons[0]);
  await page.tap(page.el('pay-go'));
  server.state = offerState({ balanceNgn: 9000 });
  for (let i = 0; i < 12 && page.paying().length < 2; i++) { await page.poll(); await page.advanceClock(60000); }
  assert.deepEqual(page.paying(), ['bid-A:open', 'bid-A:close']);
});

test('queue order: a close goes out before the next open while the earlier request is pending', async () => {
  const { server, page, buttons } = await onPaySheet();
  server.hold = true;
  await page.tap(buttons[0]);
  await page.tap(page.el('overlay'));
  await page.tap(buttons[1]);
  assert.deepEqual(page.paying(), ['bid-A:open'], 'the rest wait behind the pending request');
  server.held.shift()();
  await page.settle();
  assert.deepEqual(page.paying(), ['bid-A:open', 'bid-A:close']);
  server.held.shift()();
  await page.settle();
  assert.deepEqual(page.paying(), ['bid-A:open', 'bid-A:close', 'bid-B:open']);
});

test('the 8 s limit releases the queue behind a hung request', async () => {
  const { server, page, buttons } = await onPaySheet();
  server.hold = true;
  await page.tap(buttons[0]);
  await page.tap(page.el('overlay'));
  assert.deepEqual(page.paying(), ['bid-A:open']);
  await page.fireLimit();
  assert.deepEqual(page.paying(), ['bid-A:open', 'bid-A:close']);
});

test('coming back from the page cache with the pay sheet open tells the driver again', async () => {
  const { page, buttons } = await onPaySheet();
  await page.tap(buttons[0]);
  page.fireWindow('pagehide');
  await page.settle();
  page.fireWindow('pageshow', { persisted: true });
  await page.settle();
  assert.deepEqual(page.paying(), ['bid-A:open', 'bid-A:close', 'bid-A:open']);
  page.fireWindow('pageshow', { persisted: true });
  await page.settle();
  assert.equal(page.paying().length, 3, 'once');
});
