// The ₦20 deposit fee, and the rule that makes the books trustworthy: whatever
// the ledger gains from a deposit must equal the cash that actually arrived.
//
//   npm -w @wheleers/config run build && node --test test/deposit-split.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { splitDeposit } = require('../packages/config/dist/index.js');

/** Ledger gain must equal cash received, for every input. */
function assertBooksMatchCash(amount, providerFee, split) {
  const ledgerGain = split.userCreditNgn + split.platformFeeNgn - split.platformAbsorbsNgn;
  const cash = amount - Math.min(amount, providerFee);
  assert.equal(Math.round(ledgerGain * 100), Math.round(cash * 100), `ledger ${ledgerGain} vs cash ${cash}`);
}

test('platform absorbs the provider fee: the user only ever loses ₦20', () => {
  const split = splitDeposit(10_000, 100, 20, 'platform');
  assert.deepEqual(split, { userCreditNgn: 9_980, platformFeeNgn: 20, platformAbsorbsNgn: 100 });
  assertBooksMatchCash(10_000, 100, split);
});

test('user carries the provider fee: Wheelers always nets exactly ₦20', () => {
  const split = splitDeposit(10_000, 100, 20, 'user');
  assert.deepEqual(split, { userCreditNgn: 9_880, platformFeeNgn: 20, platformAbsorbsNgn: 0 });
  assertBooksMatchCash(10_000, 100, split);
});

test('a small deposit still pays the flat fee', () => {
  const split = splitDeposit(500, 5, 20, 'platform');
  assert.deepEqual(split, { userCreditNgn: 480, platformFeeNgn: 20, platformAbsorbsNgn: 5 });
  assertBooksMatchCash(500, 5, split);
});

test('a deposit smaller than the fee is kept whole and nobody goes negative', () => {
  const split = splitDeposit(15, 0.15, 20, 'platform');
  assert.equal(split.userCreditNgn, 0);
  assert.equal(split.platformFeeNgn, 15);
  assertBooksMatchCash(15, 0.15, split);

  const userPays = splitDeposit(15, 0.15, 20, 'user');
  assert.equal(userPays.userCreditNgn, 0);
  assert.ok(userPays.platformAbsorbsNgn >= 0);
  assertBooksMatchCash(15, 0.15, userPays);
});

test('kobo amounts survive without drifting', () => {
  for (const [amount, fee] of [[2_600, 26], [1_234.56, 12.35], [99.99, 1], [300_000, 300], [20, 0.2], [21, 0.21]]) {
    for (const paidBy of ['platform', 'user']) {
      const split = splitDeposit(amount, fee, 20, paidBy);
      assert.ok(split.userCreditNgn >= 0 && split.platformFeeNgn >= 0 && split.platformAbsorbsNgn >= 0);
      assertBooksMatchCash(amount, fee, split);
    }
  }
});

test('a zero fee setting credits the full deposit', () => {
  const split = splitDeposit(5_000, 50, 0, 'platform');
  assert.deepEqual(split, { userCreditNgn: 5_000, platformFeeNgn: 0, platformAbsorbsNgn: 50 });
});
