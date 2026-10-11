// Referral links and QR codes: the link opens a chat with Wheelers with the
// code already typed; the bot reads the code out of that message (and out of
// a message that is only the code), adds it to the rider's account, and says
// in plain words when it cannot. Against the local Postgres.
//
//   node scripts/run-with-env.cjs node --test --test-force-exit test/referral-link.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { prisma, referralClient } = require('@wheleers/db');
const { referralCodeIn, referralChatMessage, referralShareLink, referralRefusal, applyReferralFromChat } = require('../apps/api-gateway/dist/whatsapp/referral.js');

const made = [];
const sent = [];
const realFetch = global.fetch;
const deps = {
  metaAccessToken: 'test-token',
  metaPhoneNumberId: '1234567890',
  redisClient: { get: async () => null, set: async () => undefined, del: async () => undefined, send: async () => null },
};

// What the rider was told in message n, whichever kind of WhatsApp message carried it.
const said = (n) => JSON.stringify(sent[n]);

async function person(role = 'RIDER') {
  const user = await prisma.user.create({ data: { privyDid: `did:test:${randomUUID()}`, role, name: 'Referral Tester' } });
  made.push(user.id);
  return user;
}

test.before(() => {
  global.fetch = async (url, init) => {
    if (String(url).includes('graph.facebook.com')) {
      sent.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ messages: [{ id: 'wamid.test' }] }), { status: 200 });
    }
    return realFetch(url, init);
  };
});

test.after(async () => {
  global.fetch = realFetch;
  await prisma.referral.deleteMany({ where: { OR: [{ referrerId: { in: made } }, { referredUserId: { in: made } }] } });
  await prisma.referralCode.deleteMany({ where: { userId: { in: made } } });
  await prisma.user.deleteMany({ where: { id: { in: made } } });
  await prisma.$disconnect();
});

test('the code is read from what a referral link sends, and from a message that is only the code', () => {
  assert.equal(referralCodeIn('Hi Wheelers. My referral code is WHLAB2CD3'), 'WHLAB2CD3');
  assert.equal(referralCodeIn(referralChatMessage('WHLAB2CD3')), 'WHLAB2CD3');
  assert.equal(referralCodeIn('my referral code: whlab2cd3'), 'WHLAB2CD3');
  assert.equal(referralCodeIn('Referral code WHLAB2CD3'), 'WHLAB2CD3');
  assert.equal(referralCodeIn('  WHLAB2CD3 '), 'WHLAB2CD3');
});

test('ordinary messages are not mistaken for a code', () => {
  assert.equal(referralCodeIn('from Yaba to WHLAB2CD3 street'), null, 'a code inside another sentence is left alone');
  assert.equal(referralCodeIn('what is a referral code'), null);
  assert.equal(referralCodeIn('my referral code is ABC123'), null, 'not a Wheelers code');
  assert.equal(referralCodeIn('from Yaba to Victoria Island'), null);
  assert.equal(referralCodeIn(''), null);
});

test('the link opens a chat with the Wheelers number with the code typed, and is absent when no number is set', () => {
  const link = referralShareLink('WHLAB2CD3', '+234 814 197 9106');
  assert.ok(link.startsWith('https://wa.me/2348141979106?text='));
  assert.equal(referralCodeIn(decodeURIComponent(link.split('text=')[1])), 'WHLAB2CD3', 'what the link sends is read back as the code');
  assert.equal(referralShareLink('WHLAB2CD3', ''), null);
});

test('a rider who sends a driver\'s code has it added to their account and is told', async () => {
  const driver = await person('DRIVER');
  const rider = await person();
  const { code } = await referralClient.ensureCodeForUser(driver.id);
  sent.length = 0;

  await applyReferralFromChat(deps, rider, '2348030000009', referralChatMessage(code), code);

  const referral = await prisma.referral.findUnique({ where: { referredUserId: rider.id } });
  assert.ok(referral, 'the referral is on the rider\'s account');
  assert.equal(referral.referrerId, driver.id);
  assert.equal(sent.length, 1);
  assert.match(said(0), new RegExp(`Referral code \\*${code}\\* has been added`));
  assert.match(said(0), /tell me where you are going/);
});

test('a second code, their own code and a code that does not exist are refused in words', async () => {
  const friend = await person();
  const other = await person();
  const rider = await person();
  const friendCode = (await referralClient.ensureCodeForUser(friend.id)).code;
  const otherCode = (await referralClient.ensureCodeForUser(other.id)).code;
  const ownCode = (await referralClient.ensureCodeForUser(rider.id)).code;

  sent.length = 0;
  await applyReferralFromChat(deps, rider, '2348030000010', ownCode, ownCode);
  assert.match(said(0), /cannot use your own referral code/);
  assert.equal(await prisma.referral.count({ where: { referredUserId: rider.id } }), 0);

  await applyReferralFromChat(deps, rider, '2348030000010', 'WHLZZZZZZ', 'WHLZZZZZZ');
  assert.match(said(1), /was not found/);

  await applyReferralFromChat(deps, rider, '2348030000010', friendCode, friendCode);
  await applyReferralFromChat(deps, rider, '2348030000010', otherCode, otherCode);
  assert.match(said(3), /already on your account/);
  assert.equal((await prisma.referral.findUnique({ where: { referredUserId: rider.id } })).referrerId, friend.id, 'the first code stays');

  assert.match(referralRefusal('something unexpected'), /could not be added right now/);
});
