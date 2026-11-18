// Group ride on live searches, stage 1: who could ride together (Timi, 16–17 Nov 2026). Riders searching for a
// driver who head along the same road; fair to each (no one more than the bigger of 8 min or 25% extra), worth it
// (5 min less driving than all alone), wallet, 3 people, no pets; seats 25% off, never under ₦1,950.
// Real Lagos points along Ikorodu Road. GROUP_RIDE_LIVE=dryrun logs, nobody is asked yet.
//
//   node --test test/group-ride-live.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { findGroups, planGroup, roadCells, projectOnto } = require('../apps/group-ride/dist/live/match.js');
const { createLiveMatcher, searchFromRequested } = require('../apps/group-ride/dist/live/live-matcher.js');
const { groupSeatPriceNgn, groupSeatFloorNgn, groupRideLiveMode } = require('../packages/config/dist/index.js');

const P = {
  yaba: { lat: 6.5095, lng: 3.3711, address: 'Yaba' },
  sabo: { lat: 6.5050, lng: 3.3790, address: 'Sabo' },
  fadeyi: { lat: 6.5330, lng: 3.3660, address: 'Fadeyi' },
  maryland: { lat: 6.5720, lng: 3.3670, address: 'Maryland' },
  ojota: { lat: 6.5850, lng: 3.3790, address: 'Ojota' },
  ketu: { lat: 6.5960, lng: 3.3910, address: 'Ketu' },
  mile12: { lat: 6.6060, lng: 3.4040, address: 'Mile 12' },
  owode: { lat: 6.6120, lng: 3.4400, address: 'Owode Onirin' },
  ikorodu: { lat: 6.6190, lng: 3.5100, address: 'Ikorodu Garage' },
  lekki: { lat: 6.4400, lng: 3.4700, address: 'Lekki' },
  ajah: { lat: 6.4680, lng: 3.5850, address: 'Ajah' },
};
const road = (...names) => names.map((n) => ({ lat: P[n].lat, lng: P[n].lng }));
const NOW = Date.parse('2026-11-17T08:00:00Z');
let n = 0;
const search = (from, to, extra = {}) => ({
  rideId: `ride-${(n += 1)}`, riderId: `rider-${n}`, pickup: P[from], destination: P[to], route: [], people: 1, pet: false,
  paymentMethod: 'WALLET', offerNgn: 12000, openedAtMs: NOW - 60_000, ...extra,
});
const yabaIkorodu = (extra) => search('yaba', 'ikorodu', { route: road('yaba', 'fadeyi', 'maryland', 'ojota', 'ketu', 'mile12', 'owode', 'ikorodu'), ...extra });
const ketuIkorodu = (extra) => search('ketu', 'ikorodu', { route: road('ketu', 'mile12', 'owode', 'ikorodu'), offerNgn: 9000, ...extra });

test('the seat: 25% off the rider\'s own price, to ₦50, never under ₦1,950 and never above their own price', () => {
  assert.equal(groupSeatFloorNgn(2600), 1950);
  assert.equal(groupSeatPriceNgn(12000, 2600), 9000);
  assert.equal(groupSeatPriceNgn(9000, 2600), 6750);
  assert.equal(groupSeatPriceNgn(2600, 2600), 1950);
  assert.equal(groupSeatPriceNgn(3100, 2600), 2350, '₦2,325 to the nearest ₦50');
  assert.equal(groupSeatPriceNgn(1800, 2600), 1800, 'never more than they offered');
  assert.equal(groupRideLiveMode({}), 'off');
  assert.equal(groupRideLiveMode({ GROUP_RIDE_LIVE: 'DryRun' }), 'dryrun');
  assert.equal(groupRideLiveMode({ GROUP_RIDE_LIVE: 'yes' }), 'off');
});

test('Yaba → Ikorodu and Ketu → Ikorodu ride together: Ketu is on the road, so it costs Yaba almost nothing', () => {
  const a = yabaIkorodu();
  const b = ketuIkorodu();
  const plan = planGroup([a, b]);
  assert.ok(plan, 'grouped');
  assert.deepEqual(plan.stops.slice(0, 2).map((s) => s.address), ['Yaba', 'Ketu'], 'Yaba first, Ketu on the way');
  const yaba = plan.members.find((m) => m.rideId === a.rideId);
  assert.ok(yaba.extraSeconds < 3 * 60, `Yaba's extra: ${yaba.extraSeconds}s`);
  assert.ok(plan.savedSeconds >= 5 * 60, `saved ${plan.savedSeconds}s`);
  assert.deepEqual(plan.members.map((m) => m.seatPriceNgn), [9000, 6750]);
  // The shortlist finds them: Ketu's pickup is on Yaba's road.
  assert.ok(roadCells(a).size > 10);
  assert.ok(projectOnto(a.route, P.ketu).offKm < 0.1);
  assert.equal(findGroups([a, b], new Set(), NOW).length, 1);
});

test('Yaba and Sabo, 1 km apart, to Ikorodu: grouped; Lekki → Ikorodu with Yaba: not (far off the road)', () => {
  const a = yabaIkorodu();
  const sabo = search('sabo', 'ikorodu');
  assert.ok(planGroup([a, sabo]), 'Sabo is next to Yaba');
  const lekki = search('lekki', 'ikorodu');
  const groups = findGroups([yabaIkorodu(), lekki], new Set(), NOW);
  assert.equal(groups.length, 0, 'never even compared, and not fair if it were');
  assert.equal(planGroup([yabaIkorodu(), lekki]), null);
});

test('not the same way, cash, a pet, too many people, the same rider twice, own stops: never grouped', () => {
  assert.equal(planGroup([yabaIkorodu(), search('yaba', 'ajah')]), null, 'Yaba → Ajah heads elsewhere');
  assert.equal(planGroup([yabaIkorodu(), ketuIkorodu({ paymentMethod: 'CASH' })]), null, 'wallet only');
  assert.equal(planGroup([yabaIkorodu(), ketuIkorodu({ pet: true })]), null, 'no pets');
  assert.equal(planGroup([yabaIkorodu({ people: 2 }), ketuIkorodu({ people: 2 })]), null, '4 people do not fit');
  assert.ok(planGroup([yabaIkorodu({ people: 2 }), ketuIkorodu()]), '3 people do');
  const mine = yabaIkorodu();
  assert.equal(findGroups([mine, ketuIkorodu({ riderId: mine.riderId })], new Set(), NOW).length, 0, 'one rider, two searches');
  assert.equal(searchFromRequested({ eventType: 'RIDE_REQUESTED', rideId: 'r', riderId: 'u', pickup: P.yaba, destination: P.ikorodu, stops: [P.ketu], riderOfferNgn: 5000, paymentMethod: 'WALLET' }, NOW), null, 'a booking with its own stops');
});

test('three along the road make a group of 3, chosen over any pair; a search already in an offer is left out', () => {
  const a = yabaIkorodu();
  const b = ketuIkorodu();
  const c = search('ojota', 'ikorodu', { route: road('ojota', 'ketu', 'mile12', 'owode', 'ikorodu'), offerNgn: 10000 });
  const [group] = findGroups([a, b, c], new Set(), NOW);
  assert.equal(group.rideIds.length, 3);
  assert.deepEqual(group.stops.filter((s) => s.kind === 'pickup').map((s) => s.address), ['Yaba', 'Ojota', 'Ketu']);
  for (const m of group.members) assert.ok(m.extraSeconds <= Math.max(8 * 60, 0.25 * m.soloSeconds), `${m.rideId} extra ${m.extraSeconds}s`);
  const without = findGroups([a, b, c], new Set([c.rideId]), NOW);
  assert.equal(without.length, 1);
  assert.deepEqual(new Set(without[0].rideIds), new Set([a.rideId, b.rideId]));
});

test('the live list: searches from the events, a changed price, a search that ends; dryrun logs each group once', async () => {
  const logs = [];
  let t = NOW;
  const matcher = createLiveMatcher({ mode: 'dryrun', now: () => t, log: (message, details) => logs.push({ message, details }) });
  const requested = (id, rider, from, to, route, price) => ({
    eventType: 'RIDE_REQUESTED', rideId: id, riderId: rider, pickup: P[from], destination: P[to], stops: [], riderOfferNgn: price,
    paymentMethod: 'WALLET', route: { coordinates: route, bounds: { northEast: P.ikorodu, southWest: P.yaba } }, timestamp: new Date(t).toISOString(),
  });
  matcher.onRideEvent(requested('11111111-1111-4111-8111-111111111111', 'u1', 'yaba', 'ikorodu', road('yaba', 'fadeyi', 'maryland', 'ojota', 'ketu', 'mile12', 'owode', 'ikorodu'), 12000));
  matcher.onRideEvent(requested('22222222-2222-4222-8222-222222222222', 'u2', 'ketu', 'ikorodu', road('ketu', 'mile12', 'owode', 'ikorodu'), 9000));
  matcher.onRideEvent({ eventType: 'RIDE_RIDER_COUNTER_OFFER', rideId: '22222222-2222-4222-8222-222222222222', riderId: 'u2', counterOfferNgn: 10000 });
  assert.equal(matcher.size(), 2);

  const first = await matcher.round();
  assert.equal(first.length, 1);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].message, 'dryrun: would offer a group ride');
  assert.deepEqual(logs[0].details.seats.map((s) => s.seat), [9000, 7500], 'the new price, 25% off');
  t += 5_000;
  assert.equal((await matcher.round()).length, 0, 'held: not logged again');

  matcher.onRideEvent({ eventType: 'RIDE_CANCELLED', rideId: '22222222-2222-4222-8222-222222222222' });
  assert.equal(matcher.size(), 1);
  t += 60_000;
  assert.equal((await matcher.round()).length, 0);
  t += 10 * 60_000;
  await matcher.round();
  assert.equal(matcher.size(), 0, 'a search past its window is dropped');

  const off = createLiveMatcher({ mode: 'off', now: () => t });
  off.onRideEvent(requested('33333333-3333-4333-8333-333333333333', 'u3', 'yaba', 'ikorodu', road('yaba', 'ikorodu'), 5000));
  assert.equal(off.size(), 0, 'off: nothing kept, nothing matched');
});
