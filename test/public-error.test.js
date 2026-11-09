/**
 * Every refusal a person sees is in our words: a sentence written for people
 * passes, anything written for engineers is replaced, and the original is logged.
 *
 *   node --test test/public-error.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { publicMessage, isPersonFacing } = require('../apps/api-gateway/dist/http/public-error.js');
const { sendJson } = require('../apps/api-gateway/dist/http/utils.js');

test('a sentence written for people passes as it is', () => {
  for (const said of [
    'You need a Wheelers wallet before booking.',
    'Wheelers is only in Lagos for now. We will let you know when we come to your area.',
    'That code is not right. Check the email and try again.',
    'Enter a valid phone number with the country code, for example +2348012345678.',
  ]) assert.equal(publicMessage(said, 400), said);
});

test('anything written for engineers becomes ours', () => {
  const technical = [
    'Invalid `prisma.user.findUnique()` invocation: Unique constraint failed on the fields: (`email`)',
    'connect ECONNREFUSED 127.0.0.1:5432',
    "Cannot read properties of undefined (reading 'lat')",
    'Unexpected token < in JSON at position 0',
    'TypeError: fetch failed',
    'Body must be a JSON object',
    'pickup.lat must be a finite number',
    'Request failed with status code 502',
    '{"error":"bad"}',
    'x'.repeat(300),
  ];
  for (const said of technical) assert.equal(isPersonFacing(said), false, said);
  assert.equal(publicMessage(technical[0], 500), 'Something went wrong on our side. Please try again in a moment.');
  assert.equal(publicMessage(technical[5], 400), 'That did not work. Please check and try again.');
  assert.equal(publicMessage(undefined, 401), 'Please sign in again.');
});

test('every reply goes through it: the person gets ours, the log keeps the original', () => {
  let body;
  const res = { setHeader() {}, end(text) { body = JSON.parse(text); }, statusCode: 0 };
  const logged = [];
  const warn = console.warn;
  console.warn = (...args) => logged.push(args);
  try {
    sendJson(res, 500, { error: 'Invalid `prisma.ride.create()` invocation', code: 'X' });
  } finally {
    console.warn = warn;
  }
  assert.equal(res.statusCode, 500);
  assert.deepEqual(body, { error: 'Something went wrong on our side. Please try again in a moment.', code: 'X' });
  assert.match(JSON.stringify(logged), /prisma\.ride\.create/);

  sendJson(res, 200, { error: 'Invalid `prisma` text is left alone on a success' });
  assert.match(body.error, /prisma/, 'only refusals are rewritten');
});
