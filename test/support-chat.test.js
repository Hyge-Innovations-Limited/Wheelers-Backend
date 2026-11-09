// Chat with support: a rider writes in, the admin's inbox shows it with the
// trip they are on, the admin replies, the rider is told live and by push and
// sees the reply; resolving closes it and the next message starts a new one.
// Against the local Postgres.
//
//   node scripts/run-with-env.cjs node --test --test-force-exit test/support-chat.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { prisma } = require('@wheleers/db');
const local = require('../apps/api-gateway/dist/auth/local.js');
const { handleSupportChatRoute, readSupportContent, SUPPORT_MESSAGE_MAX, SUPPORT_MESSAGES_PER_MINUTE } = require('../apps/api-gateway/dist/http/support-chat.route.js');

const SECRET = 'test-secret-for-the-support-chat-screens';
const pushed = [];
const live = [];
const made = { users: [], admins: [], rides: [], drivers: [] };
let server; let base;

async function rider(name = 'Timi Rider') {
  const user = await prisma.user.create({ data: { privyDid: `did:test:${randomUUID()}`, role: 'RIDER', name, phone: '+2348030000001' } });
  made.users.push(user.id);
  return { id: user.id, token: local.createLocalAccessToken(user.id, SECRET, 3600) };
}

async function admin(name = 'Ada') {
  const row = await prisma.adminUser.create({ data: { username: `support-${randomUUID().slice(0, 8)}`, passwordHash: 'x', name, role: 'STAFF' } });
  made.admins.push(row.id);
  return local.createLocalAccessToken(row.id, SECRET, 3600);
}

async function liveRide(riderId) {
  const driverUser = await prisma.user.create({ data: { privyDid: `did:test:${randomUUID()}`, role: 'DRIVER', name: 'Tunde Ade', phone: '+2348030000002' } });
  made.users.push(driverUser.id);
  const driver = await prisma.driver.create({ data: { userId: driverUser.id, kycStatus: 'APPROVED', vehicleMake: 'Toyota', vehicleModel: 'Corolla', vehiclePlate: 'LAG-482-XY' } });
  made.drivers.push(driver.id);
  const ride = await prisma.ride.create({
    data: {
      riderId, driverId: driver.id, status: 'IN_PROGRESS',
      pickupLat: 6.51, pickupLng: 3.37, pickupAddress: '12 Herbert Macaulay Way, Yaba',
      destLat: 6.43, destLng: 3.42, destAddress: 'Adeola Odeku Street, Victoria Island',
      agreedFareNgn: 6000, startedAt: new Date(),
    },
  });
  made.rides.push(ride.id);
  return { ride, driverUser };
}

const call = async (token, method, path, body) => {
  const res = await fetch(base + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, body: await res.json() };
};

test.before(async () => {
  const deps = {
    jwtSecret: SECRET,
    adminApiKey: 'unused-key',
    sendToUser: async (userId, type, payload) => { live.push({ userId, type, payload }); },
    publisher: { publishNotificationEvent: async (event) => { pushed.push(event); } },
  };
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    void (async () => {
      if (await handleSupportChatRoute(req, res, deps, url)) return;
      res.statusCode = 404; res.end('{}');
    })();
  });
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await prisma.supportConversation.deleteMany({ where: { userId: { in: made.users } } });
  await prisma.ride.deleteMany({ where: { id: { in: made.rides } } });
  await prisma.driver.deleteMany({ where: { id: { in: made.drivers } } });
  await prisma.adminUser.deleteMany({ where: { id: { in: made.admins } } });
  await prisma.user.deleteMany({ where: { id: { in: made.users } } });
  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
});

test('what a person types is tidied, and an empty or too long message is refused in words', () => {
  assert.deepEqual(readSupportContent('  Driver is not moving  '), { content: 'Driver is not moving' });
  assert.equal(readSupportContent('   ').code, 'EMPTY');
  assert.equal(readSupportContent(undefined).code, 'EMPTY');
  assert.equal(readSupportContent('x'.repeat(SUPPORT_MESSAGE_MAX + 1)).code, 'TOO_LONG');
  assert.ok('content' in readSupportContent('x'.repeat(SUPPORT_MESSAGE_MAX)));
});

test('signed out, nothing opens; signed in with no chat yet, an empty one', async () => {
  assert.equal((await call(null, 'GET', '/support/chat')).status, 401);
  assert.equal((await call(null, 'POST', '/support/chat/messages', { content: 'hi' })).status, 401);
  assert.equal((await call(null, 'GET', '/admin/support/conversations')).status, 401);
  const r = await rider();
  const empty = await call(r.token, 'GET', '/support/chat');
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body, { conversation: null, messages: [] });
  assert.equal((await call(r.token, 'GET', '/admin/support/conversations')).status, 401, 'a rider\'s token is not an admin\'s');
});

test('a rider on a trip writes in: the inbox shows it, marked as a live trip, with the trip and both phone numbers', async () => {
  const r = await rider('Timi Olowu');
  const { ride } = await liveRide(r.id);
  const boss = await admin();

  const sent = await call(r.token, 'POST', '/support/chat/messages', { content: 'Driver is not moving', topic: 'Report a driver' });
  assert.equal(sent.status, 201);
  assert.equal(sent.body.message.from, 'you');
  assert.equal(sent.body.conversation.status, 'open');
  assert.equal(sent.body.conversation.rideId, ride.id, 'tied to the trip they are on without being asked');
  assert.equal(sent.body.conversation.agentName, null);

  const inbox = await call(boss, 'GET', '/admin/support/conversations');
  assert.equal(inbox.status, 200);
  const row = inbox.body.items.find((item) => item.id === sent.body.conversation.id);
  assert.ok(row, 'in the open list');
  assert.equal(row.person.name, 'Timi Olowu');
  assert.equal(row.onLiveTrip, true);
  assert.equal(row.unread, 1);
  assert.equal(row.topic, 'Report a driver');
  assert.equal(row.lastMessagePreview, 'Driver is not moving');
  assert.ok(inbox.body.counts.open >= 1 && inbox.body.counts.waiting >= 1);
  const badge = await call(boss, 'GET', '/admin/support/conversations?countsOnly=1');
  assert.deepEqual(Object.keys(badge.body), ['counts'], 'the sidebar asks for the numbers alone');
  assert.ok(badge.body.counts.waiting >= 1);

  const one = await call(boss, 'GET', `/admin/support/conversations/${row.id}`);
  assert.equal(one.status, 200);
  assert.equal(one.body.messages.length, 1);
  assert.equal(one.body.messages[0].from, 'person');
  assert.equal(one.body.ride.live, true);
  assert.equal(one.body.ride.fareNgn, 6000);
  assert.equal(one.body.ride.driver.name, 'Tunde Ade');
  assert.equal(one.body.ride.driver.plate, 'LAG-482-XY');
  assert.equal(one.body.ride.driver.car, 'Toyota Corolla');
  assert.equal(one.body.ride.rider.phone, '+2348030000001');

  const after = await call(boss, 'GET', '/admin/support/conversations');
  assert.equal(after.body.items.find((item) => item.id === row.id).unread, 0, 'opening it marks it read');
});

test('the admin replies: the rider is told live and by push, sees the reply and who sent it, and it is theirs now', async () => {
  const r = await rider();
  const boss = await admin('Ada');
  const sent = await call(r.token, 'POST', '/support/chat/messages', { content: 'My wallet has not been credited' });
  const id = sent.body.conversation.id;
  live.length = 0; pushed.length = 0;

  assert.equal((await call(boss, 'POST', `/admin/support/conversations/${id}/messages`, { content: '   ' })).status, 400);
  const reply = await call(boss, 'POST', `/admin/support/conversations/${id}/messages`, { content: 'I am checking this now.' });
  assert.equal(reply.status, 201);
  assert.equal(reply.body.message.senderName, 'Ada');

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(live.length, 1);
  assert.equal(live[0].userId, r.id);
  assert.equal(live[0].type, 'support:message');
  assert.equal(live[0].payload.message.content, 'I am checking this now.');
  assert.equal(live[0].payload.message.from, 'support');
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0].eventType, 'PUSH_SEND');
  assert.equal(pushed[0].userId, r.id);
  assert.equal(pushed[0].data.type, 'support:message');

  const chat = await call(r.token, 'GET', '/support/chat');
  assert.equal(chat.body.messages.length, 2);
  assert.deepEqual(chat.body.messages.map((m) => m.from), ['you', 'support']);
  assert.equal(chat.body.messages[1].senderName, 'Ada');
  assert.equal(chat.body.conversation.agentName, 'Ada');
  assert.equal(chat.body.conversation.rideId, null, 'no trip, none claimed');

  const row = (await call(boss, 'GET', '/admin/support/conversations')).body.items.find((item) => item.id === id);
  assert.equal(row.assignedTo, 'Ada');
  assert.equal(row.onLiveTrip, false);
});

test('a ride that is not theirs cannot be attached; their own can', async () => {
  const mine = await rider();
  const other = await rider();
  const { ride } = await liveRide(other.id);
  await prisma.ride.update({ where: { id: ride.id }, data: { status: 'COMPLETED' } });

  const wrong = await call(mine.token, 'POST', '/support/chat/messages', { content: 'About this trip', rideId: ride.id });
  assert.equal(wrong.body.conversation.rideId, null);
  const right = await call(other.token, 'POST', '/support/chat/messages', { content: 'I left my bag in the car', rideId: ride.id });
  assert.equal(right.body.conversation.rideId, ride.id, 'a finished trip of their own, named on purpose');
});

test('resolving closes it; the rider is told; their next message starts a new conversation', async () => {
  const r = await rider();
  const boss = await admin();
  const first = (await call(r.token, 'POST', '/support/chat/messages', { content: 'Wrong charge' })).body.conversation.id;
  await call(r.token, 'POST', '/support/chat/messages', { content: 'It was 6,000 not 6,500' });
  assert.equal((await call(r.token, 'GET', '/support/chat')).body.messages.length, 2, 'both in the one open conversation');
  live.length = 0;

  const done = await call(boss, 'POST', `/admin/support/conversations/${first}/resolve`);
  assert.equal(done.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(live[0].type, 'support:resolved');
  assert.equal((await call(r.token, 'GET', '/support/chat')).body.conversation.status, 'resolved');
  assert.ok(!(await call(boss, 'GET', '/admin/support/conversations')).body.items.some((item) => item.id === first));
  assert.ok((await call(boss, 'GET', '/admin/support/conversations?status=resolved')).body.items.some((item) => item.id === first));

  const again = await call(r.token, 'POST', '/support/chat/messages', { content: 'One more thing' });
  assert.notEqual(again.body.conversation.id, first);
  const chat = await call(r.token, 'GET', '/support/chat');
  assert.equal(chat.body.conversation.id, again.body.conversation.id, 'the open one is the one shown');
  assert.equal(chat.body.messages.length, 1);
});

test('a reply to a resolved chat opens it again, and an unknown conversation is not found', async () => {
  const r = await rider();
  const boss = await admin();
  const id = (await call(r.token, 'POST', '/support/chat/messages', { content: 'Lost item' })).body.conversation.id;
  await call(boss, 'POST', `/admin/support/conversations/${id}/resolve`);
  await call(boss, 'POST', `/admin/support/conversations/${id}/messages`, { content: 'We found your bag.' });
  assert.equal((await call(r.token, 'GET', '/support/chat')).body.conversation.status, 'open');
  assert.equal((await call(boss, 'GET', `/admin/support/conversations/${randomUUID()}`)).status, 404);
  assert.equal((await call(boss, 'POST', `/admin/support/conversations/${randomUUID()}/messages`, { content: 'x' })).status, 404);
});

test('too many messages in a minute are stopped with a sentence, not an error', async () => {
  const r = await rider();
  for (let i = 0; i < SUPPORT_MESSAGES_PER_MINUTE; i += 1) {
    assert.equal((await call(r.token, 'POST', '/support/chat/messages', { content: `message ${i}` })).status, 201);
  }
  const stopped = await call(r.token, 'POST', '/support/chat/messages', { content: 'one too many' });
  assert.equal(stopped.status, 429);
  assert.equal(stopped.body.code, 'RATE_LIMITED');
  assert.match(stopped.body.error, /Wait a minute/);
});
