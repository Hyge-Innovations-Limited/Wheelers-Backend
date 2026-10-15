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
  assert.equal(referralCodeIn('referral code ABC123'), null, 'only a WHL code is read outside the full sentence a link sends');
  assert.equal(referralCodeIn('TIMI'), null, 'a short word alone is a place name, not a code');
  assert.equal(referralCodeIn('from Yaba to Victoria Island'), null);
  assert.equal(referralCodeIn(''), null);
});

test('the link opens a chat with the Wheelers number with the code typed, and is absent when no number is set', () => {
  const link = referralShareLink('WHLAB2CD3', '+234 814 197 9106');
  assert.ok(link.startsWith('https://wa.me/2348141979106?text='));
  assert.equal(referralCodeIn(decodeURIComponent(link.split('text=')[1])), 'WHLAB2CD3', 'what the link sends is read back as the code');
  assert.equal(referralShareLink('WHLAB2CD3', ''), null);
});

/** A code this person created for themselves, as the app has them do. */
const ownCode = (userId) => referralClient.setCustomCode(userId, `R${Math.random().toString(36).slice(2, 10).toUpperCase()}`);

test('a rider who sends a driver\'s code has it added to their account and is told', async () => {
  const driver = await person('DRIVER');
  const rider = await person();
  const { code } = await ownCode(driver.id);
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
  const friendCode = (await ownCode(friend.id)).code;
  const otherCode = (await ownCode(other.id)).code;
  const riderCode = (await ownCode(rider.id)).code;

  sent.length = 0;
  await applyReferralFromChat(deps, rider, '2348030000010', riderCode, riderCode);
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

test('a person creates their own code once: none exists before, it works in a link, it can never be changed, and a taken or too short one is refused in words', async () => {
  const driver = await person('DRIVER');
  const other = await person();
  const rider = await person();
  assert.equal((await referralClient.findSummary(driver.id)).code, null, 'nobody is handed a code');
  assert.equal(await prisma.referralCode.count({ where: { userId: driver.id } }), 0, 'and looking does not make one');
  const mine = `T${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

  const saved = await referralClient.setCustomCode(driver.id, ` ${mine.toLowerCase()} `);
  assert.equal(saved.code, mine, 'tidied to capitals');
  assert.equal((await referralClient.setCustomCode(driver.id, mine)).code, mine, 'asking for the same again is fine');
  await assert.rejects(referralClient.setCustomCode(driver.id, `X${mine}`), new RegExp(`Your referral code is ${mine}. A referral code can't be changed`));
  assert.equal((await referralClient.findSummary(driver.id)).code, mine, 'the first code stays');
  await assert.rejects(referralClient.setCustomCode(other.id, mine), /That code is taken/);
  await assert.rejects(referralClient.setCustomCode(other.id, 'ab'), /4 to 12 letters or numbers/);
  await assert.rejects(referralClient.setCustomCode(other.id, 'ABCDEFGHIJKLMNOP'), /4 to 12 letters or numbers/);

  // What the link sends is read as the chosen code, and adds it.
  assert.equal(referralCodeIn(referralChatMessage(mine)), mine);
  sent.length = 0;
  await applyReferralFromChat(deps, rider, '2348030000011', referralChatMessage(mine), mine);
  assert.equal((await prisma.referral.findUnique({ where: { referredUserId: rider.id } })).referrerId, driver.id);
  assert.match(said(0), /has been added/);
});

/* ── Quick Actions on WhatsApp: their own code, created and shared as in the app ── */

const { handleQuickActionsFlow, QUICK_ACTIONS_ACTIONS } = require('../apps/api-gateway/dist/whatsapp-flows/quick-actions-flow.js');
const { createQuickActionsChatHooks, referralShareMessage } = require('../apps/api-gateway/dist/whatsapp/menu.js');
const QUICK_ACTIONS_FLOW = require('../apps/api-gateway/src/whatsapp-flows/quick-actions-flow-definition.json');

/** Tap something in the Quick Actions form as this person; `saved` hears every code sent to the chat. */
function quickActions(userId, saved = []) {
  const formDeps = {
    redisClient: deps.redisClient, publisher: { publish: async () => undefined }, googleMapsApiKey: '', routePlanner: {},
    onReferralCodeSaved: async (id, code) => { saved.push({ id, code }); },
  };
  // As Meta sends it: a data_exchange from the screen the button is on.
  // REFERRAL's button carries its action, as the form's JSON sends it.
  return (action, data = {}) => handleQuickActionsFlow({ version: '3.0', action: 'data_exchange', flow_token: 'x', screen: action === 'menu_choice' ? 'MENU' : 'REFERRAL', data: action === 'menu_choice' ? data : { ...data, action } }, userId, formDeps);
}
const row = (menu, id) => menu.data.choices.find((choice) => choice.id === id);
const uniqueCode = () => `Q${Math.random().toString(36).slice(2, 9).toUpperCase()}`;

test('QUICK ACTIONS · a rider with no code is offered to create one, and creating it sends it to the chat', async () => {
  const rider = await person();
  const saved = [];
  const tap = quickActions(rider.id, saved);

  const menu = await tap('menu_choice', { choice: 'nothing' });
  assert.equal(row(menu, 'my_code')?.title, 'Create your referral code');

  const screen = await tap('menu_choice', { choice: 'my_code' });
  assert.equal(screen.screen, 'REFERRAL');
  assert.equal(screen.data.heading, 'Create your referral code');
  assert.equal(screen.data.code, '');
  assert.equal(screen.data.has_stats, false);
  assert.match(screen.data.intro_line, /can't be changed later/);
  assert.equal(screen.data.action, 'save_my_code');
  assert.equal(screen.data.button_label, 'Save and share');

  const short = await tap('save_my_code', { code: 'ab' });
  assert.equal(short.screen, 'REFERRAL');
  assert.match(short.data.error, /4 to 12/);
  assert.equal(saved.length, 0, 'nothing is sent for a refused code');

  const code = uniqueCode();
  const done = await tap('save_my_code', { code: ` ${code.toLowerCase()} ` });
  assert.equal(done.screen, 'NOTE');
  assert.equal(done.data.headline, `Your code is ${code}`);
  assert.deepEqual(saved, [{ id: rider.id, code }]);
  assert.equal(await referralClient.findOwnCode(rider.id), code);

  const after = await tap('menu_choice', { choice: 'nothing' });
  assert.equal(row(after, 'my_code')?.title, 'Your referral code');
  assert.match(row(after, 'my_code').description, new RegExp(code));
});

test('QUICK ACTIONS · a taken code is refused on the same screen; once they have a code it is only ever shared, never changed', async () => {
  const first = await person();
  const second = await person();
  const taken = (await referralClient.setCustomCode(first.id, uniqueCode())).code;
  const saved = [];
  const tap = quickActions(second.id, saved);

  const refused = await tap('save_my_code', { code: taken });
  assert.equal(refused.screen, 'REFERRAL');
  assert.match(refused.data.error, /taken/);
  assert.equal(refused.data.code, taken, 'what they typed stays in the box');

  const mine = uniqueCode();
  await tap('save_my_code', { code: mine });

  // Their row now sends the code straight to the chat: no box to type a new one in.
  const shared = await tap('menu_choice', { choice: 'my_code' });
  assert.equal(shared.screen, 'NOTE');
  assert.equal(shared.data.headline, `Your code is ${mine}`);
  assert.equal(saved.length, 2);

  // An old form still open on a phone cannot change it either.
  const late = await tap('save_my_code', { code: uniqueCode() });
  assert.equal(late.data.headline, `Your code is ${mine}`);
  assert.equal(await referralClient.findOwnCode(second.id), mine);
});

test('QUICK ACTIONS · sharing the code says how many people joined with it', async () => {
  const owner = await person();
  const friend = await person();
  const code = (await referralClient.setCustomCode(owner.id, uniqueCode())).code;
  await referralClient.applyCode({ referredUserId: friend.id, code });

  const shared = await quickActions(owner.id)('menu_choice', { choice: 'my_code' });
  assert.match(shared.data.note, /1 person has joined with it/);
});

test('QUICK ACTIONS · the chat gets a line to read and a message to forward, whose link adds the code', async () => {
  const rider = await prisma.user.create({ data: { privyDid: `did:test:${randomUUID()}`, role: 'RIDER', name: 'Referral Tester', phone: `23480${Math.floor(10000000 + Math.random() * 89999999)}` } });
  made.push(rider.id);
  process.env.WHATSAPP_BOT_NUMBER = '+234 814 197 9106';
  const hooks = createQuickActionsChatHooks({ ...deps, redisClient: { ...deps.redisClient, lPush: async () => 0, rPush: async () => 0, lTrim: async () => undefined, expire: async () => undefined } });
  sent.length = 0;

  await hooks.onReferralCodeSaved(rider.id, 'TIMI');

  assert.equal(sent.length, 2);
  assert.match(said(0), /Your referral code is \*TIMI\*/);
  assert.match(said(0), /Forward the next message/);
  assert.match(said(1), /Use my code \*TIMI\*/);
  const link = said(1).match(/https:\/\/wa\.me\/[^"\s\\]+/)[0];
  assert.equal(referralCodeIn(decodeURIComponent(link.split('text=')[1])), 'TIMI', 'the friend\'s tap sends the code to the bot');

  assert.match(referralShareMessage('TIMI', null), /say: My referral code is TIMI/);
  assert.equal(referralCodeIn('My referral code is TIMI'), 'TIMI', 'the words without a link are read too');
});

test('QUICK ACTIONS · one REFERRAL screen does both: its button sends the action the server chose, and a friend\'s code still works', async () => {
  assert.ok(QUICK_ACTIONS_FLOW.routing_model.MENU.length <= 10, 'Meta allows ten routes from a screen');
  const screen = QUICK_ACTIONS_FLOW.screens.find((s) => s.id === 'REFERRAL');
  assert.match(JSON.stringify(screen.layout), /"action":"\$\{data.action\}"/);
  assert.equal(QUICK_ACTIONS_ACTIONS.REFERRAL, undefined, 'the screen does not force one action');

  const owner = await person();
  const rider = await person();
  const code = (await referralClient.setCustomCode(owner.id, uniqueCode())).code;
  const tap = quickActions(rider.id);
  const friendScreen = await tap('menu_choice', { choice: 'referral' });
  assert.equal(friendScreen.data.action, 'apply_referral');
  assert.equal(friendScreen.data.button_label, 'Add code');
  const added = await tap('apply_referral', { code });
  assert.equal(added.data.headline, 'Referral code added');
  assert.equal((await prisma.referral.findUnique({ where: { referredUserId: rider.id } })).referrerId, owner.id);
});
