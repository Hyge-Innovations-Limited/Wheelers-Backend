// The Paystack client against Paystack's REAL test API. Nothing is stubbed.
// It refuses to run on a live key, and skips when no key is set.
//
//   PAYSTACK_SECRET_KEY=sk_test_… node --test --test-force-exit test/paystack.live.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHmac, randomUUID } = require('node:crypto');
const {
  PaymentsClient, PaymentsApiError, classifyPayoutStatus, isOtpRequired, bankNameParts,
} = require('../packages/payments/dist/index.js');

const KEY = process.env.PAYSTACK_SECRET_KEY ?? '';
const skip = !KEY.startsWith('sk_test_') && 'set PAYSTACK_SECRET_KEY to an sk_test_ key to run';
const payments = new PaymentsClient({ secretKey: KEY || 'sk_test_none', dvaBank: 'wema-bank' });
const userId = randomUUID();

test('test keys are detected, and force the test bank', { skip }, () => {
  assert.equal(payments.isTestMode, true);
});

test('an emoji-named user gets a customer and one stable account number', { skip }, async () => {
  const { firstName, lastName } = bankNameParts('Olá🌸');
  assert.deepEqual({ firstName, lastName }, { firstName: 'Ola', lastName: 'User' });

  const customer = await payments.createCustomer({ customerReference: userId, firstName, lastName, phoneNumber: '+2348012345678' });
  assert.match(customer.id, /^CUS_/);
  assert.equal(customer.email, `${userId}@users.wheelersng.com`);

  const again = await payments.createCustomer({ customerReference: userId, firstName, lastName });
  assert.equal(again.id, customer.id, 'creating twice must return the same customer');

  const account = await payments.createVirtualAccount(customer.id);
  assert.match(account.account_number, /^\d{10}$/);
  assert.ok(account.bank_name.length > 0);

  const sameAccount = await payments.createVirtualAccount(customer.id);
  assert.equal(sameAccount.account_number, account.account_number, 'a customer has exactly one account');

  const found = await payments.findVirtualAccount(customer.id);
  assert.equal(found?.account_number, account.account_number);
  const byReference = await payments.findCustomerByReference(userId);
  assert.equal(byReference?.id, customer.id);
});

test('an unknown user has no customer', { skip }, async () => {
  assert.equal(await payments.findCustomerByReference(randomUUID()), null);
});

test('the bank list is usable: codes, names, and the big banks are present', { skip }, async () => {
  const banks = await payments.listBanks();
  assert.ok(banks.length > 100, `only ${banks.length} banks`);
  for (const bank of banks.slice(0, 20)) {
    assert.equal(bank.uuid, bank.code, 'apps send "uuid" back — it must be the bank code');
    assert.ok(bank.name && bank.code);
  }
  for (const wanted of ['Zenith Bank', 'Guaranty Trust Bank', 'OPay Digital Services Limited (OPay)']) {
    assert.ok(banks.some((b) => b.name === wanted), `${wanted} missing`);
  }
});

test('name check resolves a real account and rejects a bad one with a 4xx', { skip }, async () => {
  const ok = await payments.validateBankAccount({ accountNumber: '0000000000', bankCode: '057' });
  assert.ok(ok.account_name.length > 0);
  await assert.rejects(
    payments.validateBankAccount({ accountNumber: '0001234567', bankCode: '058' }),
    (error) => error instanceof PaymentsApiError && error.status >= 400 && error.status < 500,
  );
});

test('the float is readable in naira', { skip }, async () => {
  const balance = await payments.getBalanceNgn();
  assert.ok(Number.isFinite(balance) && balance >= 0);
});

test('a transfer is keyed by our reference, and a repeat can never pay twice', { skip }, async (t) => {
  const balance = await payments.getBalanceNgn();
  if (balance < 200) return t.skip(`test float is ₦${balance}; charge a test card to top it up`);

  const reference = randomUUID();
  const first = await payments.createPayout({
    reference, amountNgn: 100, accountNumber: '0000000000', bankCode: '057', accountName: 'Wheelers Test',
  });
  assert.equal(first.reference, reference);
  assert.equal(first.amountNgn, 100);

  if (isOtpRequired(first.status)) {
    assert.equal(classifyPayoutStatus(first.status), 'failed');
    t.diagnostic('Paystack answered "otp": turn OFF "Confirm transfers before sending" in the dashboard before going live.');
  } else {
    assert.notEqual(classifyPayoutStatus(first.status), 'failed', `unexpected status ${first.status}`);
  }

  const replay = await payments.createPayout({
    reference, amountNgn: 100, accountNumber: '0000000000', bankCode: '057', accountName: 'Wheelers Test',
  });
  assert.equal(replay.id, first.id, 'the replay must be answered with the ORIGINAL transfer');

  const read = await payments.getPayout(reference);
  assert.equal(read?.id, first.id);
  assert.equal(await payments.getPayout(randomUUID()), null, 'an unknown reference means no transfer exists');
});

test('an unknown inbound reference verifies to null, not an exception', { skip }, async () => {
  assert.equal(await payments.verifyTransaction(`never-${randomUUID()}`), null);
});

test('webhook signatures: the real one passes, anything else fails', { skip }, () => {
  const body = Buffer.from(JSON.stringify({ event: 'charge.success', data: { reference: 'x' } }));
  const good = createHmac('sha512', KEY).update(body).digest('hex');
  assert.equal(payments.verifyWebhookSignature(body, good), true);
  assert.equal(payments.verifyWebhookSignature(body, good.toUpperCase()), true);
  assert.equal(payments.verifyWebhookSignature(Buffer.from('{"tampered":true}'), good), false);
  assert.equal(payments.verifyWebhookSignature(body, 'nope'), false);
  assert.equal(payments.verifyWebhookSignature(body, undefined), false);
});
