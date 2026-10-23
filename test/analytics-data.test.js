// Where riders stop: the WhatsApp ride page reports each step (kept only when
// it is a known step, once even when sent twice), and the admin downloads the
// analysis views as CSV for Power BI or Python and sees the funnel. Against
// the local Postgres.
//
//   node scripts/run-with-env.cjs node --test --test-force-exit test/analytics-data.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { prisma } = require('@wheleers/db');
const local = require('../apps/api-gateway/dist/auth/local.js');
const { handleRidePageRoute } = require('../apps/api-gateway/dist/http/ride-page.route.js');
const { handleAdminDataRoute, csvCell, toCsv } = require('../apps/api-gateway/dist/http/admin-data.route.js');

const SECRET = 'test-secret-that-is-at-least-32-characters-long';
const made = { users: [], admins: [] };
let server; let base;
const today = new Date(Date.now() + 3600_000).toISOString().slice(0, 10);

async function admin(role) {
  const row = await prisma.adminUser.create({ data: { username: `data-${randomUUID().slice(0, 8)}`, passwordHash: 'x', name: 'Data Person', role } });
  made.admins.push(row.id);
  return local.createLocalAccessToken(row.id, SECRET, 3600);
}
async function rider() {
  const id = randomUUID();
  await prisma.user.create({ data: { id, privyDid: `whatsapp:+234${Math.floor(1e9 + Math.random() * 9e9)}`, role: 'RIDER', name: 'Data Rider' } });
  made.users.push(id);
  return id;
}
const call = async (token, method, path, body) => {
  const res = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* CSV */ }
  return { status: res.status, body: json, text, headers: res.headers };
};

test.before(async () => {
  const deps = { jwtSecret: SECRET, redisClient: { get: async () => null, set: async () => undefined, del: async () => undefined, setIfNotExists: async () => true, send: async () => null }, publisher: {}, paymentsClient: {} };
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    void (async () => {
      if (await handleRidePageRoute(req, res, deps, url)) return;
      if (await handleAdminDataRoute(req, res, { adminApiKey: 'unused', jwtSecret: SECRET }, url)) return;
      res.statusCode = 404; res.end('{}');
    })();
  });
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  server.close();
  await prisma.ridePageEvent.deleteMany({ where: { userId: { in: made.users } } });
  await prisma.adminActivity.deleteMany({ where: { adminId: { in: made.admins } } }).catch(() => {});
  await prisma.adminUser.deleteMany({ where: { id: { in: made.admins } } });
  await prisma.user.deleteMany({ where: { id: { in: made.users } } });
  await prisma.$disconnect();
});

test('CSV cells: commas, quotes, new lines, dates and numbers come out as Excel and Power BI read them', () => {
  assert.equal(csvCell('Yaba, Lagos'), '"Yaba, Lagos"');
  assert.equal(csvCell('He said "go"'), '"He said ""go"""');
  assert.equal(csvCell('two\nlines'), '"two\nlines"');
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(4100), '4100');
  // A rider's text that starts like a formula stays text in Excel; numbers keep their sign.
  assert.equal(csvCell('=HYPERLINK("http://x","y")'), '"\'=HYPERLINK(""http://x"",""y"")"');
  assert.equal(csvCell('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(csvCell(-250), '-250');
  assert.equal(csvCell(new Date('2026-10-23T08:00:00Z')), '2026-10-23T08:00:00.000Z');
  assert.equal(toCsv([{ a: 1, b: 'x,y' }, { a: 2, b: null }]), 'a,b\r\n1,"x,y"\r\n2,\r\n');
});

test('the page reports its steps: known ones are kept once, junk is dropped, and they become one visit with where it ended', async () => {
  const user = await rider();
  const token = local.createWalletPageToken(user, 'ride', SECRET, local.RIDE_PAGE_TOKEN_TTL_SECONDS);
  const sessionId = `s${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  const at = (s) => new Date(Date.now() - (60 - s) * 1000).toISOString();
  const steps = [
    { seq: 1, event: 'page_opened', at: at(0) },
    { seq: 2, event: 'phase_shown', phase: 'price', at: at(1) },
    { seq: 3, event: 'price_changed', phase: 'price', at: at(5), props: { method: 'plus', amountNgn: 4200 } },
    { seq: 4, event: 'find_tapped', phase: 'price', at: at(8), props: { amountNgn: 4200 } },
    { seq: 5, event: 'phase_shown', phase: 'offers', at: at(9) },
    { seq: 6, event: 'offer_received', phase: 'offers', at: at(30), props: { count: 2, lowestNgn: 4500 } },
    { seq: 7, event: 'cancel_opened', phase: 'offers', at: at(40) },
    { seq: 8, event: 'cancel_confirmed', phase: 'offers', at: at(45), props: { reason: 'The prices are too high', nested: { no: 1 } } },
    { seq: 9, event: 'drop_table', at: at(46) },
    { seq: 0, event: 'page_left', at: at(47) },
  ];
  const sent = await call(token, 'POST', '/ride-page/events', { sessionId, events: steps });
  assert.equal(sent.status, 202);
  assert.equal(sent.body.kept, 8, 'an unknown step and a step numbered 0 are dropped');
  const again = await call(token, 'POST', '/ride-page/events', { sessionId, events: steps.slice(0, 3) });
  assert.equal(again.status, 202);
  assert.equal(await prisma.ridePageEvent.count({ where: { sessionId } }), 8, 'sent twice, kept once');
  const kept = await prisma.ridePageEvent.findFirst({ where: { sessionId, event: 'cancel_confirmed' } });
  assert.deepEqual(kept.props, { reason: 'The prices are too high' }, 'only flat details are kept');
  assert.equal((await call(token, 'POST', '/ride-page/events', { sessionId: 'x', events: [] })).status, 400);
  assert.equal((await call('not-a-token', 'POST', '/ride-page/events', { sessionId, events: [] })).status, 401);

  const [visit] = await prisma.$queryRaw`SELECT * FROM ride_page_sessions WHERE session_id = ${sessionId}`;
  assert.equal(visit.furthest_step, '3_got_offers');
  assert.equal(visit.outcome, 'cancelled');
  assert.equal(visit.cancel_reason, 'The prices are too high');
  assert.equal(Number(visit.price_changes), 1);
  assert.equal(visit.last_event, 'cancel_confirmed');
});

test('the admin downloads a dataset as CSV and sees the funnel; support cannot', async () => {
  const owner = await admin('OWNER');
  const support = await admin('SUPPORT');
  assert.ok([401, 403].includes((await call(support, 'GET', `/admin/data/datasets`)).status));

  const list = await call(owner, 'GET', `/admin/data/datasets?from=${today}&to=${today}`);
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.datasets.map((d) => d.name), ['ride_funnel', 'ride_page_sessions', 'ride_page_events', 'ride_bids', 'rider_events', 'price_quotes']);
  assert.ok(list.body.datasets.find((d) => d.name === 'ride_page_events').rows >= 8);

  const csv = await call(owner, 'GET', `/admin/data/export?dataset=ride_page_sessions&from=${today}&to=${today}`);
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(csv.headers.get('content-disposition'), /wheelers-ride_page_sessions-/);
  const raw = Buffer.from(await (await fetch(`${base}/admin/data/export?dataset=ride_page_sessions&from=${today}&to=${today}`, { headers: { authorization: `Bearer ${owner}` } })).arrayBuffer());
  assert.deepEqual([...raw.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'a byte-order mark, so Excel reads ₦ right');
  assert.match(csv.text.split('\r\n')[0], /^session_id,user_id,/);
  assert.match(csv.text, /The prices are too high/);
  assert.equal((await call(owner, 'GET', `/admin/data/export?dataset=User&from=${today}&to=${today}`)).status, 400, 'only the listed views');
  assert.equal((await call(owner, 'GET', `/admin/data/export?dataset=ride_funnel&from=nonsense`)).status, 400);

  const f = await call(owner, 'GET', `/admin/data/funnel?from=${today}&to=${today}`);
  assert.equal(f.status, 200);
  assert.ok(f.body.page.opened >= 1);
  assert.ok(f.body.page.got_offers >= 1);
  assert.ok(f.body.leftAt.some((r) => r.step === '3_got_offers' && r.lastEvent === 'cancel_confirmed'));
  assert.ok(Array.isArray(f.body.rides));
  assert.ok('whatsapp_quoted_riders' in f.body.quotes);
});
