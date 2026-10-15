/**
 * A spot reads like a place, never a Plus Code; a vague match does not hide the real ones.
 *
 *   node --test test/place-labels.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { placeLabelFromResults, isVagueAddress } = require('../apps/api-gateway/dist/LLM/geocoding.js');
const google = require('./fixtures/google-reverse.json');

test('a shared pin is named from all of Google\'s answers: street or place, area, town', () => {
  assert.equal(placeLabelFromResults(google.ilemereOrupodi), 'Orupodi, Ilemere, Ikorodu', 'Google\'s first answer there is "GFVQ+VQ4, … Ikorodu, Ikorodu"');
  assert.equal(placeLabelFromResults(google.ilemereAdebs), 'Adebs Rd, Ilemere, Ikorodu');
  assert.equal(placeLabelFromResults(google.yaba), '3 Herbert Macaulay Way, Yaba');
  assert.equal(placeLabelFromResults(google.lekkiPhase1), '68 Admiralty Way, Lekki Phase I, Lekki');
  assert.equal(placeLabelFromResults([]), null);
});

test('a match naming only the city is vague; one with an area is not', () => {
  assert.equal(isVagueAddress('15 Aiyetoro Street, Lagos'), true);
  assert.equal(isVagueAddress('Aiyetoro Street, Lagos, Nigeria'), true);
  assert.equal(isVagueAddress('15 Aiyetoro Street, Akoka, Lagos 100001, Lagos, Nigeria'), false);
  assert.equal(isVagueAddress('Ikeja City Mall, Obafemi Awolowo Way, Ojodu'), false);
});
