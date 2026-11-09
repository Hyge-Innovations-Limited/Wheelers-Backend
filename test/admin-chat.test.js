// Admin chat history (4 Nov 2026): a person's whole chat with Wheelers, and a trip's, merged in order —
// bot chat (both sides), driver chat, calls, support, booking-page taps and the trip's moments.
// Owners and support only; every view is logged. Against the local Postgres.
//
//   node scripts/run-with-env.cjs node --test --test-force-exit test/admin-chat.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Readable } = require('node:stream');
const { PrismaClient } = require('@prisma/client');
const { handleAdminChatRoute } = require('../apps/api-gateway/dist/http/admin-chat.route.js');
const local = require('../apps/api-gateway/dist/auth/local.js');

const prisma = new PrismaClient();
const SECRET = 'test-secret-that-is-at-least-32-characters-long';
const ADMIN_KEY = 'test-admin-key';
const made = { users: [], drivers: [], rides: [], admins: [], convos: [] };

test.after(async () => {
  await prisma.ridePageEvent.deleteMany({ where: { userId: { in: made.users } } });
  await prisma.whatsappMessage.deleteMany({ where: { userId: { in: made.users } } });
  await prisma.chatMessage.deleteMany({ where: { rideId: { in: made.rides } } });
  await prisma.tripCall.deleteMany({ where: { rideId: { in: made.rides } } });
  await prisma.supportConversation.deleteMany({ where: { id: { in: made.convos } } });
  await prisma.ride.deleteMany({ where: { id: { in: made.rides } } });
  await prisma.driver.deleteMany({ where: { id: { in: made.drivers } } });
  await prisma.adminActivity.deleteMany({ where: { page: { startsWith: '/admin/chats/' } } });
  await prisma.adminUser.deleteMany({ where: { id: { in: made.admins } } });
  await prisma.user.deleteMany({ where: { id: { in: made.users } } });
  await prisma.$disconnect();
});

async function call(path, { token, key } = {}) {
  const req = Readable.from([]);
  req.method = 'GET';
  req.url = path;
  req.headers = { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(key ? { 'x-admin-key': key } : {}) };
  req.socket = { remoteAddress: '127.0.0.1' };
  const res = { statusCode: 0, body: null, setHeader() {}, writeHead(c) { this.statusCode = c; }, end(t) { this.body = t ? JSON.parse(t) : null; } };
  const handled = await handleAdminChatRoute(req, res, { jwtSecret: SECRET, adminApiKey: ADMIN_KEY }, new URL(`http://x${path}`));
  return { handled, status: res.statusCode, body: res.body };
}
async function admin(role) {
  const a = await prisma.adminUser.create({ data: { username: `chat-${role}-${randomUUID()}`, passwordHash: 'x', name: `Chat ${role}`, role } });
  made.admins.push(a.id);
  return local.createLocalAccessToken(a.id, SECRET);
}
const at = (minutes) => new Date(Date.UTC(2026, 10, 1, 10, 0) + minutes * 60_000);

async function seed() {
  const tag = randomUUID().slice(0, 6);
  const rider = await prisma.user.create({ data: { privyDid: `whatsapp:23480${Date.now() % 1e8}`, role: 'RIDER', name: `Chatrider ${tag}`, phone: `+23480${Date.now() % 1e8}` } });
  const du = await prisma.user.create({ data: { privyDid: `did:test:${randomUUID()}`, role: 'DRIVER', name: `Chatdriver ${tag}` } });
  made.users.push(rider.id, du.id);
  const driver = await prisma.driver.create({ data: { userId: du.id, status: 'ONLINE' } });
  made.drivers.push(driver.id);
  const ride = await prisma.ride.create({ data: {
    riderId: rider.id, driverId: driver.id, status: 'COMPLETED', pickupAddress: 'Yaba', destAddress: 'Ikeja', pickupLat: 6.5, pickupLng: 3.37, destLat: 6.6, destLng: 3.35,
    agreedFareNgn: 3300, createdAt: at(0), matchedAt: at(2), arrivedAt: at(9), startedAt: at(10), completedAt: at(30),
  } });
  made.rides.push(ride.id);
  await prisma.whatsappMessage.createMany({ data: [
    { userId: rider.id, role: 'user', content: 'hi', kind: 'text', createdAt: at(-1) },
    { userId: rider.id, role: 'assistant', content: 'Hi Chatrider, where are you headed?\n[Quick Actions]', kind: 'form', createdAt: at(-0.5) },
    { userId: rider.id, role: 'user', content: 'Accept', kind: 'tap', createdAt: at(1.5) },
    { userId: rider.id, role: 'assistant', content: '🚗', kind: 'reaction', createdAt: at(2.1) },
    // Long before this trip: in the person's history, not the trip's.
    { userId: rider.id, role: 'user', content: 'old message', kind: 'text', createdAt: at(-600) },
  ] });
  await prisma.chatMessage.createMany({ data: [
    { rideId: ride.id, senderId: du.id, senderRole: 'DRIVER', content: 'I am outside', createdAt: at(9.5) },
    { rideId: ride.id, senderId: rider.id, senderRole: 'RIDER', content: 'Coming', createdAt: at(9.7) },
  ] });
  await prisma.tripCall.create({ data: { rideId: ride.id, callerId: rider.id, callerRole: 'RIDER', calleeId: du.id, calleeChannel: 'app', status: 'COMPLETED', durationSeconds: 72, createdAt: at(8) } });
  const convo = await prisma.supportConversation.create({ data: { userId: rider.id, rideId: ride.id, messages: { create: [
    { sender: 'USER', content: 'I left my bag', createdAt: at(35) },
    { sender: 'SUPPORT', senderName: 'Bola', content: 'We are on it', createdAt: at(36) },
  ] } } });
  made.convos.push(convo.id);
  await prisma.ridePageEvent.createMany({ data: [
    { sessionId: `s-${tag}`, userId: rider.id, rideId: ride.id, event: 'page_opened', seq: 1, clientAt: at(0.5), createdAt: at(0.5) },
    { sessionId: `s-${tag}`, userId: rider.id, rideId: ride.id, event: 'phase_shown', seq: 2, clientAt: at(0.6), createdAt: at(0.6) },
    { sessionId: `s-${tag}`, userId: rider.id, rideId: ride.id, event: 'price_changed', seq: 3, props: { priceNgn: 3500 }, clientAt: at(0.7), createdAt: at(0.7) },
  ] });
  return { rider, driverUser: du, ride };
}

test('owners and support only; staff and strangers are refused', async () => {
  assert.equal((await call('/admin/chats/people')).status, 401);
  assert.equal((await call('/admin/chats/people', { token: await admin('STAFF') })).status, 403);
  assert.equal((await call('/admin/chats/people', { token: await admin('SUPPORT') })).status, 200);
  assert.equal((await call('/admin/chats/trips', { key: ADMIN_KEY })).status, 200);
  assert.equal((await call('/admin/other')).handled, false);
});

test('a person: everything in order, both sides of the bot chat, the driver chat, the call, support, page taps, the trip\'s moments', async () => {
  const { rider, ride } = await seed();
  const res = await call(`/admin/chats/people/${rider.id}`, { key: ADMIN_KEY });
  assert.equal(res.status, 200);
  assert.equal(res.body.user.name, rider.name);
  const lines = res.body.items.map((i) => `${i.who}|${i.source}|${i.text.split('\n')[0]}`);
  assert.deepEqual(lines, [
    'rider|whatsapp|old message',
    'rider|whatsapp|hi',
    'bot|whatsapp|Hi Chatrider, where are you headed?',
    `system|trip|${res.body.items.find((i) => i.kind === 'trip').text}`,
    'rider|page|Opened the booking page',
    'rider|page|Changed the price: ₦3,500',
    'rider|whatsapp|Accept',
    `system|trip|Driver accepted: ${ride && (await prisma.user.findFirst({ where: { driver: { id: ride.driverId } } })).name}`,
    'bot|whatsapp|🚗',
    'rider|call|Rider called · completed · 1:12',
    'system|trip|Driver arrived',
    'driver|trip_chat|I am outside',
    'rider|trip_chat|Coming',
    'system|trip|Trip started',
    'system|trip|Trip completed',
    'rider|support|I left my bag',
    'support|support|Bola: We are on it',
  ]);
  const divider = res.body.items.find((i) => i.kind === 'trip');
  assert.match(divider.text, /^WH-\d+ · Yaba → Ikeja · ₦3,300 · completed$/);
  assert.equal(res.body.olderBefore, null, 'all of it fits on one page');
  const people = await call(`/admin/chats/people?q=${encodeURIComponent(rider.name)}`, { key: ADMIN_KEY });
  assert.deepEqual(people.body.items.map((p) => [p.userId, p.trips]), [[rider.id, 1]]);
  assert.match(people.body.items[0].lastText, /^Accept$|old message|🚗/);
});

test('a trip: only around that trip (the old message is not in it), with the rider and the driver named; older pages by before', async () => {
  const { rider, ride } = await seed();
  const res = await call(`/admin/chats/trips/${ride.id}`, { key: ADMIN_KEY });
  assert.equal(res.status, 200);
  assert.equal(res.body.rider.userId, rider.id);
  assert.ok(res.body.driver.name.startsWith('Chatdriver'));
  assert.ok(!res.body.items.some((i) => i.text === 'old message'), 'outside the trip window');
  assert.ok(res.body.items.some((i) => i.text === 'I am outside'));
  assert.ok(res.body.items.some((i) => i.text === 'Coming'));
  const trips = await call(`/admin/chats/trips?q=${res.body.ride.tripId}`, { key: ADMIN_KEY });
  assert.deepEqual(trips.body.items.map((t) => [t.rideId, t.chats, t.calls]), [[ride.id, 2, 1]]);
  const page = await call(`/admin/chats/people/${rider.id}?limit=3`, { key: ADMIN_KEY });
  assert.equal(page.body.items.length, 3);
  assert.ok(page.body.olderBefore, 'there is more');
  const older = await call(`/admin/chats/people/${rider.id}?limit=3&before=${encodeURIComponent(page.body.olderBefore)}`, { key: ADMIN_KEY });
  assert.ok(older.body.items.every((i) => i.at < page.body.olderBefore), 'the next page is older');
  assert.equal((await call(`/admin/chats/people/${rider.id}?before=yesterday`, { key: ADMIN_KEY })).status, 400);
  assert.equal((await call('/admin/chats/trips/00000000-0000-4000-8000-00000000dead', { key: ADMIN_KEY })).status, 404);
  assert.ok(await prisma.adminActivity.count({ where: { page: { startsWith: '/admin/chats/' }, kind: 'view' } }) > 0, 'views are logged');
});
