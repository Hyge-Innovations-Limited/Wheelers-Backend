// The driver's face in the ride page's avatar circle (DRIVER_PHOTO_ENABLED): a photo over the initials, kept across polls.
//   node scripts/run-with-env.cjs node --test --test-force-exit --test-concurrency=1 --test-reporter=tap test/ride-page-driver-photo.test.js

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

const PHOTO = 'https://files.example.com/drivers/d1-aa11.jpg?sig=abc';

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
const offers = (photo) => ({
  phase: 'offers', rideId: 'ride-1', balanceNgn: 5000, amountNgn: 2000, offerNgn: 2000,
  route: { pickupAddress: 'Yaba', destAddress: 'Lekki', stopAddresses: [] },
  offers: [{ key: 'bid-A', driverName: 'Ada Driver', priceNgn: 2000, ...photo }],
});
const trip = (photo, status = 'IN_PROGRESS') => ({
  phase: 'confirmed', rideId: 'ride-1', balanceNgn: 1000, offerNgn: 3000,
  route: { pickupAddress: 'Yaba', destAddress: 'Lekki', stopAddresses: [] },
  trip: { status }, driver: { name: 'Ada Driver', rating: 4.9, fareNgn: 3000, ...photo },
});
/** The avatar circle of the first offer card. */
const offerFace = (page) => page.el('offer-list').children[0].children[0].children[0];
const imgsIn = (node) => node.children.filter((c) => c.className === 'avatar-photo');

test('offer card: a photo goes over the initials with the safe attributes', async () => {
  const page = await loadPage(makeServer(offers({ driverPhotoUrl: PHOTO, driverPhotoKey: 'd1-aa11' })));
  const face = offerFace(page);
  const [img] = imgsIn(face);
  assert.ok(img, 'an img in the circle');
  assert.equal(img.src, PHOTO);
  assert.equal(img.attrs.referrerpolicy, 'no-referrer');
  assert.equal(img.attrs.alt, '');
  assert.equal(img.attrs.decoding, 'async');
  assert.equal(face.textContent, 'AD', 'the initials stay under it');
});

test('offer card: no photo is the initials only', async () => {
  const page = await loadPage(makeServer(offers({})));
  const face = offerFace(page);
  assert.equal(imgsIn(face).length, 0);
  assert.equal(face.textContent, 'AD');
});

test('a non-https photo URL is never used', async () => {
  for (const bad of ['http://files.example.com/a.jpg', 'javascript:alert(1)', 'data:image/png;base64,AAA', '//files.example.com/a.jpg', '']) {
    const page = await loadPage(makeServer(offers({ driverPhotoUrl: bad, driverPhotoKey: 'd1-aa11' })));
    assert.equal(imgsIn(offerFace(page)).length, 0, bad);
  }
});

test('a broken photo is hidden and the initials stay; polls do not retry it', async () => {
  const server = makeServer(offers({ driverPhotoUrl: PHOTO, driverPhotoKey: 'd1-aa11' }));
  const page = await loadPage(server);
  const [img] = imgsIn(offerFace(page));
  img.onerror();
  assert.equal(img.style.display, 'none');
  server.state = offers({ driverPhotoUrl: PHOTO, driverPhotoKey: 'd1-aa11' });
  await page.poll();
  assert.ok(imgsIn(offerFace(page)).every((i) => i.style.display === 'none'), 'still hidden after a poll');
  assert.equal(offerFace(page).textContent, 'AD');
});

test('the same key across polls keeps the same img (no new element, no new download)', async () => {
  const server = makeServer(offers({ driverPhotoUrl: PHOTO, driverPhotoKey: 'd1-aa11' }));
  const page = await loadPage(server);
  const [first] = imgsIn(offerFace(page));
  // A second offer arrives: the list is redrawn, the picture is not remade.
  server.state = { ...offers({ driverPhotoUrl: PHOTO, driverPhotoKey: 'd1-aa11' }), offerNgn: 2100 };
  server.state.offers.push({ key: 'bid-B', driverName: 'Bayo Driver', priceNgn: 2200 });
  await page.poll();
  const [again] = imgsIn(offerFace(page));
  assert.equal(again, first);
  // The same key with a freshly signed URL is not reloaded either.
  server.state = offers({ driverPhotoUrl: PHOTO + '&x=2', driverPhotoKey: 'd1-aa11' });
  await page.poll();
  assert.equal(imgsIn(offerFace(page))[0], first);
  assert.equal(first.src, PHOTO);
});

test('a new key makes a new img', async () => {
  const server = makeServer(offers({ driverPhotoUrl: PHOTO, driverPhotoKey: 'd1-aa11' }));
  const page = await loadPage(server);
  const [first] = imgsIn(offerFace(page));
  server.state = offers({ driverPhotoUrl: 'https://files.example.com/drivers/d1-bb22.jpg?sig=z', driverPhotoKey: 'd1-bb22' });
  await page.poll();
  const [next] = imgsIn(offerFace(page));
  assert.ok(next && next !== first);
  assert.match(next.src, /bb22/);
});

test('the trip screen shows the photo in the driver circle and keeps it across polls', async () => {
  const server = makeServer(trip({ driverPhotoUrl: PHOTO, driverPhotoKey: 'd1-aa11' }));
  const page = await loadPage(server);
  const face = page.el('d-initial');
  const [img] = imgsIn(face);
  assert.ok(img);
  assert.equal(face.textContent, 'AD');
  await page.poll(); await page.poll();
  assert.equal(imgsIn(face).length, 1);
  assert.equal(imgsIn(face)[0], img);
});

test('the trip screen without a photo, or with a bad URL, is the initials', async () => {
  for (const photo of [{}, { driverPhotoUrl: null, driverPhotoKey: null }, { driverPhotoUrl: 'http://x/a.jpg', driverPhotoKey: 'k' }]) {
    const page = await loadPage(makeServer(trip(photo)));
    assert.equal(imgsIn(page.el('d-initial')).length, 0);
    assert.equal(page.el('d-initial').textContent, 'AD');
  }
});

test('the Driver found card shows the photo too', async () => {
  const page = await loadPage(makeServer(trip({ driverPhotoUrl: PHOTO, driverPhotoKey: 'd1-aa11' }, 'ACCEPTED')));
  assert.equal(imgsIn(page.el('fd-initial')).length, 1);
});

test('a photo adds no request besides the image', async () => {
  const page = await loadPage(makeServer(offers({ driverPhotoUrl: PHOTO, driverPhotoKey: 'd1-aa11' })));
  await page.poll();
  // The image is the browser's own load; the page itself asks only its state and events.
  assert.ok(page.calls.every((c) => /^\/ride-page\/(state|events)/.test(c.url)), page.calls.map((c) => c.url).join(' '));
  assert.equal(page.calls.filter((c) => c.url.includes('files.example.com')).length, 0);
});

test('an avatar the photo was moved out of gets it back at the next draw', async () => {
  const server = makeServer(trip({ driverPhotoUrl: PHOTO, driverPhotoKey: 'd1-aa11' }));
  const page = await loadPage(server);
  const face = page.el('d-initial');
  const [img] = imgsIn(face);
  face.children.splice(face.children.indexOf(img), 1);
  img.parentNode = null;
  await page.poll();
  assert.equal(imgsIn(face)[0], img);
  assert.equal(imgsIn(face).length, 1);
});

test('the circle is named for screen readers; the picture stays alt=""', async () => {
  const page = await loadPage(makeServer(offers({ driverPhotoUrl: PHOTO, driverPhotoKey: 'd1-aa11' })));
  const face = offerFace(page);
  assert.equal(face.attrs['aria-label'], 'Ada Driver');
  assert.equal(imgsIn(face)[0].attrs.alt, '');
  const noName = await loadPage(makeServer({ ...offers({}), offers: [{ key: 'bid-A', priceNgn: 2000 }] }));
  assert.equal(offerFace(noName).attrs['aria-label'], 'Driver');
});

const statsOf = (page) => page.el('offer-list').children[0].children[0].children[1].children.filter((c) => c.className === 'who-stats').map((c) => c.textContent);
const offerWith = (extra) => ({ ...offers({}), offers: [{ key: 'bid-A', driverName: 'Ada Driver', priceNgn: 2000, ...extra }] });

test('stats line on the offer card: rating and rides, either alone, or nothing', async () => {
  const cases = [
    [{ rating: 4.8, driverRidesCompleted: 120 }, ['4.8 ★ · 120 rides']],
    [{ driverRidesCompleted: 120 }, ['120 rides']],
    [{ rating: 4.8 }, ['4.8 ★']],
    [{}, []],
    [{ rating: 4.8, driverRidesCompleted: 1 }, ['4.8 ★ · 1 ride']],
    [{ rating: 4.86, driverRidesCompleted: null }, ['4.9 ★']],
    [{ rating: 0, driverRidesCompleted: null }, []],
    [{ driverRidesCompleted: 0 }, ['New driver']],
    [{ rating: 4.8, driverRidesCompleted: 0 }, ['4.8 ★']],
  ];
  for (const [extra, want] of cases) {
    const page = await loadPage(makeServer(offerWith(extra)));
    assert.deepEqual(statsOf(page), want, JSON.stringify(extra));
  }
});

test('the count is driverRidesCompleted when sent, else the older totalRides', async () => {
  const both = await loadPage(makeServer(offerWith({ rating: 4.8, driverRidesCompleted: 120, totalRides: 999 })));
  assert.deepEqual(statsOf(both), ['4.8 ★ · 120 rides']);
  const old = await loadPage(makeServer(offerWith({ rating: 4.8, totalRides: 60 })));
  assert.deepEqual(statsOf(old), ['4.8 ★ · 60 rides']);
});

test('an offer with no photo and a count still shows initials and the line', async () => {
  const page = await loadPage(makeServer(offerWith({ rating: 4.8, driverRidesCompleted: 7, driverPhotoUrl: null, driverPhotoKey: null })));
  assert.equal(imgsIn(offerFace(page)).length, 0);
  assert.deepEqual(statsOf(page), ['4.8 ★ · 7 rides']);
});

test('the Driver found card shows the same line, and nothing when there is neither', async () => {
  const page = await loadPage(makeServer(trip({ rating: 4.8, driverRidesCompleted: 120 }, 'ACCEPTED')));
  assert.equal(page.el('fd-rating').textContent, '4.8 ★ · 120 rides');
  assert.equal(page.el('fd-rating').hidden, false);
  const none = await loadPage(makeServer({ ...trip({}, 'ACCEPTED'), driver: { name: 'Ada Driver', fareNgn: 3000 } }));
  assert.equal(none.el('fd-rating').hidden, true);
  assert.equal(none.el('fd-rating').textContent, '');
});
