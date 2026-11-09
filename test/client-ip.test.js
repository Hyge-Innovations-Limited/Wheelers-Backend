/**
 * Whose address a request carries: only headers something we run wrote are believed.
 *
 *   node --test test/client-ip.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { clientIp } = require('../apps/api-gateway/dist/utils/client-ip.js');

const req = (headers, remoteAddress = '127.0.0.1') => ({ headers, socket: { remoteAddress } });

test('before Cloudflare is in front, a CF-Connecting-IP sent by anyone is ignored', () => {
  delete process.env.TRUST_CLOUDFLARE_IP;
  assert.equal(clientIp(req({ 'cf-connecting-ip': '1.2.3.4', 'x-forwarded-for': '41.58.10.20' })), '41.58.10.20');
});

test('the last X-Forwarded-For entry is what our nginx saw; what the caller wrote before it is not believed', () => {
  delete process.env.TRUST_CLOUDFLARE_IP;
  assert.equal(clientIp(req({ 'x-forwarded-for': '9.9.9.9, 41.58.10.20' })), '41.58.10.20');
  assert.equal(clientIp(req({ 'x-forwarded-for': '41.58.10.20' })), '41.58.10.20');
});

test('once the server takes web traffic from Cloudflare alone, its header names the visitor', () => {
  process.env.TRUST_CLOUDFLARE_IP = 'true';
  try {
    assert.equal(clientIp(req({ 'cf-connecting-ip': '41.58.10.20', 'x-forwarded-for': '41.58.10.20, 172.70.1.1' })), '41.58.10.20');
  } finally {
    delete process.env.TRUST_CLOUDFLARE_IP;
  }
});

test('no headers: the connection itself', () => {
  assert.equal(clientIp(req({}, '41.58.10.20')), '41.58.10.20');
});
