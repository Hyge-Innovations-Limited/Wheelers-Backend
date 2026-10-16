/**
 * Outer areas cost more: drivers are few in Ikorodu, Epe, Ibeju-Lekki and
 * Badagry, and come back empty from them.
 *
 *   node --test test/pricing-areas.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('@wheleers/config');

const YABA = { lat: 6.5095, lng: 3.3711 };
const IKORODU = { lat: 6.6194, lng: 3.5105 };
const ILEMERE = { lat: 6.5446, lng: 3.4894 };
const EPE = { lat: 6.5841, lng: 3.9834 };
const LEKKI_PHASE_1 = { lat: 6.4474, lng: 3.474 };

const price = (km, minutes, ends) => config.calculateSuggestedFare(km, { durationSeconds: minutes * 60, ...ends });

test.beforeEach(() => config.setPricingSettings({}));

test('the four outer areas are where they should be, and the city is in none', () => {
  assert.equal(config.pricingAreaOf(IKORODU.lat, IKORODU.lng)?.key, 'ikorodu');
  assert.equal(config.pricingAreaOf(ILEMERE.lat, ILEMERE.lng)?.key, 'ikorodu');
  assert.equal(config.pricingAreaOf(EPE.lat, EPE.lng)?.key, 'epe');
  assert.equal(config.pricingAreaOf(6.43, 3.75)?.key, 'ibeju-lekki');
  assert.equal(config.pricingAreaOf(6.415, 2.8813)?.key, 'badagry');
  for (const p of [YABA, LEKKI_PHASE_1, { lat: 6.6018, lng: 3.3515 }]) assert.equal(config.pricingAreaOf(p.lat, p.lng), null);
});

test('a trip from Ikorodu takes the pickup factor; one into Ikorodu the drop-off factor; the larger wins', () => {
  const city = price(25, 55, { origin: YABA, destination: LEKKI_PHASE_1 });
  const from = price(25, 55, { origin: IKORODU, destination: YABA });
  const into = price(25, 55, { origin: YABA, destination: IKORODU });
  assert.equal(city.areaFactor, 1);
  assert.equal(city.area, null);
  assert.equal(from.areaFactor, 1.4);
  assert.equal(from.area, 'ikorodu');
  assert.equal(into.areaFactor, 1.25);
  assert.ok(from.suggestedFareNgn > into.suggestedFareNgn && into.suggestedFareNgn > city.suggestedFareNgn);
  assert.ok(from.suggestedFareNgn >= Math.floor(city.suggestedFareNgn * 1.4 / 50) * 50, 'about 1.4 times the city price');
  assert.ok(from.maxOfferNgn > city.maxOfferNgn, 'drivers may ask more there too');
  const epeToIkorodu = price(40, 70, { origin: EPE, destination: IKORODU });
  assert.equal(epeToIkorodu.areaFactor, 1.45);
});

test('with the floor on, what the other app charges in Ikorodu is lifted too: the floor follows the area', () => {
  config.setPricingSettings({ marketFloorOn: true });
  const city = price(25, 55, { origin: YABA, destination: LEKKI_PHASE_1 });
  const ikorodu = price(25, 55, { origin: IKORODU, destination: YABA });
  assert.ok(Math.abs(ikorodu.marketFareNgn / city.marketFareNgn - 1.4) < 0.001);
  assert.ok(ikorodu.floorFareNgn > city.floorFareNgn);
});

test('saved factors are kept in range: never under 1, never over the cap; a missing area keeps its default', () => {
  const s = config.setPricingSettings({ areas: { ikorodu: { pickup: 9, dropoff: 0.2 }, epe: { pickup: 'x' } } });
  assert.deepEqual(s.areas.ikorodu, { pickup: config.AREA_FACTOR_MAX, dropoff: 1 });
  assert.equal(s.areas.epe.pickup, 1.45);
  assert.deepEqual(s.areas.badagry, { pickup: 1.45, dropoff: 1.3 });
  config.setPricingSettings({ areas: { ikorodu: { pickup: 1, dropoff: 1 } } });
  assert.equal(price(25, 55, { origin: IKORODU, destination: YABA }).areaFactor, 1, 'set to 1, Ikorodu is priced like the city');
});

test.after(() => config.setPricingSettings({}));
