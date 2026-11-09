// The model reads a rider's intent (see the live check in the commit message);
// these are the parts around it that must hold with no network at all.
//
//   npm -w @wheleers/api-gateway run build && node --test test/wallet-intent.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyWalletIntent, mightConcernMoney, walletIntentModel } = require('../apps/api-gateway/dist/LLM/wallet-intent.js');
const { rateLimitWaitMs } = require('../apps/api-gateway/dist/LLM/groq.client.js');

const groqSaying = (answer) => ({ configured: true, completeJson: async () => answer });

test('the guard lets anything money-shaped through and spares the model the rest', () => {
  for (const yes of ['I wanna topup', 'depsoit', 'abeg I wan collect my money', 'where do I send money to?', 'withdrw', 'how I fit fund am', 'owo mi da']) {
    assert.equal(mightConcernMoney(yes), true, yes);
  }
  for (const no of ['2', 'ok', 'Allen Avenue Ikeja', 'good morning', 'yes', '15 Aiyetoro Street Akoka']) {
    assert.equal(mightConcernMoney(no), false, no);
  }
});

test('the model\'s answer is used as-is, and anything unexpected is "none"', async () => {
  assert.equal(await classifyWalletIntent(groqSaying({ intent: 'deposit' }), 'x'), 'deposit');
  assert.equal(await classifyWalletIntent(groqSaying({ intent: 'withdraw' }), 'x'), 'withdraw');
  for (const odd of [{ intent: 'none' }, { intent: 'transfer' }, {}, null, { intent: 42 }]) {
    assert.equal(await classifyWalletIntent(groqSaying(odd), 'x'), 'none');
  }
});

test('the recent conversation reaches the model, so "ok how?" can be understood', async () => {
  let seen;
  const groq = { configured: true, completeJson: async (messages) => { seen = messages; return { intent: 'deposit' }; } };
  await classifyWalletIntent(groq, 'ok how?', [
    { role: 'user', content: 'pay', timestamp: '' },
    { role: 'assistant', content: 'Top up before taking this ride — you need ₦2,500 more.', timestamp: '' },
  ]);
  assert.equal(seen[0].role, 'system');
  assert.match(seen.at(-2).content, /Top up before/);
  assert.deepEqual(seen.at(-1), { role: 'user', content: 'ok how?' });
});

test('with the model down, plain wordings still work and complaints still do not', async () => {
  const warn = console.warn;
  console.warn = () => {};
  const down = { configured: true, completeJson: async () => { throw new Error('Rate limit reached'); } };
  const off = { configured: false };
  try {
    for (const groq of [down, off]) {
      assert.equal(await classifyWalletIntent(groq, 'I want to deposit'), 'deposit');
      assert.equal(await classifyWalletIntent(groq, 'please top up'), 'deposit');
      assert.equal(await classifyWalletIntent(groq, 'cash out'), 'withdraw');
      assert.equal(await classifyWalletIntent(groq, 'I deposited 5k and it has not shown'), 'none');
      assert.equal(await classifyWalletIntent(groq, 'withdrawal status'), 'none');
      assert.equal(await classifyWalletIntent(groq, 'Bank Anthony Way'), 'none');
    }
  } finally {
    console.warn = warn;
  }
});

test('intent runs on the small model unless told otherwise', () => {
  const saved = process.env.GROQ_INTENT_MODEL;
  delete process.env.GROQ_INTENT_MODEL;
  assert.equal(walletIntentModel('openai/gpt-oss-120b'), 'openai/gpt-oss-20b');
  process.env.GROQ_INTENT_MODEL = '';
  assert.equal(walletIntentModel('openai/gpt-oss-120b'), 'openai/gpt-oss-120b');
  process.env.GROQ_INTENT_MODEL = 'some/other-model';
  assert.equal(walletIntentModel('openai/gpt-oss-120b'), 'some/other-model');
  if (saved === undefined) delete process.env.GROQ_INTENT_MODEL; else process.env.GROQ_INTENT_MODEL = saved;
});

test('Groq\'s "try again in…" is read in both units, and other errors are left alone', () => {
  assert.equal(rateLimitWaitMs(new Error('Rate limit reached … Please try again in 269.999999ms. Need more tokens?')), 270);
  assert.equal(rateLimitWaitMs(new Error('Rate limit reached … Please try again in 3.225s.')), 3225);
  assert.equal(rateLimitWaitMs(new Error('Failed to generate JSON')), null);
  assert.equal(rateLimitWaitMs(new Error('Rate limit reached')), null);
});
