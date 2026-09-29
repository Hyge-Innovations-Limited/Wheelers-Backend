// Stellar Testnet (grant deliverable 3): keys derived, never stored; testnet
// only; account opening, top-ups, a trip's fare and commission, and a
// driver's withdrawal, each sent once and confirmed. Against a fake Stellar
// network (no internet needed) and the real local Postgres.
//
//   node scripts/run-with-env.cjs node --test --test-force-exit test/stellar.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomBytes } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const sdk = require('../apps/api-gateway/node_modules/@stellar/stellar-sdk');

const { stellarConfigFromEnv } = require('../apps/api-gateway/dist/stellar/config.js');
const { keypairAt } = require('../apps/api-gateway/dist/stellar/keys.js');
const { StellarSubmitError } = require('../apps/api-gateway/dist/stellar/network.js');
const { createStellarService } = require('../apps/api-gateway/dist/stellar/service.js');

const prisma = new PrismaClient();

/* ── what needs no database ─────────────────────────────────────────────── */

test('keys follow SEP-0005 (the published test vector) and are different per account', () => {
  // SEP-0005 test 1: "illness spike retreat truth genius clock brain pass fit cave bargain toe", m/44'/148'/0'.
  const seed = Buffer.from('e4a5a632e70943ae7f07659df1332160937fad82587216a4c64315a0fb39497ee4a01f76ddab4cba68147977f3a147b6ad584c41808e8238a07f6cc4b582f186', 'hex');
  assert.equal(keypairAt(seed, 0).publicKey(), 'GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6');
  assert.notEqual(keypairAt(seed, 1).publicKey(), keypairAt(seed, 0).publicKey());
  assert.equal(keypairAt(seed, 7).publicKey(), keypairAt(seed, 7).publicKey(), 'the same number always gives the same account');
});

test('testnet only: off by default, and anything that is not testnet stops it', () => {
  const seed = randomBytes(32).toString('hex');
  assert.equal(stellarConfigFromEnv({}), null);
  assert.equal(stellarConfigFromEnv({ STELLAR_ENABLED: 'true', STELLAR_MASTER_SEED: seed }).networkPassphrase, sdk.Networks.TESTNET);
  assert.throws(() => stellarConfigFromEnv({ STELLAR_ENABLED: 'true', STELLAR_MASTER_SEED: seed, STELLAR_NETWORK: 'public' }), /only testnet/);
  assert.throws(() => stellarConfigFromEnv({ STELLAR_ENABLED: 'true', STELLAR_MASTER_SEED: seed, STELLAR_HORIZON_URL: 'https://horizon.stellar.org' }), /not a testnet Horizon/);
  assert.throws(() => stellarConfigFromEnv({ STELLAR_ENABLED: 'true', STELLAR_MASTER_SEED: 'short' }), /STELLAR_MASTER_SEED/);
});

/* ── a fake Stellar network: balances, sequences, signatures, fee bumps ── */

function fakeNetwork() {
  const accounts = new Map();        // publicKey → { sequence: bigint, balance: number }
  const ledgerTxs = new Map();       // hash → { ledger, successful, memo, feeSource, source }
  let ledger = 100;
  const net = {
    accounts, ledgerTxs, submits: 0, cutNext: false,
    async account(publicKey) {
      const a = accounts.get(publicKey);
      return a ? { sequence: a.sequence.toString(), balanceXlm: a.balance.toFixed(7) } : null;
    },
    async fund(publicKey) {
      if (accounts.has(publicKey)) throw new Error('already funded');
      accounts.set(publicKey, { sequence: 1000n, balance: 10000 });
    },
    async transaction(hash) {
      return ledgerTxs.get(hash) ?? null;
    },
    async submit(tx) {
      net.submits += 1;
      const isBump = tx instanceof sdk.FeeBumpTransaction;
      const inner = isBump ? tx.innerTransaction : tx;
      const hash = tx.hash().toString('hex');
      const verify = (t, publicKey) => t.signatures.some((s) => sdk.Keypair.fromPublicKey(publicKey).verify(t.hash(), s.signature()));
      if (!verify(inner, inner.source)) throw new StellarSubmitError('bad auth', ['tx_bad_auth'], false);
      if (isBump && !verify(tx, tx.feeSource)) throw new StellarSubmitError('bad fee auth', ['tx_bad_auth'], false);
      const source = accounts.get(inner.source);
      if (!source) throw new StellarSubmitError('no source', ['tx_no_source_account'], true);
      if (BigInt(inner.sequence) !== source.sequence + 1n) throw new StellarSubmitError('bad seq', ['tx_bad_seq'], true);
      for (const op of inner.operations) {
        const amount = Number(op.type === 'createAccount' ? op.startingBalance : op.amount);
        if (source.balance - amount < 1) throw new StellarSubmitError('underfunded', ['tx_failed', 'op_underfunded'], true);
        if (op.type === 'payment' && !accounts.has(op.destination)) throw new StellarSubmitError('no destination', ['tx_failed', 'op_no_destination'], true);
      }
      source.sequence += 1n;
      for (const op of inner.operations) {
        const amount = Number(op.type === 'createAccount' ? op.startingBalance : op.amount);
        source.balance -= amount;
        if (op.type === 'createAccount') accounts.set(op.destination, { sequence: 5000n, balance: amount });
        else accounts.get(op.destination).balance += amount;
      }
      ledger += 1;
      ledgerTxs.set(hash, { ledger, successful: true, memo: inner.memo.value?.toString() ?? null, feeSource: isBump ? tx.feeSource : inner.source, source: inner.source });
      if (net.cutNext) { net.cutNext = false; throw new StellarSubmitError('connection reset', ['timeout'], true); }
      return { hash, ledger };
    },
  };
  return net;
}

/* ── the whole flow, on the local database ──────────────────────────────── */

const seedHex = randomBytes(32).toString('hex');
const config = stellarConfigFromEnv({ STELLAR_ENABLED: 'true', STELLAR_MASTER_SEED: seedHex, STELLAR_NGN_PER_XLM: '1000' });
const opsKey = keypairAt(config.masterSeed, 0).publicKey();
const made = { users: [] };
let skip = false;

async function user(role) {
  const id = randomUUID();
  await prisma.user.create({ data: { id, privyDid: `test:stellar:${id}`, role, name: `Stellar ${role}` } });
  made.users.push(id);
  return id;
}
async function drain(service, rounds = 12) {
  for (let i = 0; i < rounds; i += 1) await service.processDue();
}
const balance = (net, publicKey) => Number(net.accounts.get(publicKey)?.balance.toFixed(7));

test.before(async () => {
  console.info = () => {};
  console.warn = () => {};
  // Your own local Stellar data (another master seed) is left alone: the flow tests step aside.
  const existing = await prisma.stellarAccount.findFirst({ where: { role: 'operations' } });
  if (existing && existing.publicKey !== opsKey) skip = 'a local operations account from another seed exists';
});

test('a deposit, a trip and a withdrawal, mirrored on Stellar: accounts opened, fare and commission with the trip ID, fees paid by operations', async (t) => {
  if (skip) return t.skip(skip);
  const net = fakeNetwork();
  const stellar = createStellarService({ config, network: net });
  const riderId = await user('RIDER');
  const driverId = await user('DRIVER');

  // ₦5,000 deposit → 5 XLM.
  await stellar.mirrorTopup({ userId: riderId, reference: `dep-${riderId}`, amountNgn: 5000 });
  await stellar.mirrorTopup({ userId: riderId, reference: `dep-${riderId}`, amountNgn: 5000 });   // the same deposit twice
  await drain(stellar);
  const rider = await prisma.stellarAccount.findUnique({ where: { userId: riderId } });
  assert.equal(balance(net, rider.publicKey), 2 + 5, 'opened with 2 XLM, then one top-up of 5 (not two)');

  // A ₦3,000 trip with ₦600 commission.
  const ride = { rideId: randomUUID(), tripId: 'WH-04821', riderId, driverUserId: driverId, fareNgn: 3000, commissionNgn: 600 };
  await stellar.settleRide(ride);
  await stellar.settleRide(ride);   // a replayed event
  await drain(stellar);
  const driver = await prisma.stellarAccount.findUnique({ where: { userId: driverId } });
  assert.equal(balance(net, rider.publicKey), 7 - 3);
  assert.equal(balance(net, driver.publicKey), 4.4);

  const transfers = await prisma.stellarTransfer.findMany({ where: { rideId: ride.rideId }, orderBy: { createdAt: 'asc' } });
  assert.deepEqual(transfers.map((x) => [x.kind, x.status]), [['FARE', 'CONFIRMED'], ['COMMISSION', 'CONFIRMED']]);
  for (const x of transfers) {
    const onChain = net.ledgerTxs.get(x.txHash);
    assert.equal(onChain.memo, 'WH-04821', 'the trip ID is the memo');
    assert.equal(onChain.feeSource, opsKey, 'operations paid the fee');
    assert.notEqual(onChain.source, opsKey, 'the rider / driver account is the one paying');
  }
  assert.deepEqual(stellar.describe(transfers[0]).explorerUrl, `https://stellar.expert/explorer/testnet/tx/${transfers[0].txHash}`);

  // The driver withdraws to their own outside address.
  const outside = sdk.Keypair.random().publicKey();
  net.accounts.set(outside, { sequence: 1n, balance: 1 });
  await assert.rejects(stellar.requestWithdrawal({ userId: driverId, destination: 'GNOPE', amountXlm: 1 }), { code: 'BAD_ADDRESS' });
  await assert.rejects(stellar.requestWithdrawal({ userId: driverId, destination: outside, amountXlm: 4 }), { code: 'TOO_MUCH' });
  await stellar.requestWithdrawal({ userId: driverId, destination: outside, amountXlm: 2 });
  await drain(stellar);
  assert.equal(balance(net, outside), 3);
  assert.equal(balance(net, driver.publicKey), 2.4);

  // No secret anywhere in the database: accounts are public keys and numbers.
  const columns = await prisma.$queryRawUnsafe(`select column_name from information_schema.columns where table_name = 'StellarAccount'`);
  assert.ok(!columns.some((c) => /secret|private|seed|mnemonic/i.test(c.column_name)));
});

test('a rider with no deposit on Stellar is topped up first, then pays; a send cut short is looked up, not repeated', async (t) => {
  if (skip) return t.skip(skip);
  const net = fakeNetwork();
  const stellar = createStellarService({ config, network: net });
  // Operations exists on this fresh network under the same key: open it again (a testnet reset).
  await prisma.stellarAccount.updateMany({ where: { publicKey: opsKey }, data: { openedAt: null } });
  const riderId = await user('RIDER');
  const driverId = await user('DRIVER');

  const ride = { rideId: randomUUID(), tripId: 'WH-00077', riderId, driverUserId: driverId, fareNgn: 8000, commissionNgn: 1000 };
  await stellar.settleRide(ride);
  net.cutNext = true;
  await drain(stellar, 20);
  const fare = await prisma.stellarTransfer.findUnique({ where: { reference: `fare:${ride.rideId}` } });
  assert.equal(fare.status, 'CONFIRMED');
  const catchUp = await prisma.stellarTransfer.findUnique({ where: { reference: `topup:catchup:${ride.rideId}` } });
  assert.equal(catchUp.status, 'CONFIRMED', 'topped up to cover the fare');
  const hashes = new Set((await prisma.stellarTransfer.findMany({ where: { OR: [{ userId: riderId }, { userId: driverId }] } })).map((x) => x.txHash));
  assert.equal([...net.ledgerTxs.keys()].filter((h) => hashes.has(h)).length, hashes.size, 'every confirmed transfer is on the ledger');
  assert.equal(net.ledgerTxs.size, net.submits, 'the send that was cut short was not sent again');
});

test.after(async () => {
  const accounts = await prisma.stellarAccount.findMany({ where: { OR: [{ userId: { in: made.users } }, { publicKey: opsKey }] } });
  const keys = accounts.map((a) => a.publicKey);
  await prisma.stellarTransfer.deleteMany({ where: { OR: [{ fromPublicKey: { in: keys } }, { toPublicKey: { in: keys } }] } });
  await prisma.stellarAccount.deleteMany({ where: { publicKey: { in: keys } } });
  await prisma.user.deleteMany({ where: { id: { in: made.users } } });
  await prisma.$disconnect();
});
