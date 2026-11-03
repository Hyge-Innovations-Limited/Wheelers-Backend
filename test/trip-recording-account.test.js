// Trip recordings can live in the backup Cloudflare account (TRIP_RECORDING_R2_ACCOUNT=backup, 4 Nov 2026):
// the storage talks to that account, at its jurisdiction's address when it has one.
//
//   node --test test/trip-recording-account.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { TripRecordingStorage } = require('../apps/api-gateway/dist/storage/trip-recording-storage.js');

const endpointOf = async (storage) => {
  const e = await storage.s3.config.endpoint();
  return `${e.protocol}//${e.hostname}`;
};

test('the account the storage talks to, with or without a jurisdiction', async () => {
  const plain = new TripRecordingStorage({ accountId: 'acc1', accessKeyId: 'k', secretAccessKey: 's', bucket: 'wheelers-trip-recordings' });
  assert.equal(await endpointOf(plain), 'https://acc1.r2.cloudflarestorage.com');
  const eu = new TripRecordingStorage({ accountId: 'acc2', accessKeyId: 'k', secretAccessKey: 's', bucket: 'wheelers-trip-recordings', jurisdiction: 'eu' });
  assert.equal(await endpointOf(eu), 'https://acc2.eu.r2.cloudflarestorage.com');
  assert.equal(plain.bucketName, 'wheelers-trip-recordings');
});

