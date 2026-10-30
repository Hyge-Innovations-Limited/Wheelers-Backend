// Change the route mid-trip when the wallet is short (STOP_FIXED_PRICE_ENABLED on the server): the new price is
// asked, a short wallet shows "Add ₦X" with the account, the change goes to the driver only after the money
// lands, and backing out leaves the trip as it was. Runs the real widget/ride/ride.js against a stand-in DOM.
//
//   node scripts/run-with-env.cjs node --test --test-force-exit --test-concurrency=1 --test-reporter=tap test/ride-page-route-add-money.test.js

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
    id, lastChild: { textContent: '' }, parentNode: { classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } } }, children: [], style: {}, dataset: {}, textContent: '', innerHTML: '', value: '', disabled: false,
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

const IKEJA = { lat: 6.6, lng: 3.35, address: 'Ikeja City Mall' };
const PLACES = { pickup: { lat: 6.5, lng: 3.38, address: 'Yaba' }, destination: { lat: 6.43, lng: 3.45, address: 'Lekki' }, stops: [IKEJA] };

/** A booked trip. `route` is what the server says the trip is now; places is what the plan screen starts from (with the stop the rider wants). */
function tripState(extra) {
  return {
    phase: 'confirmed', rideId: 'ride-1', balanceNgn: 1000, offerNgn: 3000,
    route: { pickupAddress: 'Yaba', destAddress: 'Lekki', stopAddresses: [] },
    places: PLACES, trip: { status: 'IN_PROGRESS' },
    ...extra,
  };
}
const WITH_STOP = { pickupAddress: 'Yaba', destAddress: 'Lekki', stopAddresses: ['Ikeja City Mall'] };
const short = (extra) => ({ status: 402, json: { error: 'Add ₦2,500', code: 'WALLET_SHORT', fareNgn: 5000, extraNgn: 2000, neededNgn: 2500, balanceNgn: 1000, pendingUntil: new Date(Date.now() + 30 * 60 * 1000).toISOString(), ...extra } });
const ACCOUNT = { bankName: 'Wema', accountNumber: '0123456789', accountName: 'Ada Rider' };

function makeServer(opts = {}) {
  const server = {
    state: tripState(),
    quote: opts.quote || (() => ({ status: 200, json: { fareNgn: 5000, extraNgn: 2000 } })),
    change: opts.change || (() => short()),
    topup: opts.topup || ((amount) => ({ status: 200, json: { sendNgn: amount + 50, account: ACCOUNT } })),
    async answer(method, url, body) {
      if (url.startsWith('/ride-page/state')) return { status: 200, json: server.state };
      if (url === '/ride-page/trip-route/quote') return server.quote(body);
      if (url === '/ride-page/trip-route/cancel') return { status: 200, json: { ok: true } };
      if (url === '/ride-page/trip-route') return server.change(body);
      if (url.startsWith('/ride-page/topup')) return server.topup(Number(new URL(url, 'http://x').searchParams.get('amount')));
      return { status: 200, json: {} };
    },
  };
  return server;
}

/** On the plan screen over a booked trip, "Update" tapped. */
async function changeTheRoute(opts) {
  const server = makeServer(opts);
  const page = await loadPage(server);
  await page.tap(page.el('d-stops'));
  await page.tap(page.el('plan-go'));
  return { server, page };
}
const urls = (page) => page.calls.map((c) => c.method + ' ' + c.url.split('?')[0]);
const sheetOpen = (page, id) => page.el(id).hidden === false;

test('a quote that differs asks first; Update route with a short wallet shows Add ₦X and the account', async () => {
  const { page } = await changeTheRoute();
  assert.ok(sheetOpen(page, 'sheet-route-price'), 'the price is asked first');
  assert.equal(page.el('rp-title').textContent, 'New fare ₦5,000');
  assert.equal(page.el('rp-text').textContent, '₦2,000 more will be held');
  await page.tap(page.el('rp-yes'));
  const sent = page.calls.find((c) => c.url === '/ride-page/trip-route');
  assert.equal(sent.body.acceptedFareNgn, 5000);
  assert.ok(sheetOpen(page, 'sheet-pay'), 'the add-money sheet shows');
  assert.equal(page.el('pay-add').hidden, false);
  assert.equal(page.el('pay-ask').hidden, true);
  // The figure to send is the top-up's (with its fee); the account is the page's own deposit account.
  assert.equal(page.el('add-title').textContent, 'Add ₦2,550');
  assert.match(page.el('add-sub').textContent, /5,000/);
  assert.equal(page.el('pay-number').textContent, '0123 456 789', 'grouped 4-3-3');
  assert.equal(page.el('pay-loading').hidden, true);
  assert.equal(page.el('pay-details').hidden, false);
  assert.equal(page.el('pay-waiting').hidden, false);
  assert.equal(page.el('pay-bank').textContent, 'Wema');
  const topup = page.calls.find((c) => c.url.startsWith('/ride-page/topup'));
  assert.ok(topup.url.endsWith('amount=2500'));
});

test('while the account is not ready the sheet still says Add ₦{neededNgn}', async () => {
  const { page } = await changeTheRoute({ topup: () => ({ status: 200, json: { sendNgn: 2500, account: null } }) });
  await page.tap(page.el('rp-yes'));
  assert.equal(page.el('add-title').textContent, 'Add ₦2,500');
  // The spinner stands in for the account; no rows, no waiting line, no dashes.
  assert.equal(page.el('pay-loading').hidden, false);
  assert.equal(page.el('pay-details').hidden, true);
  assert.equal(page.el('pay-waiting').hidden, true);
  assert.equal(page.el('pay-failed').hidden, true);
});

test('backing out posts cancel and the trip stays as it was', async () => {
  const { page } = await changeTheRoute();
  await page.tap(page.el('rp-yes'));
  assert.equal(urls(page).filter((u) => u === 'POST /ride-page/trip-route/cancel').length, 0);
  // The sheet's Back (and the overlay, the swipe and the phone's Back all end in the same place).
  await page.tap(page.el('overlay'));
  assert.equal(sheetOpen(page, 'sheet-pay'), false);
  assert.equal(urls(page).filter((u) => u === 'POST /ride-page/trip-route/cancel').length, 1);
  // A later look does not try to apply it.
  await page.poll();
  assert.equal(urls(page).filter((u) => u === 'POST /ride-page/trip-route').length, 1);
});

test('the poll showing the new route closes the sheet without a cancel', async () => {
  const { server, page } = await changeTheRoute();
  await page.tap(page.el('rp-yes'));
  await page.poll();
  assert.ok(sheetOpen(page, 'sheet-pay'), 'the route is not there yet: still waiting');
  server.state = tripState({ route: WITH_STOP, offerNgn: 5000, balanceNgn: 1000 });
  await page.poll();
  assert.equal(sheetOpen(page, 'sheet-pay'), false);
  assert.equal(urls(page).filter((u) => u === 'POST /ride-page/trip-route/cancel').length, 0);
});

test('when the poll shows the wallet covers it, the same change is sent again and applies (200)', async () => {
  let tries = 0;
  const { server, page } = await changeTheRoute({
    change: () => { tries += 1; return tries === 1 ? short() : { status: 200, json: tripState({ route: WITH_STOP, offerNgn: 5000, balanceNgn: 3500 }) }; },
  });
  await page.tap(page.el('rp-yes'));
  server.state = tripState({ balanceNgn: 3500 });   // 1000 + 2500 needed
  await page.poll();
  const sends = page.calls.filter((c) => c.url === '/ride-page/trip-route');
  assert.equal(sends.length, 2);
  assert.equal(sends[1].body.acceptedFareNgn, 5000, 'the same accepted price');
  assert.deepEqual(sends[1].body.stops, sends[0].body.stops);
  assert.equal(sheetOpen(page, 'sheet-pay'), false);
  assert.equal(urls(page).filter((u) => u === 'POST /ride-page/trip-route/cancel').length, 0);
});

test('a balance that does not cover it yet sends nothing more', async () => {
  const { server, page } = await changeTheRoute();
  await page.tap(page.el('rp-yes'));
  server.state = tripState({ balanceNgn: 2000 });
  await page.poll();
  assert.equal(page.calls.filter((c) => c.url === '/ride-page/trip-route').length, 1);
  assert.ok(sheetOpen(page, 'sheet-pay'));
});

test('dropped: the sheet closes after pendingUntil, with no cancel and the original route', async () => {
  const { page } = await changeTheRoute({ change: () => short({ pendingUntil: new Date(Date.now() + 60 * 1000).toISOString() }) });
  await page.tap(page.el('rp-yes'));
  await page.poll();
  assert.ok(sheetOpen(page, 'sheet-pay'));
  await page.advanceClock(61 * 1000);
  await page.poll();
  assert.equal(sheetOpen(page, 'sheet-pay'), false);
  assert.equal(urls(page).filter((u) => u === 'POST /ride-page/trip-route/cancel').length, 0);
});

test('dropped: the trip ended, the sheet closes', async () => {
  const { server, page } = await changeTheRoute();
  await page.tap(page.el('rp-yes'));
  server.state = { phase: 'idle', balanceNgn: 1000 };
  await page.poll();
  assert.equal(sheetOpen(page, 'sheet-pay'), false);
});

test('PRICE_CHANGED shows the new price and asks again; yes sends that price', async () => {
  let tries = 0;
  const { page } = await changeTheRoute({
    change: () => { tries += 1; return tries === 1 ? { status: 409, json: { error: 'The price is now ₦5,600.', code: 'PRICE_CHANGED', fareNgn: 5600, extraNgn: 2600 } } : { status: 200, json: tripState({ route: WITH_STOP, offerNgn: 5600 }) }; },
  });
  await page.tap(page.el('rp-yes'));
  assert.ok(sheetOpen(page, 'sheet-route-price'), 'asked again');
  assert.equal(page.el('rp-title').textContent, 'New fare ₦5,600');
  assert.equal(page.el('rp-text').textContent, '₦2,600 more will be held');
  await page.tap(page.el('rp-yes'));
  const sends = page.calls.filter((c) => c.url === '/ride-page/trip-route');
  assert.equal(sends.length, 2);
  assert.equal(sends[1].body.acceptedFareNgn, 5600);
  assert.equal(sheetOpen(page, 'sheet-pay'), false);
});

test('ROUTE_CHANGE_REFUSED shows the server message and sends no change', async () => {
  const { page } = await changeTheRoute({ quote: () => ({ status: 409, json: { error: 'That is the route you already have.', code: 'ROUTE_CHANGE_REFUSED' } }) });
  assert.equal(page.el('plan-err').textContent, 'That is the route you already have.');
  assert.equal(page.el('plan-err').hidden, false);
  assert.equal(page.calls.filter((c) => c.url === '/ride-page/trip-route').length, 0);
  assert.equal(sheetOpen(page, 'sheet-pay'), false);
});

test('an older server (no quote step, no wallet answer) changes the route as before', async () => {
  const { page } = await changeTheRoute({
    quote: () => ({ status: 404, json: { error: 'Not found' } }),
    change: () => ({ status: 200, json: tripState({ route: WITH_STOP }) }),
  });
  const sends = page.calls.filter((c) => c.url === '/ride-page/trip-route');
  assert.equal(sends.length, 1);
  assert.equal('acceptedFareNgn' in sends[0].body, false);
  assert.equal(sheetOpen(page, 'sheet-pay'), false);
  assert.equal(sheetOpen(page, 'sheet-route-price'), false);
});

test('an older server that answers 402 without the amount needed shows its message, not the add-money sheet', async () => {
  const { page } = await changeTheRoute({ change: () => ({ status: 402, json: { error: 'Not enough in your wallet.', code: 'WALLET_SHORT' } }) });
  await page.tap(page.el('rp-yes'));
  assert.equal(sheetOpen(page, 'sheet-pay'), false);
  assert.equal(page.el('plan-err').textContent, 'Not enough in your wallet.');
});

const pend = (extra) => ({ pendingUntil: new Date(Date.now() + 30 * 60 * 1000).toISOString(), fareNgn: 5000, neededNgn: 2500, ...extra });

test('routePending present keeps the sheet open and updates the figure; a sheet is not closed by a look without the route moving', async () => {
  const { server, page } = await changeTheRoute();
  await page.tap(page.el('rp-yes'));
  server.state = tripState({ routePending: pend({ neededNgn: 1500 }) });
  server.topup = (amount) => ({ status: 200, json: { sendNgn: amount, account: ACCOUNT } });
  await page.poll();
  await page.poll();
  assert.ok(sheetOpen(page, 'sheet-pay'));
  assert.equal(page.el('add-title').textContent, 'Add ₦1,500');
});

test('routePending gone and the route moved: closed, no cancel', async () => {
  const { server, page } = await changeTheRoute();
  await page.tap(page.el('rp-yes'));
  server.state = tripState({ routePending: pend() });
  await page.poll();
  server.state = tripState({ route: WITH_STOP, offerNgn: 5000 });
  await page.poll();
  assert.equal(sheetOpen(page, 'sheet-pay'), false);
  assert.equal(urls(page).filter((u) => u === 'POST /ride-page/trip-route/cancel').length, 0);
});

test('routePending gone, the route never moves: waits a couple of looks, then closes with "Route not changed"', async () => {
  const { server, page } = await changeTheRoute();
  await page.tap(page.el('rp-yes'));
  server.state = tripState({ routePending: pend() });
  await page.poll();
  server.state = tripState();
  await page.poll();
  assert.ok(sheetOpen(page, 'sheet-pay'), 'one look is not enough');
  await page.poll();
  await page.poll();
  assert.equal(sheetOpen(page, 'sheet-pay'), false);
  assert.equal(urls(page).filter((u) => u === 'POST /ride-page/trip-route/cancel').length, 0);
});

test('routePending gone, then the route lands a look later: closed as applied', async () => {
  const { server, page } = await changeTheRoute();
  await page.tap(page.el('rp-yes'));
  server.state = tripState({ routePending: pend() });
  await page.poll();
  server.state = tripState();
  await page.poll();
  server.state = tripState({ route: WITH_STOP, offerNgn: 5000 });
  await page.poll();
  assert.equal(sheetOpen(page, 'sheet-pay'), false);
});

test('routePending with neededNgn 0 retries the same change; a 200 applies', async () => {
  let tries = 0;
  const { server, page } = await changeTheRoute({
    change: () => { tries += 1; return tries === 1 ? short() : { status: 200, json: tripState({ route: WITH_STOP, offerNgn: 5000 }) }; },
  });
  await page.tap(page.el('rp-yes'));
  server.state = tripState({ routePending: pend({ neededNgn: 0 }) });
  await page.poll();
  const sends = page.calls.filter((c) => c.url === '/ride-page/trip-route');
  assert.equal(sends.length, 2);
  assert.equal(sends[1].body.acceptedFareNgn, 5000);
  assert.equal(sheetOpen(page, 'sheet-pay'), false);
});

test('fee-included sendNgn from the 402 body is the title; the subline is the new fare only', async () => {
  const { page } = await changeTheRoute({ change: () => short({ sendNgn: 2600 }) });
  await page.tap(page.el('rp-yes'));
  assert.equal(page.el('add-title').textContent, 'Add ₦2,600');
  assert.equal(page.el('add-sub').textContent, 'New fare ₦5,000');
});

test('routePending sendNgn is used first', async () => {
  const { server, page } = await changeTheRoute();
  await page.tap(page.el('rp-yes'));
  server.state = tripState({ routePending: pend({ sendNgn: 2700 }) });
  await page.poll();
  assert.equal(page.el('add-title').textContent, 'Add ₦2,700');
});

test('a dropped change (trip changed): marker gone, route unmoved closes within the wait, well before pendingUntil, with only "Route not changed"', async () => {
  const { server, page } = await changeTheRoute();
  await page.tap(page.el('rp-yes'));
  server.state = tripState({ routePending: pend() });
  await page.poll();
  server.state = tripState();
  await page.poll(); await page.poll(); await page.poll();
  assert.equal(sheetOpen(page, 'sheet-pay'), false);
  assert.equal(urls(page).filter((u) => u === 'POST /ride-page/trip-route/cancel').length, 0);
});

test('history: the applied path leaves the history exactly as it started, and the trip-ended path leaves nothing doubled', async () => {
  const { server, page } = await changeTheRoute();
  await page.tap(page.el('rp-yes'));
  assert.deepEqual(page.paying(), [], 'no driver pay signal for a route change');
  server.state = tripState({ routePending: pend() });
  await page.poll();
  server.state = tripState({ route: WITH_STOP, offerNgn: 5000 });
  await page.poll();
  assert.ok(page.history.settled(), 'every entry stepped back once, none twice');
});

test('history: a retry that gets 200 leaves the history exactly as it started', async () => {
  let tries = 0;
  const { server, page } = await changeTheRoute({
    change: () => { tries += 1; return tries === 1 ? short() : { status: 200, json: tripState({ route: WITH_STOP, offerNgn: 5000 }) }; },
  });
  await page.tap(page.el('rp-yes'));
  server.state = tripState({ routePending: pend({ neededNgn: 0 }) });
  await page.poll();
  assert.ok(page.history.settled(), 'every entry stepped back once, none twice');
});

test('history: the trip ended under the sheet: no cancel, the sheet is gone, and the page is not stepped back twice', async () => {
  const { server, page } = await changeTheRoute();
  await page.tap(page.el('rp-yes'));
  server.state = { phase: 'idle', balanceNgn: 1000 };
  await page.poll();
  assert.equal(sheetOpen(page, 'sheet-pay'), false);
  assert.equal(page.history.under, false, 'never stepped back past the start');
  assert.equal(urls(page).filter((u) => u === 'POST /ride-page/trip-route/cancel').length, 0);
});

test('backing out lands on the trip, cancels once, and sends no driver pay signal', async () => {
  const { page } = await changeTheRoute();
  await page.tap(page.el('rp-yes'));
  assert.deepEqual(page.paying(), []);
  await page.tap(page.el('overlay'));
  assert.deepEqual(page.paying(), []);
  assert.ok(page.history.settled(), 'every entry stepped back once, none twice');
  assert.equal(urls(page).filter((u) => u === 'POST /ride-page/trip-route/cancel').length, 1);
  assert.equal(urls(page).filter((u) => u === 'POST /ride-page/keep-looking').length, 0);
  assert.deepEqual(page.toasts(), [], 'no extra line when backing out');
});

test('"Route not changed" is the toast when the marker goes and the route never moves', async () => {
  const { server, page } = await changeTheRoute();
  await page.tap(page.el('rp-yes'));
  server.state = tripState({ routePending: pend() });
  await page.poll();
  server.state = tripState();
  await page.poll(); await page.poll(); await page.poll();
  assert.ok(page.toasts().includes('Route not changed'));
  assert.ok(page.history.settled(), 'every entry stepped back once, none twice');
});

test('"Route not changed" is also the toast when an older server lapses at pendingUntil', async () => {
  const { page } = await changeTheRoute({ change: () => short({ pendingUntil: new Date(Date.now() + 60 * 1000).toISOString() }) });
  await page.tap(page.el('rp-yes'));
  await page.advanceClock(61 * 1000);
  await page.poll();
  assert.ok(page.toasts().includes('Route not changed'));
});

test('the retry is limited: neededNgn 0 with the retry answering 402 again sends 2 POSTs in two polls, a 3rd after 8 s', async () => {
  const { server, page } = await changeTheRoute({ change: () => short() });
  await page.tap(page.el('rp-yes'));
  server.state = tripState({ routePending: pend({ neededNgn: 0 }) });
  await page.poll();
  await page.poll();
  const count = () => page.calls.filter((c) => c.url === '/ride-page/trip-route').length;
  assert.equal(count(), 2);
  await page.advanceClock(8000);
  await page.poll();
  assert.equal(count(), 3);
  assert.ok(sheetOpen(page, 'sheet-pay'));
});

test('the account lookup is rate-limited while routePending shows and the account is not ready', async () => {
  const { server, page } = await changeTheRoute({ topup: () => ({ status: 200, json: { sendNgn: 2500, account: null } }) });
  await page.tap(page.el('rp-yes'));
  server.state = tripState({ routePending: pend() });
  await page.poll(); await page.poll(); await page.poll();
  const lookups = () => page.calls.filter((c) => c.url.startsWith('/ride-page/topup')).length;
  assert.equal(lookups(), 1);
  await page.advanceClock(8000);
  await page.poll();
  assert.equal(lookups(), 2);
});

test('PRICE_CHANGED to the very fare the rider accepted is sent without asking', async () => {
  let tries = 0;
  const { page } = await changeTheRoute({
    change: () => { tries += 1; return tries === 1 ? { status: 409, json: { error: 'The price is now ₦5,000.', code: 'PRICE_CHANGED', fareNgn: 5000, extraNgn: 0 } } : { status: 200, json: tripState({ route: WITH_STOP, offerNgn: 5000 }) }; },
  });
  await page.tap(page.el('rp-yes'));
  const sends = page.calls.filter((c) => c.url === '/ride-page/trip-route');
  assert.equal(sends.length, 2);
  assert.equal(sheetOpen(page, 'sheet-route-price'), false);
});

test('PRICE_CHANGED after a retry sends no cancel for the old change', async () => {
  let tries = 0;
  const { server, page } = await changeTheRoute({
    change: () => { tries += 1; return tries === 1 ? short() : { status: 409, json: { error: 'The price is now ₦5,600.', code: 'PRICE_CHANGED', fareNgn: 5600, extraNgn: 2600 } }; },
  });
  await page.tap(page.el('rp-yes'));
  server.state = tripState({ routePending: pend({ neededNgn: 0 }) });
  await page.poll();
  assert.ok(sheetOpen(page, 'sheet-route-price'));
  assert.equal(urls(page).filter((u) => u === 'POST /ride-page/trip-route/cancel').length, 0);
});

test('a dead link under the sheet sends no cancel', async () => {
  const { server, page } = await changeTheRoute();
  await page.tap(page.el('rp-yes'));
  server.state = tripState({ routePending: pend({ neededNgn: 0 }) });
  server.change = () => ({ status: 401, json: { error: 'expired', code: 'LINK_EXPIRED' } });
  await page.poll();
  assert.equal(urls(page).filter((u) => u === 'POST /ride-page/trip-route/cancel').length, 0);
});

test('a retry answered ROUTE_CANCELLED says the server message and goes back to the trip', async () => {
  let tries = 0;
  const { server, page } = await changeTheRoute({
    change: () => { tries += 1; return tries === 1 ? short() : { status: 409, json: { error: 'Route not changed', code: 'ROUTE_CANCELLED' } }; },
  });
  await page.tap(page.el('rp-yes'));
  server.state = tripState({ routePending: pend({ neededNgn: 0 }) });
  await page.poll();
  assert.ok(page.toasts().includes('Route not changed'));
  assert.equal(sheetOpen(page, 'sheet-pay'), false);
  assert.ok(page.history.settled());
  assert.equal(urls(page).filter((u) => u === 'POST /ride-page/trip-route/cancel').length, 0);
});

test('the poll finding the link expired sends no cancel', async () => {
  const { server, page } = await changeTheRoute();
  await page.tap(page.el('rp-yes'));
  server.answer = async (m, url) => (url.startsWith('/ride-page/state') ? { status: 401, json: { error: 'expired', code: 'LINK_EXPIRED' } } : { status: 200, json: {} });
  await page.poll();
  assert.equal(urls(page).filter((u) => u === 'POST /ride-page/trip-route/cancel').length, 0);
});

test('H1: a fare that drops says "₦Y back to your wallet"', async () => {
  const { page } = await changeTheRoute({ quote: () => ({ status: 200, json: { fareNgn: 3500, extraNgn: -500 } }) });
  assert.equal(page.el('rp-title').textContent, 'New fare ₦3,500');
  assert.equal(page.el('rp-text').textContent, '₦500 back to your wallet');
});

test('H3: Update route keeps the sheet open, busy, with Keep my trip disabled until the change settles', async () => {
  let release;
  const { page } = await changeTheRoute({ change: () => new Promise((resolve) => { release = () => resolve({ status: 200, json: tripState({ route: WITH_STOP, offerNgn: 5000 }) }); }) });
  page.el('rp-yes').click();
  await page.settle();
  assert.ok(sheetOpen(page, 'sheet-route-price'), 'still open while sending');
  assert.match(page.el('rp-yes').className, /busy/);
  assert.equal(page.el('rp-no').disabled, true);
  release();
  await page.settle();
  assert.equal(sheetOpen(page, 'sheet-route-price'), false);
  assert.ok(page.history.settled());
});

test('H3: an error closes the sheet and shows the message', async () => {
  const { page } = await changeTheRoute({ change: () => ({ status: 409, json: { error: 'This trip can no longer change its route.', code: 'ROUTE_CHANGE_REFUSED' } }) });
  await page.tap(page.el('rp-yes'));
  assert.equal(sheetOpen(page, 'sheet-route-price'), false);
  assert.equal(page.el('plan-err').textContent, 'This trip can no longer change its route.');
  assert.ok(page.toasts().includes('This trip can no longer change its route.'), 'M4: the message survives the refresh');
});

test('H3: PRICE_CHANGED re-asks on the same open sheet, not busy', async () => {
  let tries = 0;
  const { page } = await changeTheRoute({
    change: () => { tries += 1; return tries === 1 ? { status: 409, json: { error: 'x', code: 'PRICE_CHANGED', fareNgn: 5600, extraNgn: 2600 } } : { status: 200, json: tripState({ route: WITH_STOP }) }; },
  });
  await page.tap(page.el('rp-yes'));
  assert.ok(sheetOpen(page, 'sheet-route-price'));
  assert.equal(page.el('rp-title').textContent, 'New fare ₦5,600');
  assert.doesNotMatch(page.el('rp-yes').className, /busy/);
  assert.equal(page.el('rp-no').disabled, false);
});

test('M3: a failed account look-up shows the muted line in the card, and the next good one clears it', async () => {
  let looks = 0;
  const { server, page } = await changeTheRoute({ topup: (amount) => { looks += 1; return looks === 1 ? { status: 500, json: { error: 'x' } } : { status: 200, json: { sendNgn: amount, account: ACCOUNT } }; } });
  await page.tap(page.el('rp-yes'));
  assert.equal(page.el('pay-failed').hidden, false);
  // The line itself is page markup (the stand-in DOM has no text for it).
  assert.match(fs.readFileSync(path.join(WIDGET, 'ride/ride.html'), 'utf8'), /id="pay-failed"[^>]*>Could not get your account number\. Trying again\.</);
  assert.match(fs.readFileSync(path.join(WIDGET, 'ride/ride.html'), 'utf8'), /aria-label="Getting your account number"/);
  assert.equal(page.el('pay-details').hidden, true);
  assert.equal(page.el('pay-loading').hidden, true);
  server.state = tripState({ routePending: pend() });
  await page.advanceClock(8000);
  await page.poll();
  assert.equal(page.el('pay-failed').hidden, true);
  assert.equal(page.el('pay-details').hidden, false);
  assert.equal(page.el('pay-number').textContent, '0123 456 789');
});

test('Copy copies the raw digits, not the grouped ones', async () => {
  const { page } = await changeTheRoute();
  await page.tap(page.el('rp-yes'));
  await page.tap(page.el('pay-copy'));
  assert.deepEqual(page.copied, ['0123456789']);
});

/* The DRIVER-OFFER pay sheet shares the add-money card: its 402 may come with no account yet. */

function offersState() {
  return {
    phase: 'offers', rideId: 'ride-1', balanceNgn: 1500, amountNgn: 2000, offerNgn: 2000,
    route: { pickupAddress: 'Yaba', destAddress: 'Lekki', stopAddresses: [] },
    offers: [{ key: 'bid-A', driverName: 'Ada Driver', priceNgn: 2000 }],
  };
}
async function driverShort(topup) {
  const server = makeServer({ topup });
  server.state = offersState();
  const base = server.answer;
  server.answer = async (method, url, body) => {
    if (url === '/ride-page/accept') return { status: 402, json: { code: 'WALLET_SHORT', error: 'Add money', fareNgn: 2000, shortNgn: 500, sendNgn: 550, balanceNgn: 1500, account: null } };
    if (url === '/ride-page/paying') return { status: 200, json: { ok: true } };
    return base(method, url, body);
  };
  const page = await loadPage(server);
  await page.tap(page.acceptButtons()[0]);
  await page.tap(page.el('pay-go'));
  return { server, page };
}

test('driver pay sheet, 402 with no account: spinner, then the account once the top-up answers', async () => {
  let looks = 0;
  const { page } = await driverShort((amount) => { looks += 1; return { status: 200, json: { sendNgn: amount, account: ACCOUNT } }; });
  assert.equal(page.el('add-title').textContent, 'Add ₦550');
  const lookup = page.calls.find((c) => c.url.startsWith('/ride-page/topup'));
  assert.ok(lookup && lookup.url.endsWith('amount=500'), 'asked for the short amount');
  assert.equal(page.el('pay-loading').hidden, true);
  assert.equal(page.el('pay-details').hidden, false);
  assert.equal(page.el('pay-number').textContent, '0123 456 789');
  assert.equal(looks, 1);
});

test('driver pay sheet, 402 with no account: spinner while the bank is opening it, asked again 8 s later; the failed line on error', async () => {
  let looks = 0;
  const { page } = await driverShort(() => { looks += 1; return looks === 1 ? { status: 200, json: { sendNgn: 550, account: null } } : looks === 2 ? { status: 500, json: { error: 'x' } } : { status: 200, json: { sendNgn: 550, account: ACCOUNT } }; });
  assert.equal(page.el('pay-loading').hidden, false, 'spinner while the account is not there');
  await page.poll();
  assert.equal(looks, 1, 'not asked again inside 8 s');
  await page.advanceClock(8000);
  await page.poll();
  assert.equal(looks, 2);
  assert.equal(page.el('pay-failed').hidden, false);
  await page.advanceClock(8000);
  await page.poll();
  assert.equal(looks, 3);
  assert.equal(page.el('pay-failed').hidden, true);
  assert.equal(page.el('pay-details').hidden, false);
});

test('PRICE_CHANGED to a different fare is always asked, even when extraNgn is 0', async () => {
  let tries = 0;
  const { page } = await changeTheRoute({
    change: () => { tries += 1; return tries === 1 ? { status: 409, json: { error: 'x', code: 'PRICE_CHANGED', fareNgn: 5300, extraNgn: 0 } } : { status: 200, json: tripState({ route: WITH_STOP, offerNgn: 5300 }) }; },
  });
  await page.tap(page.el('rp-yes'));
  assert.ok(sheetOpen(page, 'sheet-route-price'), 'asked again');
  assert.equal(page.el('rp-title').textContent, 'New fare ₦5,300');
  assert.equal(page.el('rp-text').hidden, true, 'no "₦0" line');
  assert.equal(page.calls.filter((c) => c.url === '/ride-page/trip-route').length, 1, 'nothing sent before the answer');
  await page.tap(page.el('rp-yes'));
  const sends = page.calls.filter((c) => c.url === '/ride-page/trip-route');
  assert.equal(sends[1].body.acceptedFareNgn, 5300);
});

test('new server refusals show the server message as it is', async () => {
  for (const message of ['A trip can have at most 5 stops.', 'An address is too long.', 'Update the app to add stops.', 'This trip is not running, so its route cannot be changed.']) {
    const { page } = await changeTheRoute({ change: () => ({ status: 400, json: { error: message, code: 'ROUTE_CHANGE_REFUSED' } }) });
    await page.tap(page.el('rp-yes'));
    assert.equal(page.el('plan-err').textContent, message);
    assert.equal(sheetOpen(page, 'sheet-route-price'), false);
  }
});
