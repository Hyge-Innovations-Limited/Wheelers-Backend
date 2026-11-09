// Stellar Testnet (grant deliverable 3), its own ledger: keys derived, never
// stored; testnet only; accounts opened by Friendbot; a trip's fare and
// commission in XLM at the live rate (kept on each transfer), skipped when the
// rider's account is short; a driver's withdrawal; each sent once and
// confirmed. Against a fake Stellar network and price feed (no internet
// needed) and the real local Postgres.
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
const { createRateProvider } = require('../apps/api-gateway/dist/stellar/rates.js');

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
  const on = stellarConfigFromEnv({ STELLAR_ENABLED: 'true', STELLAR_MASTER_SEED: seed });
  assert.equal(on.networkPassphrase, sdk.Networks.TESTNET);
  assert.equal(on.fallbackNgnPerXlm, null, 'no fixed rate unless one is set');
  assert.equal(stellarConfigFromEnv({ STELLAR_ENABLED: 'true', STELLAR_MASTER_SEED: seed, STELLAR_NETWORK: 'TESTNET' }).networkPassphrase, sdk.Networks.TESTNET, 'any case');
  assert.throws(() => stellarConfigFromEnv({ STELLAR_ENABLED: 'true', STELLAR_MASTER_SEED: seed, STELLAR_NETWORK: 'public' }), /only testnet/);
  assert.throws(() => stellarConfigFromEnv({ STELLAR_ENABLED: 'true', STELLAR_MASTER_SEED: seed, STELLAR_HORIZON_URL: 'https://horizon.stellar.org' }), /not a testnet Horizon/);
  assert.throws(() => stellarConfigFromEnv({ STELLAR_ENABLED: 'true', STELLAR_MASTER_SEED: 'short' }), /STELLAR_MASTER_SEED/);
});

test('the live rate: Stellar market × dollar-to-naira first, then CoinGecko, then the last good rate, then .env; nonsense is refused', async () => {
  const replies = {};
  const fetcher = async (url) => {
    const key = Object.keys(replies).find((k) => url.includes(k));
    const reply = key ? replies[key] : null;
    if (!reply) return { ok: false, json: async () => ({}) };
    return { ok: true, json: async () => reply };
  };
  let clock = Date.parse('2026-09-30T10:00:00Z');
  const store = new Map();
  const redis = { get: async (k) => store.get(k) ?? null, set: async (k, v) => { store.set(k, v); } };
  const rates = createRateProvider({ redis, fetcher, now: () => clock });

  replies['horizon.stellar.org/order_book'] = { bids: [{ price: '0.22' }], asks: [{ price: '0.24' }] };
  replies['open.er-api.com'] = { rates: { NGN: 1300 } };
  const first = await rates.current();
  assert.deepEqual([first.ngnPerXlm, first.source], [299, 'stellar-dex × er-api'], '0.23 USD × ₦1,300');

  // The market is down: CoinGecko, once the cached rate is 30 minutes old.
  delete replies['horizon.stellar.org/order_book'];
  replies['api.coingecko.com'] = { stellar: { ngn: 305.5 } };
  assert.equal((await rates.current()).ngnPerXlm, 299, 'fresh enough: no new call');
  clock += 31 * 60 * 1000;
  assert.deepEqual([(await rates.current()).ngnPerXlm, (await rates.current()).source], [305.5, 'coingecko']);

  // Everything down: the last good rate, for a day.
  replies['api.coingecko.com'] = { stellar: { ngn: 0 } };   // nonsense is refused
  clock += 60 * 60 * 1000;
  assert.equal((await rates.current()).ngnPerXlm, 305.5);
  clock += 25 * 60 * 60 * 1000;
  assert.equal(await rates.current(), null, 'older than a day, and no .env rate: none');
  const withFallback = createRateProvider({ fetcher: async () => ({ ok: false, json: async () => ({}) }), fallbackNgnPerXlm: 250 });
  assert.deepEqual([(await withFallback.current()).ngnPerXlm, (await withFallback.current()).source], [250, 'STELLAR_NGN_PER_XLM']);
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
    friendbotDown: false,
    async fund(publicKey) {
      if (net.friendbotDown) throw new Error('Friendbot refused (503)');
      if (accounts.has(publicKey)) throw new Error('already funded');
      accounts.set(publicKey, { sequence: 1000n, balance: 10000 });
      const hash = randomBytes(32).toString('hex');
      ledgerTxs.set(hash, { ledger: ++ledger, successful: true, memo: null, feeSource: 'FRIENDBOT', source: 'FRIENDBOT' });
      return { hash };
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
        if (op.type === 'accountMerge') continue;
        const amount = Number(op.type === 'createAccount' ? op.startingBalance : op.amount);
        if (source.balance - amount < 1) throw new StellarSubmitError('underfunded', ['tx_failed', 'op_underfunded'], true);
        if (op.type === 'payment' && !accounts.has(op.destination)) throw new StellarSubmitError('no destination', ['tx_failed', 'op_no_destination'], true);
      }
      source.sequence += 1n;
      for (const op of inner.operations) {
        if (op.type === 'accountMerge') { accounts.get(op.destination).balance += source.balance; accounts.delete(inner.source); continue; }
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
const config = stellarConfigFromEnv({ STELLAR_ENABLED: 'true', STELLAR_MASTER_SEED: seedHex });
/** A fixed live rate for the flow tests: ₦300 per XLM. */
const rates = { current: async () => ({ ngnPerXlm: 300, source: 'test', at: new Date().toISOString() }) };
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

test('its own ledger: accounts opened by Friendbot, the fare and commission in XLM at the live rate with the trip ID, fees paid by operations, then a withdrawal', async (t) => {
  if (skip) return t.skip(skip);
  const net = fakeNetwork();
  const stellar = createStellarService({ config, network: net, rates });
  const riderId = await user('RIDER');
  const driverId = await user('DRIVER');

  // A ₦3,000 trip with ₦525 commission, at ₦300 per XLM: 10 XLM and 1.75 XLM.
  const ride = { rideId: randomUUID(), tripId: 'WH-04821', riderId, driverUserId: driverId, fareNgn: 3000, commissionNgn: 525 };
  await stellar.settleRide(ride);
  await stellar.settleRide(ride);   // a replayed event
  await drain(stellar);
  const rider = await prisma.stellarAccount.findUnique({ where: { userId: riderId } });
  const driver = await prisma.stellarAccount.findUnique({ where: { userId: driverId } });
  const opened = await prisma.stellarTransfer.findMany({ where: { kind: 'ACCOUNT_OPEN', toPublicKey: { in: [rider.publicKey, driver.publicKey] } } });
  assert.deepEqual(opened.map((o) => [o.fromPublicKey, o.status, Number(o.amountXlm), Boolean(o.txHash)]), [[opsKey, 'CONFIRMED', 100, true], [opsKey, 'CONFIRMED', 100, true]], 'operations opened both with 100 XLM, with its transaction');
  assert.equal(balance(net, rider.publicKey), 100 - 10);
  assert.equal(balance(net, driver.publicKey), 100 + 10 - 1.75);

  const transfers = await prisma.stellarTransfer.findMany({ where: { rideId: ride.rideId }, orderBy: { createdAt: 'asc' } });
  assert.deepEqual(transfers.map((x) => [x.kind, x.status, Number(x.amountXlm), Number(x.amountNgn), Number(x.rateNgnPerXlm)]),
    [['FARE', 'CONFIRMED', 10, 3000, 300], ['COMMISSION', 'CONFIRMED', 1.75, 525, 300]], 'each keeps the rate it used');
  for (const x of transfers) {
    const onChain = net.ledgerTxs.get(x.txHash);
    assert.equal(onChain.memo, 'WH-04821', 'the trip ID is the memo');
    assert.equal(onChain.feeSource, opsKey, 'operations paid the fee');
    assert.notEqual(onChain.source, opsKey, 'the rider / driver account is the one paying');
  }
  assert.equal(stellar.describe(transfers[0]).explorerUrl, `https://stellar.expert/explorer/testnet/tx/${transfers[0].txHash}`);
  assert.equal(stellar.describe(transfers[0]).rateNgnPerXlm, 300);

  // The driver withdraws to their own outside address.
  const outside = sdk.Keypair.random().publicKey();
  net.accounts.set(outside, { sequence: 1n, balance: 1 });
  await assert.rejects(stellar.requestWithdrawal({ userId: driverId, destination: 'GNOPE', amountXlm: 1 }), { code: 'BAD_ADDRESS' });
  await assert.rejects(stellar.requestWithdrawal({ userId: driverId, destination: outside, amountXlm: 99999 }), { code: 'TOO_MUCH' });
  const out = await stellar.requestWithdrawal({ userId: driverId, destination: outside, amountXlm: 20 });
  assert.deepEqual([Number(out.amountNgn), Number(out.rateNgnPerXlm)], [6000, 300], 'its naira equivalent, at the live rate');
  await drain(stellar);
  assert.equal(balance(net, outside), 21);

  // No secret anywhere in the database: accounts are public keys and numbers.
  const columns = await prisma.$queryRawUnsafe(`select column_name from information_schema.columns where table_name = 'StellarAccount'`);
  assert.ok(!columns.some((c) => /secret|private|seed|mnemonic/i.test(c.column_name)));
});

test('a rider short of test XLM is skipped (and so is the commission), never topped up; Friendbot down does not stop operations opening an account', async (t) => {
  if (skip) return t.skip(skip);
  const net = fakeNetwork();
  const stellar = createStellarService({ config, network: net, rates });
  await prisma.stellarAccount.updateMany({ where: { publicKey: opsKey }, data: { openedAt: null } });   // a fresh network
  const riderId = await user('RIDER');
  const driverId = await user('DRIVER');

  // The rider's address already exists with only 5 test XLM (they spent the rest).
  const riderRow = await stellar.ensureUserAccount(riderId);
  net.accounts.set(riderRow.publicKey, { sequence: 7n, balance: 5 });
  await stellar.ensureOperations();
  net.friendbotDown = true;          // the driver's account has to be opened by operations
  const ride = { rideId: randomUUID(), tripId: 'WH-00077', riderId, driverUserId: driverId, fareNgn: 3000, commissionNgn: 525 };
  await stellar.settleRide(ride);
  net.cutNext = true;                // and the first send is cut short
  await drain(stellar, 20);

  const driver = await prisma.stellarAccount.findUnique({ where: { userId: driverId } });
  assert.equal(balance(net, driver.publicKey), 100, 'opened by operations with 100 test XLM');
  const fare = await prisma.stellarTransfer.findUnique({ where: { reference: `fare:${ride.rideId}` } });
  assert.equal(fare.status, 'SKIPPED');
  assert.match(fare.lastError, /had 5 test XLM, not enough for 10 XLM/);
  assert.equal((await prisma.stellarTransfer.findUnique({ where: { reference: `commission:${ride.rideId}` } })).status, 'SKIPPED');
  assert.equal(await prisma.stellarTransfer.count({ where: { kind: 'TOPUP', userId: riderId } }), 0, 'no top-up: its own ledger');
  assert.equal(balance(net, riderRow.publicKey), 5, 'nothing moved');
  assert.equal(net.ledgerTxs.size, net.submits + [...net.ledgerTxs.values()].filter((x) => x.source === 'FRIENDBOT').length, 'the send that was cut short was not sent again');
});

test('everyone gets an account by default, no trip needed: a few at a time, drivers first; operations never spends itself down opening them', async (t) => {
  if (skip) return t.skip(skip);
  const net = fakeNetwork();
  const stellar = createStellarService({ config, network: net, rates });
  await prisma.stellarAccount.updateMany({ where: { publicKey: opsKey }, data: { openedAt: null } });   // a fresh network
  await stellar.ensureOperations();
  const riders = [await user('RIDER'), await user('RIDER')];
  const driverId = await user('DRIVER');
  const among = [...riders, driverId];

  assert.equal(await stellar.openForEveryone({ among, inFlight: 2 + await prisma.stellarTransfer.count({ where: { kind: 'ACCOUNT_OPEN', status: { in: ['PENDING', 'SUBMITTED'] } } }) }), 2, 'two at a time');
  assert.ok(await prisma.stellarAccount.findUnique({ where: { userId: driverId } }), 'the driver first');
  await drain(stellar);
  assert.equal(await stellar.openForEveryone({ among }), 1, 'then the rest');
  await drain(stellar);
  assert.equal(await stellar.openForEveryone({ among }), 0, 'nobody left');
  for (const userId of among) {
    const row = await prisma.stellarAccount.findUnique({ where: { userId } });
    assert.ok(row.openedAt, 'open on the network');
    assert.equal(balance(net, row.publicKey), 100, 'with 100 test XLM');
  }

  // Operations running low is topped up from Friendbot through a throwaway account, merged in.
  net.accounts.get(opsKey).balance = 600;
  const topped = await user('RIDER');
  await stellar.openForEveryone({ among: [topped] });
  await drain(stellar, 3);
  assert.ok((await prisma.stellarAccount.findUnique({ where: { userId: topped } })).openedAt);
  const refill = await prisma.stellarTransfer.findFirst({ where: { kind: 'OPS_REFILL', toPublicKey: opsKey }, orderBy: { createdAt: 'desc' } });
  assert.deepEqual([refill.status, Number(refill.amountXlm), Boolean(refill.txHash)], ['CONFIRMED', 10000, true]);
  assert.ok(Math.abs(balance(net, opsKey) - (600 + 10000 - 100)) < 0.01, 'operations +10,000, −100 for the account');
  assert.equal(net.accounts.has(refill.fromPublicKey), false, 'the throwaway account is gone');
  assert.equal(await prisma.stellarAccount.count({ where: { publicKey: refill.fromPublicKey } }), 0, 'and never stored');

  // Friendbot down and operations nearly empty: the opening waits rather than draining operations.
  net.friendbotDown = true;
  net.accounts.get(opsKey).balance = 50;
  const late = await user('RIDER');
  await stellar.openForEveryone({ among: [late] });
  await drain(stellar, 3);
  const lateRow = await prisma.stellarAccount.findUnique({ where: { userId: late } });
  const opening = await prisma.stellarTransfer.findUnique({ where: { reference: `open:${lateRow.publicKey}` } });
  assert.deepEqual([opening.status, lateRow.openedAt, balance(net, opsKey)], ['PENDING', null, 50]);
  assert.match(opening.lastError, /operations is low on test XLM/);
  net.friendbotDown = false;
  await drain(stellar, 2);
  assert.ok((await prisma.stellarAccount.findUnique({ where: { userId: late } })).openedAt, 'opened once Friendbot is back');

  // The reset: an account opened under the earlier design (10,000) goes back to 100; the rest to operations.
  const old = await prisma.stellarAccount.findUnique({ where: { userId: riders[0] } });
  net.accounts.get(old.publicKey).balance = 10000;
  const opsBefore = balance(net, opsKey);
  const plan = await stellar.resetBalances({ dryRun: true });
  assert.deepEqual(plan.filter((p) => p.publicKey === old.publicKey).map((p) => p.returnXlm), [9900]);
  assert.equal(await prisma.stellarTransfer.count({ where: { kind: 'RESET', fromPublicKey: old.publicKey } }), 0, 'a dry run queues nothing');
  await stellar.resetBalances();
  await stellar.resetBalances();   // twice the same day: once
  await drain(stellar, 3);
  const resets = await prisma.stellarTransfer.findMany({ where: { kind: 'RESET', fromPublicKey: old.publicKey } });
  assert.deepEqual(resets.map((r) => [r.status, Number(r.amountXlm), r.toPublicKey]), [['CONFIRMED', 9900, opsKey]]);
  assert.equal(balance(net, old.publicKey), 100);
  assert.ok(Math.abs(balance(net, opsKey) - (opsBefore + 9900)) < 0.01, 'back to operations (which paid the fee)');
});

test('with no price at all, the fare is skipped and says why', async (t) => {
  if (skip) return t.skip(skip);
  const net = fakeNetwork();
  const stellar = createStellarService({ config, network: net, rates: { current: async () => null } });
  const riderId = await user('RIDER');
  const driverId = await user('DRIVER');
  const ride = { rideId: randomUUID(), tripId: 'WH-00078', riderId, driverUserId: driverId, fareNgn: 3000, commissionNgn: 525 };
  await stellar.settleRide(ride);
  const fare = await prisma.stellarTransfer.findUnique({ where: { reference: `fare:${ride.rideId}` } });
  assert.equal(fare.status, 'SKIPPED');
  assert.match(fare.lastError, /no XLM price/);
});

test.after(async () => {
  const accounts = await prisma.stellarAccount.findMany({ where: { OR: [{ userId: { in: made.users } }, { publicKey: opsKey }] } });
  const keys = accounts.map((a) => a.publicKey);
  await prisma.stellarTransfer.deleteMany({ where: { OR: [{ fromPublicKey: { in: keys } }, { toPublicKey: { in: keys } }] } });
  await prisma.stellarAccount.deleteMany({ where: { publicKey: { in: keys } } });
  await prisma.user.deleteMany({ where: { id: { in: made.users } } });
  await prisma.$disconnect();
});
