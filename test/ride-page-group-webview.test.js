// A group ride offer on the ride page (Timi, 16-17 Nov 2026): the sheet opens over the search with who is going your
// way, the seat and 20 s; Ride together / No thanks; a yes with no selfie takes one; then how it ended.
//   node --test test/ride-page-group-webview.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadPage, makeServer } = require('./helpers/ride-page-harness');

const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const offer = (extra = {}) => ({
  offerId: 'offer-1', expiresAt: iso(now + 15_000), selfieDeadline: iso(now + 75_000), ownPriceNgn: 12000, seatPriceNgn: 9000, savedNgn: 3000,
  extraMinutes: 6, people: 2, answer: null, selfieNeeded: false,
  riders: [{ you: true, name: 'You', pickup: 'Yaba', answer: null }, { you: false, name: 'Chika', pickup: 'Ketu', answer: null }],
  stops: [{ kind: 'pickup', address: 'Yaba', you: true }, { kind: 'pickup', address: 'Ketu', you: false }, { kind: 'dropoff', address: 'Ikorodu Garage, Lagos', you: true }, { kind: 'dropoff', address: 'Ikorodu Garage, Lagos', you: false }],
  ...extra,
});
const searching = (extra = {}) => ({
  phase: 'offers', rideId: 'ride-1', balanceNgn: 20000, offerNgn: 12000,
  route: { pickupAddress: 'Yaba', destAddress: 'Ikorodu Garage', stopAddresses: [] },
  driversNotified: 4, bidsCloseAt: iso(now + 240_000), offers: [], offerCount: 0, ...extra,
});
function server(state) {
  const s = makeServer(state);
  s.sent = [];
  const plain = s.answer;
  s.answer = async (method, url, body) => {
    if (url === '/ride-page/group' || url === '/ride-page/group/selfie' || url === '/ride-page/group/counter') { s.sent.push({ url, body }); return { status: 200, json: s.next(body, url) }; }
    return plain(method, url, body);
  };
  return s;
}
const roadText = (page) => page.el('group-road').children.map((li) => li.children.map((c) => c.textContent).join(' · '));

test('the offer opens over the search: who, where, the seat, 20 s', async () => {
  const page = await loadPage(server(searching({ groupOffer: offer() })));
  assert.equal(page.el('sheet-group').hidden, false);
  assert.equal(page.el('group-ask').hidden, false);
  assert.equal(page.el('group-title').textContent, '1 rider is going your way');
  assert.deepEqual(roadText(page), ['You · Yaba', 'Chika · Ketu', 'Ikorodu Garage']);
  assert.equal(page.el('group-seat').textContent, '₦9,000');
  assert.equal(page.el('group-own').textContent, '₦12,000');
  assert.equal(page.el('group-save').textContent, 'Save ₦3,000');
  assert.equal(page.el('group-facts').textContent, 'About 6 min more · 2 in the car · Faces checked');
});

test('Ride together with a selfie on file: sent, then "Getting your group together"; formed: told who and the seat', async () => {
  const s = server(searching({ groupOffer: offer() }));
  s.next = () => searching({ groupOffer: offer({ answer: 'join' }) });
  const page = await loadPage(s);
  await page.tap(page.el('group-yes'));
  assert.deepEqual(s.sent, [{ url: '/ride-page/group', body: { answer: 'join' } }]);
  assert.equal(page.el('group-wait').hidden, false);
  assert.equal(page.el('group-wait-title').textContent, 'Getting your group together');
  s.state = searching({ groupFormed: { seatPriceNgn: 9000, others: ['Chika'], ownPriceNgn: 12000 } });
  await page.poll();
  assert.equal(page.el('sheet-group').hidden, true);
  assert.ok(page.toasts().some((t) => t === "You're riding together with Chika. Your seat: ₦9,000. Finding your driver."), page.toasts().join(' | '));
});

test('Ride together with no selfie: the selfie step; No thanks: the search goes on, nothing said after', async () => {
  const s = server(searching({ groupOffer: offer() }));
  s.next = () => searching({ groupOffer: offer({ answer: 'join', selfieNeeded: true }) });
  const page = await loadPage(s);
  await page.tap(page.el('group-yes'));
  assert.equal(page.el('group-selfie').hidden, false, 'asked for a selfie');
  assert.equal(page.el('group-send').hidden, true, 'nothing to send before a photo');

  const t = server(searching({ groupOffer: offer({ offerId: 'offer-2' }) }));
  t.next = () => searching({ groupOffer: offer({ offerId: 'offer-2', answer: 'decline' }) });
  const other = await loadPage(t);
  await other.tap(other.el('group-no'));
  assert.equal(other.el('group-wait-title').textContent, 'No problem');
  t.state = searching();
  await other.poll();
  assert.equal(other.el('sheet-group').hidden, true);
  assert.ok(!other.toasts().some((x) => /No group this time/.test(x)), 'a No hears nothing more');
});

test('a yes that did not become a group: told the search goes on', async () => {
  const s = server(searching({ groupOffer: offer() }));
  s.next = () => searching({ groupOffer: offer({ answer: 'join' }) });
  const page = await loadPage(s);
  await page.tap(page.el('group-yes'));
  s.state = searching();
  await page.poll();
  assert.ok(page.toasts().includes('No group this time. Your search goes on.'));
});

test('a driver asks more for this rider\'s seat: Yes or No; yes sent, then waiting; gone from the state, the sheet closes', async () => {
  const ask = { askId: 'ask-1', seatPriceNgn: 6000, askNgn: 6650, expiresAt: iso(now + 18_000), answer: null };
  const formed = { seatPriceNgn: 6000, others: ['Ada'], ownPriceNgn: 9000 };
  const s = server(searching({ groupFormed: formed, groupCounter: ask }));
  s.next = () => searching({ groupFormed: formed, groupCounter: { ...ask, answer: 'yes' } });
  const page = await loadPage(s);
  assert.equal(page.el('sheet-gcounter').hidden, false);
  assert.equal(page.el('gcounter-title').textContent, 'A driver asks ₦6,650 for your seat');
  assert.equal(page.el('gcounter-sub').textContent, 'Your seat was ₦6,000.');
  assert.equal(page.el('gcounter-yes').textContent, 'Yes, ₦6,650');
  await page.tap(page.el('gcounter-yes'));
  assert.deepEqual(s.sent, [{ url: '/ride-page/group/counter', body: { answer: 'yes', askId: 'ask-1' } }], 'the ask it answers (a stale one is refused)');
  assert.equal(page.el('gcounter-sub').textContent, 'Waiting for the others.');
  assert.equal(page.el('gcounter-yes').disabled, true);
  s.state = searching({ groupFormed: formed });
  await page.poll();
  assert.equal(page.el('sheet-gcounter').hidden, true);
});

test('what happened to the group (someone left, a wallet short) is said once', async () => {
  const s = server(searching({ groupNote: { id: 'n1', text: 'Ada left the group. Still finding your driver.' } }));
  const page = await loadPage(s);
  await page.poll();
  assert.equal(page.toasts().filter((t) => t === 'Ada left the group. Still finding your driver.').length, 1);
});

const confirmed = (group, status = 'ARRIVED') => ({
  phase: 'confirmed', rideId: 'ride-1', balanceNgn: 20000, offerNgn: 6750,
  route: { pickupAddress: 'Ketu', destAddress: 'Mile 12', stopAddresses: [] },
  trip: { status }, driver: { name: 'Tunde Bakare', rating: 4.9, fareNgn: 6750 },
  ...(group ? { group } : {}),
});
const stopsText = (page) => page.el('d-group-stops').children.map((li) => `${li.className || '-'}|${li.children[0].textContent}`);

test('on the trip: who else is in the car and every stop in order, yours marked; a ride of one rider shows none', async () => {
  const group = { others: ['Ada'], stops: [
    { kind: 'pickup', name: 'Ada', area: 'Yaba', yours: false, done: true },
    { kind: 'pickup', name: 'You', area: 'Ketu', yours: true, done: false },
    { kind: 'dropoff', name: 'You', area: 'Mile 12', yours: true, done: false },
    { kind: 'dropoff', name: 'Ada', area: 'Ikorodu Garage', yours: false, done: false },
  ] };
  const s = server(confirmed(group));
  const page = await loadPage(s);
  assert.equal(page.el('d-group').hidden, false);
  assert.equal(page.el('d-group-title').textContent, 'Group ride · with Ada');
  assert.deepEqual(stopsText(page), ['done|Ada gets in · Yaba', 'yours|You get in · Ketu', 'yours|You get out · Mile 12', '-|Ada gets out · Ikorodu Garage']);
  s.state = confirmed(null);
  await page.poll();
  assert.equal(page.el('d-group').hidden, true);
});

test('markup: one selfie input for the front camera; no inline styles', () => {
  const fs = require('node:fs');
  const html = fs.readFileSync(require('node:path').join(__dirname, '../apps/api-gateway/widget/ride/ride.html'), 'utf8');
  const sheet = html.slice(html.indexOf('id="sheet-group"'), html.indexOf('<!-- The waiting price'));
  assert.match(sheet, /type="file" accept="image\/\*" capture="user" id="group-camera"/);
  assert.doesNotMatch(sheet, /style="/);
});
