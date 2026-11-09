/**
 * What people tried in the app and how it went, as the admin Activity page
 * tells it: refusals in the words the person saw, and only what is worth a line.
 *
 *   node scripts/run-with-env.cjs node --test --test-force-exit test/user-outcomes.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { prisma, activityClient } = require('@wheleers/db');
const { outcomeOf, plainReason, describeAction, describeLiveAction, OUTCOME_FAILED, OUTCOME_OK, OUTCOME_PROBE, GUEST_USER_ID } =
  require('../apps/api-gateway/dist/analytics/user-outcomes.js');
const { handleAdminAppActivityRoute } = require('../apps/api-gateway/dist/http/admin-analytics.route.js');

const made = { users: [], events: [] };
test.after(async () => {
  await prisma.userActivityEvent.deleteMany({ where: { id: { in: made.events } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: made.users } } }).catch(() => {});
  await prisma.$disconnect();
});

test('a refusal is told in the words the person saw, with what they were doing', () => {
  const failed = outcomeOf({ method: 'POST', path: '/auth/phone/login/verify-otp', status: 400, userId: null, shownError: 'That code is not right. Check it and try again.', phone: '+2348030000001' });
  assert.equal(failed.eventType, OUTCOME_FAILED);
  assert.equal(failed.userId, GUEST_USER_ID);
  assert.equal(failed.metadata.action, 'Entered their sign-in code');
  assert.equal(failed.metadata.message, 'That code is not right. Check it and try again.');
  assert.equal(failed.metadata.phone, '+2348030000001');
  assert.equal(failed.metadata.fault, 'theirs');
});

test('a server fault says it was ours and never shows the machine\'s own words', () => {
  const broke = outcomeOf({ method: 'POST', path: '/wallet/withdrawals', status: 500, userId: 'u1', shownError: 'Cannot read properties of undefined' });
  assert.equal(broke.metadata.fault, 'ours');
  assert.match(broke.metadata.message, /Something broke on our side/);
  assert.equal(broke.metadata.action, 'Asked to withdraw money');
  assert.match(plainReason(502, 'We could not send your code. Please try again.'), /could not send your code.*fault on our side/);
  assert.match(plainReason(401, 'Unauthorized'), /asked them to sign in again/);
  assert.match(plainReason(429, undefined), /too many times/);
});

test('screens loading, constant pings and the dashboard itself are not written down', () => {
  assert.equal(outcomeOf({ method: 'GET', path: '/wallet/overview', status: 200, userId: 'u1' }), null, 'a screen that loaded');
  assert.equal(outcomeOf({ method: 'GET', path: '/rides/active', status: 404, userId: 'u1' }), null, 'nothing found is ordinary');
  assert.ok(outcomeOf({ method: 'POST', path: '/rides', status: 404, userId: 'u1' }), 'a signed-in person hitting a missing thing is still shown');
  assert.equal(outcomeOf({ method: 'GET', path: '/auth/me', status: 401, userId: null }), null, 'signed out is ordinary');
  assert.equal(outcomeOf({ method: 'POST', path: '/drivers/me/location', status: 500, userId: 'u1' }), null);
  assert.equal(outcomeOf({ method: 'POST', path: '/admin/login', status: 401, userId: null }), null);
  assert.equal(outcomeOf({ method: 'GET', path: '/interstate/driver/offers', status: 403, userId: 'u1', shownError: 'Finish your verification (KYC) before taking interstate trips.' }), null, 'the app asking by itself is not a person hitting a wall');
  assert.equal(outcomeOf({ method: 'GET', path: '/auth/session', status: 401, userId: null }), null);
  assert.equal(outcomeOf({ method: 'POST', path: '/webhooks/whatsapp', status: 500, userId: null }), null);
  assert.equal(outcomeOf({ method: 'POST', path: '/rides/estimate', status: 200, userId: 'u1' }), null, 'a price looked up is not news');
  assert.equal(outcomeOf({ method: 'GET', path: '/wallet/overview', status: 500, userId: 'u1' }).eventType, OUTCOME_FAILED, 'a screen that broke is');
});

test('what worked and is worth a line is written as a success', () => {
  const done = outcomeOf({ method: 'POST', path: '/scheduled-rides', status: 201, userId: 'u1' });
  assert.equal(done.eventType, OUTCOME_OK);
  assert.equal(done.metadata.action, 'Scheduled a ride');
  assert.equal(done.metadata.message, undefined);
  assert.equal(describeAction('PUT', '/referrals/me/code'), 'Created their own referral code');
  assert.equal(describeLiveAction('ride:request'), 'Searched for a driver');
  assert.match(describeLiveAction('ride:something_new'), /ride:something_new/);
});

test('the admin page gets the rows with names, and the day counted by problem and by people', async () => {
  const user = await prisma.user.create({ data: { privyDid: `did:test:${randomUUID()}`, role: 'RIDER', name: 'Ada Activity', phone: `+23480${Math.floor(10000000 + Math.random() * 89999999)}` } });
  made.users.push(user.id);
  const say = async (userId, eventType, metadata) => { const row = await activityClient.record({ userId, eventType, source: 'app', metadata }); made.events.push(row.id); };
  const marker = `Test wall ${randomUUID()}`;
  await say(user.id, OUTCOME_FAILED, { action: 'Searched for a driver', message: marker, fault: 'theirs', method: 'LIVE', path: 'ride:request' });
  await say(user.id, OUTCOME_FAILED, { action: 'Searched for a driver', message: marker, fault: 'theirs', method: 'LIVE', path: 'ride:request' });
  await say(GUEST_USER_ID, OUTCOME_FAILED, { action: 'Searched for a driver', message: marker, fault: 'theirs', phone: '+2348030000002' });
  await say(user.id, OUTCOME_OK, { action: 'Scheduled a ride', status: 201, method: 'POST', path: '/scheduled-rides' });

  const ask = async (query) => {
    let sent;
    const res = { setHeader() {}, end(body) { sent = JSON.parse(body); }, statusCode: 0 };
    await handleAdminAppActivityRoute({ headers: { 'x-admin-key': 'test-key' } }, res, { adminApiKey: 'test-key', jwtSecret: 's' }, new URL(`http://x/admin/analytics/app-activity?${query}`));
    return { status: res.statusCode, body: sent };
  };

  const failed = await ask('outcome=failed&limit=200');
  assert.equal(failed.status, 200);
  const mine = failed.body.rows.filter((row) => row.message === marker);
  assert.equal(mine.length, 3);
  assert.ok(mine.every((row) => row.ok === false && row.action === 'Searched for a driver'));
  const named = mine.find((row) => row.signedIn);
  assert.equal(named.name, 'Ada Activity');
  assert.equal(named.technical, 'LIVE ride:request');
  const guest = mine.find((row) => !row.signedIn);
  assert.equal(guest.phone, '+2348030000002');
  assert.equal(guest.name, null);

  const top = failed.body.summary.top.find((problem) => problem.message === marker);
  if (top) { assert.equal(top.count, 3); assert.equal(top.people, 2, 'two different people, however often each hit it'); }
  assert.ok(failed.body.summary.failed >= 3 && failed.body.summary.people >= 2);

  const ok = await ask(`outcome=ok&userId=${user.id}`);
  assert.deepEqual(ok.body.rows.map((row) => row.action), ['Scheduled a ride']);
  assert.equal(ok.body.rows[0].message, null);
});

test('a bot probing for weaknesses is kept apart from people, with what it tried; a browser\'s own asks are not', () => {
  const phpunit = outcomeOf({ method: 'POST', path: '/vendor/phpunit/phpunit/src/Util/PHP/eval-stdin.php', status: 404, userId: null });
  assert.equal(phpunit.eventType, OUTCOME_PROBE);
  assert.deepEqual(phpunit.metadata, { method: 'POST', path: '/vendor/phpunit/phpunit/src/Util/PHP/eval-stdin.php', status: 404 });
  assert.equal(outcomeOf({ method: 'GET', path: '/.env', status: 404, userId: null }).eventType, OUTCOME_PROBE, 'the commonest probe of all is a GET');
  assert.equal(outcomeOf({ method: 'HEAD', path: '/wp-login.php', status: 404, userId: null }).eventType, OUTCOME_PROBE);
  assert.equal(outcomeOf({ method: 'GET', path: '/favicon.ico', status: 404, userId: null }), null);
  assert.equal(outcomeOf({ method: 'GET', path: '/rides/active', status: 404, userId: 'u1' }), null, 'a signed-in person finding nothing is ordinary, not a probe');
});

test('the admin page leaves probes out of people\'s problems, counts them on their own, and keeps to the dates picked', async () => {
  const say = async (userId, eventType, metadata, createdAt) => {
    const row = await activityClient.record({ userId, eventType, source: 'app', metadata });
    made.events.push(row.id);
    if (createdAt) await prisma.userActivityEvent.update({ where: { id: row.id }, data: { createdAt } });
    return row;
  };
  const ip = `203.0.113.${Math.floor(Math.random() * 200)}`;
  const path = `/vendor/phpunit/${randomUUID()}.php`;
  await say(GUEST_USER_ID, OUTCOME_PROBE, { method: 'POST', path, status: 404, ip, userAgent: 'scanner' });
  await say(GUEST_USER_ID, OUTCOME_FAILED, { action: `POST ${path}`, message: 'What they asked for could not be found.', status: 404, path, method: 'POST' });
  const marker = `Old wall ${randomUUID()}`;
  await say(GUEST_USER_ID, OUTCOME_FAILED, { action: 'Searched for a driver', message: marker, phone: '+2348030000003' }, new Date('2026-01-10T10:00:00Z'));

  const ask = async (query) => {
    let sent;
    const res = { setHeader() {}, end(body) { sent = JSON.parse(body); }, statusCode: 0 };
    await handleAdminAppActivityRoute({ headers: { 'x-admin-key': 'test-key' } }, res, { adminApiKey: 'test-key', jwtSecret: 's' }, new URL(`http://x/admin/analytics/app-activity?${query}`));
    return sent;
  };

  const today = await ask('outcome=all&limit=200');
  assert.ok(!today.rows.some((row) => (row.technical ?? '').includes(path)), 'neither the probe nor an old bot 404 is a row about people');
  assert.ok(!today.summary.top.some((problem) => problem.action.includes(path)));
  assert.ok(today.probes.paths.some((entry) => entry.name === `POST ${path}`));
  assert.ok(today.probes.fromWhere.some((entry) => entry.name === ip));
  assert.equal(today.probes.recent.find((entry) => entry.path === path).userAgent, 'scanner');

  const january = await ask(`outcome=failed&from=${encodeURIComponent('2026-01-10T00:00:00Z')}&to=${encodeURIComponent('2026-01-11T00:00:00Z')}`);
  assert.deepEqual(january.rows.filter((row) => row.message === marker).length, 1, 'a row from the picked day');
  assert.ok(january.rows.every((row) => row.at >= '2026-01-10' && row.at < '2026-01-11'), 'and nothing outside it');
  assert.ok(january.summary.top.some((problem) => problem.message === marker), 'the counts are for the picked days');
  assert.equal(january.range.from, '2026-01-10T00:00:00.000Z');
  assert.ok(!january.probes.paths.some((entry) => entry.name === `POST ${path}`), 'today\'s probe is not in January');
});

test('what the person entered is kept with the line: a referral code nobody has shows which code', async () => {
  const outcome = outcomeOf({ method: 'POST', path: '/referrals/apply', status: 400, userId: randomUUID(), shownError: 'Referral code was not found.', detail: 'DEJI' });
  assert.equal(outcome.eventType, OUTCOME_FAILED);
  assert.equal(outcome.metadata.action, 'Entered a referral code');
  assert.equal(outcome.metadata.detail, 'DEJI');
  assert.equal(outcomeOf({ method: 'POST', path: '/referrals/apply', status: 400, userId: randomUUID(), shownError: 'x' }).metadata.detail, undefined);

  const user = await prisma.user.create({ data: { privyDid: `did:test:${randomUUID()}`, role: 'RIDER', name: 'Code Typer' } });
  made.users.push(user.id);
  const marker = `Referral code was not found. ${randomUUID()}`;
  const row = await activityClient.record({ userId: user.id, eventType: OUTCOME_FAILED, source: 'app', metadata: { action: 'Entered a referral code', detail: 'DEJI', message: marker, fault: 'theirs', method: 'POST', path: '/referrals/apply', status: 400 } });
  made.events.push(row.id);
  let sent;
  const res = { setHeader() {}, end(body) { sent = JSON.parse(body); }, statusCode: 0 };
  await handleAdminAppActivityRoute({ headers: { 'x-admin-key': 'test-key' } }, res, { adminApiKey: 'test-key', jwtSecret: 's' }, new URL(`http://x/admin/analytics/app-activity?outcome=failed&userId=${user.id}`));
  const line = sent.rows.find((r) => r.message === marker);
  assert.equal(line.action, 'Entered a referral code: DEJI');
  const top = sent.summary.top.find((problem) => problem.message === marker);
  if (top) assert.equal(top.action, 'Entered a referral code', 'counted by problem, not split by every code typed');
});
