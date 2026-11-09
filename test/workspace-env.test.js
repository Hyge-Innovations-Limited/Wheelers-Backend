// The services and the scripts read the same .env the same way: a space left
// after a value, or around the "=", never reaches a provider as part of a key.
//
//   node --test test/workspace-env.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseWorkspaceEnv } = require('../packages/config/dist/load-workspace-env.js');

const read = (text) => Object.fromEntries(parseWorkspaceEnv(text));

test('a value is taken without the spaces around it, quoted or not', () => {
  const env = read([
    'TWILIO_ACCOUNT_SID=AC123 ',
    'TWILIO_AUTH_TOKEN= secret',
    'TERMII_SENDER_ID="Wheelers" ',
    "SMS_PROVIDER='termii'",
    'PLAIN=value',
    'WITH_SPACES_INSIDE=two words',
    'TAB_AFTER=abc\t',
  ].join('\n'));
  assert.equal(env.TWILIO_ACCOUNT_SID, 'AC123');
  assert.equal(env.TWILIO_AUTH_TOKEN, 'secret');
  assert.equal(env.TERMII_SENDER_ID, 'Wheelers', 'the space after the closing quote does not keep the quotes on');
  assert.equal(env.SMS_PROVIDER, 'termii');
  assert.equal(env.PLAIN, 'value');
  assert.equal(env.WITH_SPACES_INSIDE, 'two words');
  assert.equal(env.TAB_AFTER, 'abc');
});

test('Windows line endings, comments, blank lines and a key written over several lines still read right', () => {
  const env = read('# a comment\r\n\r\nA=1\r\nB=2 \r\nKEY=-----BEGIN PRIVATE KEY-----\nabc\ndef\n-----END PRIVATE KEY-----\nC="x\\ny"\n');
  assert.equal(env.A, '1');
  assert.equal(env.B, '2');
  assert.equal(env.KEY, '-----BEGIN PRIVATE KEY-----\nabc\ndef\n-----END PRIVATE KEY-----');
  assert.equal(env.C, 'x\ny');
  assert.equal(Object.keys(env).length, 4);
});
