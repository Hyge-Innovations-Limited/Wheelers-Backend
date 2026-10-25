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

test('the outer areas and the dearer ones inside Lagos are where they should be; Yaba and the Island are the standard', () => {
  assert.equal(config.pricingAreaOf(IKORODU.lat, IKORODU.lng)?.key, 'ikorodu');
  assert.equal(config.pricingAreaOf(ILEMERE.lat, ILEMERE.lng)?.key, 'ikorodu');
  assert.equal(config.pricingAreaOf(EPE.lat, EPE.lng)?.key, 'epe');
  assert.equal(config.pricingAreaOf(6.43, 3.75)?.key, 'ibeju-lekki');
  assert.equal(config.pricingAreaOf(6.415, 2.8813)?.key, 'badagry');
  // Inside Lagos, priced against Yaba and the Island.
  assert.equal(config.pricingAreaOf(LEKKI_PHASE_1.lat, LEKKI_PHASE_1.lng)?.key, 'lekki');
  assert.equal(config.pricingAreaOf(6.6018, 3.3515)?.key, 'ikeja');
  assert.equal(config.pricingAreaOf(6.5715, 3.3676)?.key, 'maryland', 'Maryland, though inside Ikeja\'s box');
  assert.equal(config.pricingAreaOf(6.495, 3.355)?.key, 'surulere');
  assert.equal(config.pricingAreaOf(6.467, 3.571)?.key, 'ajah');
  // The standard: Yaba, Unilag, Victoria Island, Ikoyi, each in its local government and ×1 there.
  const standard = [[{ lat: 6.507, lng: 3.378 }, 'lagos-mainland'], [{ lat: 6.5158, lng: 3.3896 }, 'shomolu'], [{ lat: 6.428, lng: 3.42 }, 'eti-osa'], [{ lat: 6.452, lng: 3.435 }, 'eti-osa']];
  for (const [p, key] of standard) {
    assert.equal(config.pricingAreaOf(p.lat, p.lng)?.key, key);
    assert.deepEqual(config.getPricingSettings().areas[key], { pickup: 1, dropoff: 1 });
  }
});

test('every local government in Lagos is an area of its own, one area for any point, each ×1 until set or learned', () => {
  const lgas = ['agege', 'ajeromi-ifelodun', 'alimosho', 'amuwo-odofin', 'apapa', 'badagry', 'epe', 'eti-osa', 'ibeju-lekki', 'ifako-ijaiye',
    'ikeja', 'ikorodu', 'kosofe', 'lagos-island', 'lagos-mainland', 'mushin', 'ojo', 'oshodi-isolo', 'shomolu', 'surulere'];
  const keys = config.PRICING_AREAS.map((a) => a.key);
  for (const lga of lgas) assert.ok(keys.includes(lga), lga);
  assert.equal(new Set(keys).size, keys.length, 'no area twice');
  // Places on the edge of town and the trips that were cheap.
  assert.equal(config.pricingAreaOf(6.665, 3.27)?.key, 'alimosho', 'Alagbado');
  assert.equal(config.pricingAreaOf(6.645, 3.30)?.key, 'alimosho', 'Abule Egba');
  assert.equal(config.pricingAreaOf(6.591, 3.357)?.key, 'ikeja', '108 Opebi Road');
  assert.equal(config.pricingAreaOf(6.498, 3.336)?.key, 'surulere', 'Ijeshatedo');
  assert.equal(config.pricingAreaOf(6.466, 3.284)?.key, 'amuwo-odofin', 'Festac');
  assert.equal(config.pricingAreaOf(6.555, 3.39)?.key, 'kosofe', 'Gbagada');
  // Each centre is in its own area, and a new one prices as the standard until set.
  for (const area of config.PRICING_AREAS) assert.equal(config.pricingAreaOf(area.center[0], area.center[1])?.key, area.key, area.key);
  config.setPricingSettings({});
  assert.deepEqual(config.getPricingSettings().areas.alimosho, { pickup: 1, dropoff: 1 });
  config.setPricingSettings({ areas: { alimosho: { pickup: 1.1, dropoff: 1.15 } } });
  assert.equal(price(16, 35, { origin: { lat: 6.6018, lng: 3.3515 }, destination: { lat: 6.665, lng: 3.27 } }).areaFactor, 1.15, 'Ikeja to Alagbado takes Alimosho\'s drop-off factor');
  config.setPricingSettings({});
});

test('a trip from Ikorodu takes the pickup factor; one into Ikorodu the drop-off factor; the larger wins', () => {
  const city = price(25, 55, { origin: YABA, destination: LEKKI_PHASE_1 });
  const from = price(25, 55, { origin: IKORODU, destination: YABA });
  const into = price(25, 55, { origin: YABA, destination: IKORODU });
  assert.equal(city.areaFactor, 1);
  assert.equal(city.area, null);
  assert.equal(from.areaFactor, 1.65);
  assert.equal(from.area, 'ikorodu');
  assert.equal(into.areaFactor, 1.5);
  assert.ok(from.suggestedFareNgn > into.suggestedFareNgn && into.suggestedFareNgn > city.suggestedFareNgn);
  assert.ok(from.suggestedFareNgn >= Math.floor(city.suggestedFareNgn * 1.65 / 50) * 50, 'about 1.65 times the city price');
  assert.ok(from.maxOfferNgn > city.maxOfferNgn, 'drivers may ask more there too');
  const epeToIkorodu = price(40, 70, { origin: EPE, destination: IKORODU });
  assert.equal(epeToIkorodu.areaFactor, 1.7);
});

test('with the floor on, what the other app charges in Ikorodu is lifted too: the floor follows the area', () => {
  config.setPricingSettings({ marketFloorOn: true });
  const city = price(25, 55, { origin: YABA, destination: LEKKI_PHASE_1 });
  const ikorodu = price(25, 55, { origin: IKORODU, destination: YABA });
  assert.ok(Math.abs(ikorodu.marketFareNgn / city.marketFareNgn - 1.65) < 0.001);
  assert.ok(ikorodu.floorFareNgn > city.floorFareNgn);
});

test('saved factors are kept in range: never under 1, never over the cap; a missing area keeps its default', () => {
  const s = config.setPricingSettings({ areas: { ikorodu: { pickup: 9, dropoff: 0.2 }, epe: { pickup: 'x' } } });
  assert.deepEqual(s.areas.ikorodu, { pickup: config.AREA_FACTOR_MAX, dropoff: 1 });
  assert.equal(s.areas.epe.pickup, 1.7);
  assert.deepEqual(s.areas.badagry, { pickup: 1.7, dropoff: 1.5 });
  config.setPricingSettings({ areas: { ikorodu: { pickup: 1, dropoff: 1 } } });
  assert.equal(price(25, 55, { origin: IKORODU, destination: YABA }).areaFactor, 1, 'set to 1, Ikorodu is priced like the city');
});

test.after(() => config.setPricingSettings({}));
