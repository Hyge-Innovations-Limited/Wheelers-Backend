// The drivers' Feed and the CNG stations (14 Nov 2026). A driver's post waits
// for an admin and only its author sees it until then; approved, every driver
// does. Likes and reports count once per person; three reports send a live
// post back to the admin. Wheelers posts go live at once and can be pinned.
// Photos are made smaller (and cleaned) in a worker thread before they are
// stored. Stations: Lagos only, nearest first.
// Against the local Postgres, with files kept in memory.
//
//   node scripts/run-with-env.cjs node --test --test-force-exit test/driver-feed.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const Jimp = require('jimp');
const { prisma } = require('@wheleers/db');
const { LAGOS_CNG_STATIONS, nearestCngStations } = require('@wheleers/config');
const local = require('../apps/api-gateway/dist/auth/local.js');
const { handleFeedRoute, shortName, decodeCursor, encodeCursor } = require('../apps/api-gateway/dist/http/feed.route.js');
const { handleAdminFeedRoute } = require('../apps/api-gateway/dist/http/admin-feed.route.js');
const { imageSize, shrinkFeedPhoto, photoSigningWindow } = require('../apps/api-gateway/dist/storage/feed-photos.js');

const SECRET = 'test-secret-for-the-driver-feed-and-stations';
const stored = [];
const told = [];
const publisher = { publishNotificationEvent: async (event) => { told.push(event); } };
const storage = {
  getSignedUrl: async (key, _expires, _type, signingDate) => `https://files.test/${key}?at=${signingDate ? signingDate.getTime() : 'now'}`,
  upload: async ({ driverId, type, imageBuffer, mimeType }) => { const key = `mem/${driverId}/${type}-${stored.length}`; stored.push({ key, bytes: imageBuffer, mimeType }); return key; },
};
const made = { users: [], admins: [], wheelersPosts: [] };
let server; let base;

async function driver(name = 'Tunde Adebayo', kycStatus = 'APPROVED') {
  const user = await prisma.user.create({ data: { privyDid: `did:test:${randomUUID()}`, role: 'DRIVER', name } });
  made.users.push(user.id);
  const row = await prisma.driver.create({ data: { userId: user.id, kycStatus } });
  return { id: row.id, userId: user.id, token: local.createLocalAccessToken(user.id, SECRET, 3600) };
}

async function rider() {
  const user = await prisma.user.create({ data: { privyDid: `did:test:${randomUUID()}`, role: 'RIDER', name: 'A Rider' } });
  made.users.push(user.id);
  return { userId: user.id, token: local.createLocalAccessToken(user.id, SECRET, 3600) };
}

async function admin() {
  const row = await prisma.adminUser.create({ data: { username: `feed-${randomUUID().slice(0, 8)}`, passwordHash: 'x', name: 'Ada Reviewer', role: 'STAFF' } });
  made.admins.push(row.id);
  return local.createLocalAccessToken(row.id, SECRET, 3600);
}

const call = async (token, method, path, body) => {
  const res = await fetch(base + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, body: await res.json() };
};
const ids = (feed) => feed.body.posts.map((p) => p.id);
const post = async (d, text, extra = {}) => (await call(d.token, 'POST', '/drivers/feed', { text, ...extra })).body.post;
const approve = (adminToken, id) => call(adminToken, 'POST', `/admin/feed/${id}/review`, { decision: 'approve' });

async function photo(width, height) {
  const image = new Jimp(width, height, 0xff7700ff);
  return (await image.quality(90).getBufferAsync(Jimp.MIME_JPEG)).toString('base64');
}

test.before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    void (async () => {
      if (await handleFeedRoute(req, res, { jwtSecret: SECRET, feedStorage: storage }, url)) return;
      if (await handleAdminFeedRoute(req, res, { adminApiKey: 'unused-key', jwtSecret: SECRET, feedStorage: storage, publisher }, url)) return;
      res.statusCode = 404; res.end('{}');
    })();
  });
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test('stations: signed in only; nearest first from where the driver is; outside Lagos says so', async () => {
  const d = await driver();
  assert.equal((await call(null, 'GET', '/drivers/stations?lat=6.6&lng=3.35')).status, 401);

  const ikeja = await call(d.token, 'GET', '/drivers/stations?lat=6.6200&lng=3.3530');
  assert.equal(ikeja.status, 200);
  assert.equal(ikeja.body.located, true);
  assert.equal(ikeja.body.inLagos, true);
  assert.equal(ikeja.body.stations.length, LAGOS_CNG_STATIONS.length);
  assert.equal(ikeja.body.stations[0].id, 'agidingbi', 'standing at Agidingbi, it is first');
  const kms = ikeja.body.stations.map((s) => s.km);
  assert.deepEqual(kms, [...kms].sort((a, b) => a - b), 'nearest first');
  assert.ok(ikeja.body.stations.every((s) => s.minutes >= 1));

  const abuja = await call(d.token, 'GET', '/drivers/stations?lat=9.0765&lng=7.3986');
  assert.equal(abuja.body.inLagos, false);

  const nowhere = await call(d.token, 'GET', '/drivers/stations');
  assert.equal(nowhere.body.located, false);
  assert.equal(nowhere.body.stations[0].km, null, 'no distance without a position');

  const junk = await call(d.token, 'GET', '/drivers/stations?lat=abc&lng=3.3');
  assert.equal(junk.body.located, false);
});

test('the station list: every station has a pin in Lagos, a unique id, and an estimate that grows with distance', () => {
  const idsSeen = new Set();
  for (const s of LAGOS_CNG_STATIONS) {
    assert.ok(!idsSeen.has(s.id), `${s.id} is listed once`); idsSeen.add(s.id);
    assert.ok(s.lat > 6.3 && s.lat < 6.8 && s.lng > 2.7 && s.lng < 4.4, `${s.id} is in Lagos`);
  }
  const { stations } = nearestCngStations(6.45, 3.39);
  assert.ok(stations[stations.length - 1].minutes > stations[0].minutes);
});

test("a post waits for an admin: only its author sees it; approved, everyone does and the author is told", async () => {
  const author = await driver('Tunde Adebayo');
  const other = await driver('Chidi Okeke');
  const adminToken = await admin();

  const p = await post(author, '  Third Mainland is locked from Adekunle.  ', { roadAlert: true });
  assert.equal(p.status, 'waiting');
  assert.equal(p.kind, 'road_alert');
  assert.equal(p.text, 'Third Mainland is locked from Adekunle.');
  assert.deepEqual(p.author, { name: 'Tunde A.', initials: 'TA', driverId: author.id });
  assert.equal(p.mine, true);

  assert.ok(!ids(await call(other.token, 'GET', '/drivers/feed')).includes(p.id), 'not in anyone else\'s feed');
  const own = await call(author.token, 'GET', '/drivers/feed');
  assert.equal(own.body.posts[0].id, p.id, 'at the top of the author\'s own feed');
  assert.equal(own.body.canPost, true);

  const queue = await call(adminToken, 'GET', '/admin/feed?status=waiting');
  assert.ok(queue.body.items.some((i) => i.id === p.id && i.driver.shownAs === 'Tunde A.'));
  assert.ok(queue.body.counts.waiting >= 1);

  told.length = 0;
  assert.equal((await approve(adminToken, p.id)).status, 200);
  assert.equal((await approve(adminToken, p.id)).status, 409, 'decided once');
  const live = (await call(other.token, 'GET', '/drivers/feed')).body.posts.find((x) => x.id === p.id);
  assert.equal(live.status, 'live');
  assert.equal(live.mine, false);
  assert.equal(live.rejectionReason, null);
  assert.ok(told.some((e) => e.userId === author.userId && e.eventType === 'PUSH_SEND' && e.title === 'Your post is live'));
  assert.ok((await call(other.token, 'GET', '/drivers/feed?filter=alerts')).body.posts.some((x) => x.id === p.id), 'under Road alerts');
  assert.ok(!(await call(other.token, 'GET', '/drivers/feed?filter=wheelers')).body.posts.some((x) => x.id === p.id));
});

test('rejecting needs a reason; the author is told it and sees it in My posts; nobody else sees the post', async () => {
  const author = await driver('Bola Ade');
  const other = await driver();
  const adminToken = await admin();
  const p = await post(author, 'Buy my car, call 0803...');
  assert.equal((await call(adminToken, 'POST', `/admin/feed/${p.id}/review`, { decision: 'reject' })).status, 400);
  told.length = 0;
  assert.equal((await call(adminToken, 'POST', `/admin/feed/${p.id}/review`, { decision: 'reject', reason: 'Spam or advert' })).status, 200);
  assert.ok(told.some((e) => e.userId === author.userId && e.eventType === 'PUSH_SEND' && e.body === 'Spam or advert.'));
  const mine = (await call(author.token, 'GET', '/drivers/feed/mine')).body.posts.find((x) => x.id === p.id);
  assert.equal(mine.status, 'rejected');
  assert.equal(mine.rejectionReason, 'Spam or advert');
  assert.ok(!ids(await call(other.token, 'GET', '/drivers/feed')).includes(p.id));
  assert.ok(!ids(await call(author.token, 'GET', '/drivers/feed')).includes(p.id), 'a rejected post is not in the feed, only in My posts');
});

test('likes count once per person; unlike takes it back; a waiting post cannot be liked', async () => {
  const author = await driver();
  const a = await driver();
  const b = await driver();
  const adminToken = await admin();
  const p = await post(author, 'Gas queue at Alausa is short right now.');
  assert.equal((await call(a.token, 'POST', `/drivers/feed/${p.id}/like`)).status, 404, 'not live yet');
  await approve(adminToken, p.id);
  assert.equal((await call(a.token, 'POST', `/drivers/feed/${p.id}/like`)).body.likeCount, 1);
  assert.equal((await call(a.token, 'POST', `/drivers/feed/${p.id}/like`)).body.likeCount, 1, 'a double tap is one like');
  await Promise.all([call(b.token, 'POST', `/drivers/feed/${p.id}/like`), call(b.token, 'POST', `/drivers/feed/${p.id}/like`)]);
  const seen = (await call(a.token, 'GET', '/drivers/feed')).body.posts.find((x) => x.id === p.id);
  assert.equal(seen.likeCount, 2);
  assert.equal(seen.liked, true);
  assert.equal((await call(a.token, 'DELETE', `/drivers/feed/${p.id}/like`)).body.likeCount, 1);
  assert.equal((await call(a.token, 'DELETE', `/drivers/feed/${p.id}/like`)).body.likeCount, 1, 'unliking twice takes one off');
  assert.equal((await call(a.token, 'GET', '/drivers/feed')).body.posts.find((x) => x.id === p.id).liked, false);
});

test('three reports from different drivers send a live post back to the admin; approved again, the author is not told twice', async () => {
  const author = await driver();
  const reporters = [await driver(), await driver(), await driver()];
  const adminToken = await admin();
  const p = await post(author, 'Something people will not like');
  await approve(adminToken, p.id);
  await call(reporters[0].token, 'POST', `/drivers/feed/${p.id}/report`, { reason: 'Rude' });
  await call(reporters[0].token, 'POST', `/drivers/feed/${p.id}/report`, { reason: 'Rude' });
  await call(reporters[1].token, 'POST', `/drivers/feed/${p.id}/report`);
  assert.ok(ids(await call(reporters[2].token, 'GET', '/drivers/feed')).includes(p.id), 'two people: still live (one person reporting twice counts once)');
  await call(reporters[2].token, 'POST', `/drivers/feed/${p.id}/report`);
  assert.ok(!ids(await call(reporters[2].token, 'GET', '/drivers/feed')).includes(p.id), 'three: out of the feed');
  const back = (await call(adminToken, 'GET', '/admin/feed?status=waiting')).body.items.find((i) => i.id === p.id);
  assert.equal(back.wasLive, true);
  assert.equal(back.reportCount, 3);
  told.length = 0;
  await approve(adminToken, p.id);
  assert.equal(told.length, 0, 'approved again: no second "your post is live"');
  assert.ok(ids(await call(reporters[0].token, 'GET', '/drivers/feed')).includes(p.id));
  assert.equal((await prisma.feedPost.findUnique({ where: { id: p.id } })).reportCount, 0, 'reports start again');
});

test("hiding a driver hides only their posts: Wheelers posts (no driver) still show", async () => {
  const noisy = await driver();
  const me = await driver();
  const adminToken = await admin();
  const p = await post(noisy, 'Post number one');
  await approve(adminToken, p.id);
  const w = await call(adminToken, 'POST', '/admin/feed', { text: 'Rain bonus tonight 6–9pm.', pinned: true });
  assert.equal(w.status, 201);
  made.wheelersPosts.push(w.body.id);
  assert.equal((await call(me.token, 'POST', '/drivers/feed/hide', { driverId: noisy.id })).status, 200);
  const feed = await call(me.token, 'GET', '/drivers/feed');
  assert.ok(!ids(feed).includes(p.id));
  assert.ok(ids(feed).includes(w.body.id), 'the Wheelers post is still there');
  assert.equal(feed.body.posts.find((x) => x.id === w.body.id).author.name, 'Wheelers');
  assert.equal((await call(me.token, 'POST', '/drivers/feed/hide', { driverId: me.id })).status, 400, 'not yourself');
  await call(me.token, 'DELETE', '/drivers/feed/hide', { driverId: noisy.id });
  assert.ok(ids(await call(me.token, 'GET', '/drivers/feed')).includes(p.id), 'shown again');
});

test('a pinned Wheelers post sits at the top of the first page only; unpinned it takes its place by time', async () => {
  const d = await driver();
  const adminToken = await admin();
  const w = await call(adminToken, 'POST', '/admin/feed', { text: 'Pinned notice', pinned: true });
  made.wheelersPosts.push(w.body.id);
  const first = await call(d.token, 'GET', '/drivers/feed');
  const at = ids(first).indexOf(w.body.id);
  assert.ok(at >= 0 && first.body.posts.slice(0, at).every((p) => p.pinned || p.status === 'waiting'), 'above every unpinned live post');
  assert.ok((await call(d.token, 'GET', '/drivers/feed?filter=wheelers')).body.posts.some((p) => p.id === w.body.id));
  assert.equal((await call(adminToken, 'POST', `/admin/feed/${w.body.id}/pin`, { pinned: false })).status, 200);
  assert.equal((await call(d.token, 'GET', '/drivers/feed')).body.posts.find((p) => p.id === w.body.id).pinned, false);
});

test('pages follow on without repeats or gaps', async () => {
  const d = await driver();
  const adminToken = await admin();
  const mine = [];
  for (let i = 0; i < 4; i += 1) { const p = await post(d, `paging ${i}`); await approve(adminToken, p.id); mine.push(p.id); }
  // 25 more live posts so there is a second page.
  const filler = await driver();
  const rows = await Promise.all(Array.from({ length: 25 }, (_, i) => prisma.feedPost.create({ data: { driverId: filler.id, text: `filler ${i}`, status: 'APPROVED', approvedAt: new Date(Date.now() - (i + 1) * 1000) } })));
  const seen = [];
  let cursor = null;
  for (let pages = 0; pages < 50; pages += 1) {
    const page = await call(d.token, 'GET', `/drivers/feed${cursor ? `?cursor=${cursor}` : ''}`);
    seen.push(...page.body.posts.filter((p) => !p.pinned).map((p) => p.id));
    cursor = page.body.nextCursor;
    if (!cursor) break;
  }
  assert.equal(new Set(seen).size, seen.length, 'no post twice');
  for (const id of [...mine, ...rows.map((r) => r.id)]) assert.ok(seen.includes(id), 'every post once');
  assert.equal(decodeCursor('not-a-cursor'), null);
  const at = new Date('2026-11-14T10:00:00.000Z');
  assert.deepEqual(decodeCursor(encodeCursor(at, 'abc')), { at, id: 'abc' });
});

test('a road alert leaves the feed after 3 hours; a post after 30 days; My posts keeps both', async () => {
  const d = await driver();
  const other = await driver();
  const alert = await prisma.feedPost.create({ data: { driverId: d.id, kind: 'ROAD_ALERT', text: 'old alert', status: 'APPROVED', approvedAt: new Date(Date.now() - 4 * 3600_000) } });
  const fresh = await prisma.feedPost.create({ data: { driverId: d.id, kind: 'ROAD_ALERT', text: 'fresh alert', status: 'APPROVED', approvedAt: new Date(Date.now() - 3600_000) } });
  const old = await prisma.feedPost.create({ data: { driverId: d.id, text: 'last month', status: 'APPROVED', approvedAt: new Date(Date.now() - 31 * 86_400_000) } });
  const feed = ids(await call(other.token, 'GET', '/drivers/feed?filter=alerts'));
  assert.ok(feed.includes(fresh.id));
  assert.ok(!feed.includes(alert.id));
  assert.ok(!ids(await call(other.token, 'GET', '/drivers/feed')).includes(old.id));
  const mine = ids(await call(d.token, 'GET', '/drivers/feed/mine'));
  assert.ok(mine.includes(alert.id) && mine.includes(old.id));
});

test('who may post, and how much: approved drivers only, not blocked, 280 characters, 4 photos, 5 a day', async () => {
  const waiting = await driver('New Driver', 'SUBMITTED');
  assert.equal((await call(waiting.token, 'POST', '/drivers/feed', { text: 'hi' })).body.code, 'NOT_APPROVED');
  assert.equal((await call(waiting.token, 'GET', '/drivers/feed')).body.canPost, false);
  const r = await rider();
  assert.equal((await call(r.token, 'GET', '/drivers/feed')).status, 403, 'riders do not get the Feed');

  const d = await driver();
  assert.equal((await call(d.token, 'POST', '/drivers/feed', { text: '   ' })).body.code, 'EMPTY');
  assert.equal((await call(d.token, 'POST', '/drivers/feed', { text: 'x'.repeat(281) })).body.code, 'TOO_LONG');
  assert.equal((await call(d.token, 'POST', '/drivers/feed', { text: '🚗'.repeat(280) })).status, 201, '280 emoji are 280 characters');
  assert.equal((await call(d.token, 'POST', '/drivers/feed', { text: 'x', photos: ['a', 'b', 'c', 'd', 'e'] })).body.code, 'TOO_MANY_PHOTOS');
  for (let i = 0; i < 4; i += 1) assert.equal((await call(d.token, 'POST', '/drivers/feed', { text: `post ${i}` })).status, 201);
  const sixth = await call(d.token, 'POST', '/drivers/feed', { text: 'one more' });
  assert.equal(sixth.status, 429);
  assert.equal(sixth.body.code, 'DAILY_LIMIT');

  const blocked = await driver();
  const adminToken = await admin();
  assert.equal((await call(adminToken, 'POST', `/admin/feed/drivers/${blocked.id}/block`, { blocked: true })).status, 200);
  assert.equal((await call(blocked.token, 'POST', '/drivers/feed', { text: 'hello' })).body.code, 'FEED_BLOCKED');
  assert.equal((await call(blocked.token, 'GET', '/drivers/feed')).status, 200, 'a blocked driver still reads the Feed');
  await call(adminToken, 'POST', `/admin/feed/drivers/${blocked.id}/block`, { blocked: false });
  assert.equal((await call(blocked.token, 'POST', '/drivers/feed', { text: 'hello' })).status, 201);
});

test('a driver deletes their own post, not someone else\'s; an admin removes any', async () => {
  const a = await driver();
  const b = await driver();
  const adminToken = await admin();
  const p = await post(a, 'mine');
  assert.equal((await call(b.token, 'DELETE', `/drivers/feed/${p.id}`)).status, 404);
  assert.equal((await call(a.token, 'DELETE', `/drivers/feed/${p.id}`)).status, 200);
  assert.ok(!ids(await call(a.token, 'GET', '/drivers/feed/mine')).includes(p.id));
  const q = await post(b, 'theirs');
  await approve(adminToken, q.id);
  assert.equal((await call(adminToken, 'POST', `/admin/feed/${q.id}/remove`)).status, 200);
  assert.ok(!ids(await call(a.token, 'GET', '/drivers/feed')).includes(q.id));
  assert.equal((await call(null, 'GET', '/admin/feed')).status, 401);
});

test('photos: made smaller in a worker (1280 at most), stored as JPEG; links stay the same within a window; junk is refused', async () => {
  const d = await driver();
  const before = stored.length;
  const big = await photo(3000, 2000);
  const p = await post(d, 'with a photo', { photos: [big, `data:image/jpeg;base64,${await photo(400, 600)}`] });
  assert.equal(p.photos.length, 2);
  assert.deepEqual(p.photos.map((x) => [x.width, x.height]), [[1280, 853], [400, 600]], 'the big one shrank, the small one kept its size');
  const saved = stored.slice(before);
  assert.equal(saved.length, 2);
  assert.ok(saved.every((s) => s.mimeType === 'image/jpeg' && imageSize(s.bytes)?.type === 'jpeg'));
  assert.equal(imageSize(saved[0].bytes).width, 1280);

  const again = (await call(d.token, 'GET', '/drivers/feed/mine')).body.posts.find((x) => x.id === p.id);
  assert.equal(again.photos[0].url, p.photos[0].url, 'the same link, so the phone keeps it cached');

  const bad = await call(d.token, 'POST', '/drivers/feed', { text: 'x', photos: [Buffer.from('%PDF-1.4 not a photo').toString('base64')] });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, 'BAD_PHOTO');
  const broken = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x00, 0x01, 0x00]), Buffer.alloc(200, 1)]);
  assert.equal((await shrinkFeedPhoto(broken)).ok, false, 'a broken JPEG is refused, not a crash');
  // A 50 MP photo (8000 × 6250) is refused from its header alone, before anything is decoded.
  const huge = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x18, 0x6a, 0x1f, 0x40]), Buffer.alloc(200, 1)]);
  assert.deepEqual([imageSize(huge).width, imageSize(huge).height], [8000, 6250]);
  const refused = await shrinkFeedPhoto(huge);
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'A photo is too big. Pick a smaller one.');
});

test('helpers: names, image sizes, signing windows', () => {
  assert.equal(shortName('Tunde Adebayo'), 'Tunde A.');
  assert.equal(shortName('  chidi  okoro  emeka '), 'chidi E.');
  assert.equal(shortName('Ada'), 'Ada');
  assert.equal(shortName(null), 'Driver');
  assert.equal(imageSize(Buffer.from('hello')), null);
  const w1 = photoSigningWindow(Date.UTC(2026, 10, 14, 7, 5));
  const w2 = photoSigningWindow(Date.UTC(2026, 10, 14, 11, 59));
  assert.equal(w1.signingDate.getTime(), w2.signingDate.getTime(), 'same 6-hour window, same link');
  assert.ok(w1.expiresInSeconds >= 6 * 3600);
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  const drivers = await prisma.driver.findMany({ where: { userId: { in: made.users } }, select: { id: true } });
  await prisma.feedPost.deleteMany({ where: { OR: [{ driverId: { in: drivers.map((d) => d.id) } }, { id: { in: made.wheelersPosts } }] } });
  await prisma.feedHide.deleteMany({ where: { userId: { in: made.users } } });
  await prisma.adminActivity.deleteMany({ where: { adminId: { in: made.admins } } });
  await prisma.adminUser.deleteMany({ where: { id: { in: made.admins } } });
  await prisma.driver.deleteMany({ where: { userId: { in: made.users } } });
  await prisma.user.deleteMany({ where: { id: { in: made.users } } });
  await prisma.$disconnect();
});
