const test = require('node:test');
const assert = require('node:assert/strict');
const { vehicleTankLitres, VEHICLE_TANKS } = require('../packages/config/dist/index.js');

test('known cars resolve, forgivingly', () => {
  assert.equal(vehicleTankLitres('Toyota', 'Corolla', 2010), 50);
  assert.equal(vehicleTankLitres('toyota', ' corolla LE ', 2016), 50);
  assert.equal(vehicleTankLitres('TOYOTA', 'Camry', 2015), 64);
  assert.equal(vehicleTankLitres('Toyota', 'Camry', 2019), 60);
  assert.equal(vehicleTankLitres('Toyota', 'Highlander', 2012), 73);
  assert.equal(vehicleTankLitres('Toyota', 'Sienna', 2012), null, 'not certain, so not listed');
  assert.equal(vehicleTankLitres('Honda', 'CR-V', 2012), 58);
  assert.equal(vehicleTankLitres('Honda', 'Accord', 2010), 70);
  assert.equal(vehicleTankLitres('Lexus', 'RX 350', 2012), 73);
  assert.equal(vehicleTankLitres('Kia', 'Forte', 2012), null, 'not certain, so not listed');
  assert.equal(vehicleTankLitres('Mercedes-Benz', 'C 300', 2012), 66);
  assert.equal(vehicleTankLitres('Mercedes Benz', 'C-Class', 2012), 66);
  assert.equal(vehicleTankLitres('Benz', 'E350', 2010), 80);
  assert.equal(vehicleTankLitres('Toyota', 'Toyota Corolla', 2010), 50);
});

test('unknown car, unknown year, missing data: null, never a guess', () => {
  assert.equal(vehicleTankLitres('Toyota', 'Hilux', 2012), null);
  assert.equal(vehicleTankLitres('Peugeot', '406', 2005), null);
  assert.equal(vehicleTankLitres('Toyota', 'Corolla', 1995), null);
  assert.equal(vehicleTankLitres('Toyota', 'Camry', 2008), null, 'a year no range covers');
  assert.equal(vehicleTankLitres('Toyota', 'Corolla', 2030), null);
  assert.equal(vehicleTankLitres('Toyota', 'Corolla', null), null);
  assert.equal(vehicleTankLitres(null, 'Corolla', 2010), null);
  assert.equal(vehicleTankLitres('Toyota', '', 2010), null);
});

test('every entry has a source and a sane range and size', () => {
  for (const e of VEHICLE_TANKS) {
    assert.ok(e.source.length > 3);
    assert.ok(e.from <= e.to && e.litres > 30 && e.litres < 120);
  }
});
