// Pricing version 4 (3 Nov 2026): no booking fee. The ₦300 WhatsApp fee comes off the fare; VAT 7.5%,
// the ₦30 levy and 5% commission come out of what is left. Prices are built as in version 3.
// These tests check the pricing rules themselves, before the recommended cut (pricing.ts RECOMMENDED_CUT_PERCENT).
process.env.PRICING_RECOMMENDED_CUT_PERCENT = '0';
const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateRideFees, CURRENT_PRICING_VERSION, pricingVersionOf, tripFareNgn, fareFromRatePerKmNgn } = require('../packages/config/dist/index.js');

test('a ₦3,300 ride: 3,000 after the WhatsApp fee, then VAT 225, levy 30, commission 150: the driver gets ₦2,595', () => {
  const f = calculateRideFees(3300, 4);
  assert.equal(f.bookingFeeNgn, 0);
  assert.equal(f.whatsappFeeNgn, 300);
  assert.equal(f.tripFareNgn, 3000);
  assert.equal(f.vatNgn, 225);
  assert.equal(f.stateLevyNgn, 30);
  assert.equal(f.commissionNgn, 150);
  assert.equal(f.driverPayoutNgn, 2595);
  assert.equal(f.platformTotalNgn, 705);
  assert.equal(f.totalNgn, 3300);
});

test('every line adds up to what the rider paid, at any fare', () => {
  for (const fare of [3300, 3350, 4150, 5025.5, 12800, 47250]) {
    const f = calculateRideFees(fare, 4);
    const parts = Math.round((f.driverPayoutNgn + f.whatsappFeeNgn + f.vatNgn + f.stateLevyNgn + f.commissionNgn) * 100) / 100;
    assert.equal(parts, f.fareNgn, `fare ${fare}`);
    assert.equal(f.platformTotalNgn, Math.round((f.fareNgn - f.driverPayoutNgn) * 100) / 100);
  }
});

test('a fare settled too small never makes the driver pay to work', () => {
  for (const fare of [0, 100, 300, 320, 400]) {
    const f = calculateRideFees(fare, 4);
    assert.ok(f.driverPayoutNgn >= 0, `fare ${fare}`);
    const parts = Math.round((f.driverPayoutNgn + f.whatsappFeeNgn + f.vatNgn + f.stateLevyNgn + f.commissionNgn) * 100) / 100;
    assert.equal(parts, f.fareNgn, `fare ${fare} still adds up`);
  }
});

test('new rides are version 4; rides already priced keep their own rules', () => {
  assert.equal(CURRENT_PRICING_VERSION, 4);
  assert.equal(pricingVersionOf(4), 4);
  assert.equal(pricingVersionOf('4'), 4);
  assert.equal(calculateRideFees(3300, 3).driverPayoutNgn, 2276.98, 'version 3 unchanged');
  assert.equal(calculateRideFees(3300, 3).bookingFeeNgn, 350);
});

test('prices are built exactly as before: the rate per km and the fare it makes do not move', () => {
  assert.equal(tripFareNgn(3300), tripFareNgn(3300, 3));
  assert.equal(tripFareNgn(4150), tripFareNgn(4150, 3));
  assert.equal(fareFromRatePerKmNgn(350, 10), 4150);
});
