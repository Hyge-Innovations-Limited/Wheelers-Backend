// The mail service (apps/mail-service), end to end on this machine: our
// receiving server and a stand-in for "the rest of the internet" (an SMTP
// server that takes, refuses, defers or rate-limits on command) on local
// ports, real SMTP between them, DKIM/SPF/DMARC checked against our own DNS
// answers. Needs the local Postgres (docker) with migrations applied, and
//   npm -w @wheleers/db run build && npm -w @wheleers/mail-service run build

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const { SMTPServer } = require('smtp-server');
const SMTPConnection = require('nodemailer/lib/smtp-connection').default ?? require('nodemailer/lib/smtp-connection');
const mail = require('../apps/mail-service/dist/index.js');
const { createRouter } = require('../apps/mail-service/dist/route.js');

const prisma = new PrismaClient();
const DOMAIN = 'wheelers.test';
const BOUNCE = `bounce.${DOMAIN}`;
const IN = `in.${DOMAIN}`;
const SUPPORT = `support-${randomUUID().slice(0, 8)}@${IN}`;

const key = mail.generateDkimKey();
const config = {
  hostname: `mta1.${DOMAIN}`,
  domain: DOMAIN,
  defaultFrom: `Wheelers <noreply@${DOMAIN}>`,
  bounceDomain: BOUNCE,
  inboundDomains: [BOUNCE, IN],
  dmarcMailbox: `dmarc@${BOUNCE}`,
  dkim: { selector: 'test', privateKey: key.privateKeyPem },
  publicIp: '203.0.113.7',
  outboundIp: null,
  smartHost: null,
  api: { host: '127.0.0.1', port: 0, token: null },
  smtp: { port: 0, tlsKey: null, tlsCert: null, maxSizeBytes: 5 * 1024 * 1024 },
  roles: new Set(['api', 'worker', 'smtp']),
  limitsPerHour: { other: 500, remote: 500, slowprov: 500 },
  workerConcurrency: 8,
  keepDays: 90,
};

// Our DNS, as the receiving checks see it.
const TXT = {
  [`test._domainkey.${DOMAIN}`]: `v=DKIM1; k=rsa; p=${key.publicKeyBase64}`,
  [BOUNCE]: 'v=spf1 ip4:127.0.0.1 -all',
  [`_dmarc.${DOMAIN}`]: 'v=DMARC1; p=reject',
};
const resolver = async (name, type) => {
  if (type === 'TXT' && TXT[name]) return [[TXT[name]]];
  const error = new Error(`no ${type} for ${name}`);
  error.code = 'ENOTFOUND';
  throw error;
};

// "The internet": takes mail, or answers the way the local part says.
const received = [];
const ANSWERS = {
  unknown: [550, '5.1.1 The email account that you tried to reach does not exist'],
  later: [451, '4.7.1 Greylisted, please try again later'],
  slow: [421, '4.7.28 Our system has detected an unusual rate of unsolicited mail'],
  policy: [554, '5.7.1 Message rejected as spam'],
};
const remote = new SMTPServer({
  authOptional: true, disabledCommands: ['AUTH', 'STARTTLS'], logger: false,
  onRcptTo(address, _s, cb) {
    const answer = ANSWERS[address.address.split('@')[0].replace(/\d+$/, '')];
    if (!answer) return cb();
    const error = new Error(answer[1]);
    error.responseCode = answer[0];
    cb(error);
  },
  onData(stream, session, cb) {
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => {
      received.push({ from: session.envelope.mailFrom.address, to: session.envelope.rcptTo.map((r) => r.address), raw: Buffer.concat(chunks).toString('utf8') });
      cb(null, '250 2.0.0 OK queued');
    });
  },
});

// A server that takes the whole message and then hangs up without a word: did it arrive?
const net = require('node:net');
let dropped = 0;
const dropper = net.createServer((socket) => {
  socket.write('220 drop.test ESMTP\r\n');
  let inData = false;
  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk.toString('latin1');
    if (inData) {
      if (buffer.includes('\r\n.\r\n')) { dropped += 1; socket.destroy(); }
      return;
    }
    let at;
    while ((at = buffer.indexOf('\r\n')) >= 0) {
      const line = buffer.slice(0, at).toUpperCase();
      buffer = buffer.slice(at + 2);
      if (line.startsWith('EHLO')) socket.write('250-drop.test\r\n250 8BITMIME\r\n');
      else if (line.startsWith('MAIL') || line.startsWith('RCPT')) socket.write('250 OK\r\n');
      else if (line.startsWith('DATA')) { socket.write('354 go ahead\r\n'); inData = true; return; }
      else if (line.startsWith('QUIT')) socket.end('221 bye\r\n');
      else socket.write('250 OK\r\n');
    }
  });
  socket.on('error', () => undefined);
});

let api, base, inbound, inboundPort, remotePort, dropPort, worker;

const routes = {
  [IN]: () => ({ provider: 'other', port: inboundPort }),
  [BOUNCE]: () => ({ provider: 'other', port: inboundPort }),
  'remote.test': () => ({ provider: 'remote', port: remotePort }),
  'slowprov.test': () => ({ provider: 'slowprov', port: remotePort }),
  'drop.test': () => ({ provider: 'remote', port: dropPort }),
};
const router = {
  route: async (domain) => {
    if (domain === 'nowhere.test') return { ok: false, permanent: true, reason: 'nowhere.test does not exist' };
    const r = routes[domain]?.();
    return r ? { ok: true, provider: r.provider, hosts: [{ name: 'localhost', port: r.port, ips: ['127.0.0.1'] }] } : { ok: false, permanent: false, reason: 'no route in the test' };
  },
};

async function call(method, path, body) {
  const res = await fetch(`${base}${path}`, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const type = res.headers.get('content-type') ?? '';
  return { status: res.status, body: type.includes('json') ? await res.json() : await res.text() };
}

/** Speaks SMTP to our receiving server, as someone out there would. */
function smtpTo(port, { from, to, raw }) {
  return new Promise((resolve) => {
    const c = new SMTPConnection({ host: '127.0.0.1', port, name: 'mx.remote.test', ignoreTLS: true, logger: false });
    c.on('error', (error) => resolve({ ok: false, code: error.responseCode, response: error.response }));
    c.connect((err) => {
      if (err) return resolve({ ok: false, code: err.responseCode, response: err.response });
      c.send({ from, to }, raw, (error, info) => {
        c.quit();
        if (error) resolve({ ok: false, code: error.responseCode ?? error.rejectedErrors?.[0]?.responseCode, response: error.response ?? error.rejectedErrors?.[0]?.response });
        else resolve({ ok: true, response: info.response });
      });
    });
  });
}

const delivery = (messageId) => prisma.mailDelivery.findFirst({ where: { messageId } });
const send = (body) => call('POST', '/send', { subject: 'Hello', text: 'Hi there', ...body });

test.before(async () => {
  await new Promise((r) => remote.listen(0, '127.0.0.1', r));
  remotePort = remote.server.address().port;
  await new Promise((r) => dropper.listen(0, '127.0.0.1', r));
  dropPort = dropper.address().port;
  inbound = mail.createInboundServer(config, { resolver });
  inboundPort = await inbound.listen(0, '127.0.0.1');
  api = mail.createApi(config);
  base = `http://127.0.0.1:${await api.listen(0, '127.0.0.1')}`;
  worker = mail.createWorker(config, { router });
  await prisma.mailMailbox.create({ data: { address: SUPPORT, name: 'Support' } });
});

test.after(async () => {
  await inbound?.close();
  await api?.close();
  await new Promise((r) => remote.close(r));
  await new Promise((r) => dropper.close(r));
  await prisma.mailDraft.deleteMany({ where: { mailbox: { endsWith: DOMAIN } } });
  await prisma.mailMessage.deleteMany({ where: { fromAddress: { endsWith: DOMAIN } } });
  await prisma.mailInboxMessage.deleteMany({ where: { mailbox: { endsWith: DOMAIN } } });
  await prisma.mailSuppression.deleteMany({ where: { address: { endsWith: '.test' } } });
  await prisma.mailMailbox.deleteMany({ where: { address: { endsWith: DOMAIN } } });
  await prisma.mailProviderPause.deleteMany({ where: { provider: { in: ['remote', 'slowprov', 'other'] } } });
  await prisma.$disconnect();
});

test('sent, signed and received: our mail reaches our own inbox with SPF, DKIM and DMARC passing', async () => {
  const sent = await send({ to: SUPPORT, subject: 'Your receipt', text: undefined, html: '<p>Trip <b>WH-00216</b>: ₦4,100</p>', tag: 'receipt' });
  assert.equal(sent.status, 202, JSON.stringify(sent.body));
  await worker.runOnce();
  const d = await delivery(sent.body.id);
  assert.equal(d.status, 'DELIVERED', d.lastResponse);
  assert.match(d.lastResponse, /^250/);
  const deliveredEvent = await prisma.mailEvent.findFirst({ where: { deliveryId: d.id, type: 'delivered' } });
  assert.equal(deliveredEvent.detail.tls, true, 'sent over STARTTLS');

  const list = await call('GET', `/inbox?mailbox=${encodeURIComponent(SUPPORT)}`);
  assert.equal(list.body.messages.length, 1);
  assert.equal(list.body.unreadByMailbox[SUPPORT], 1);
  const got = await call('GET', `/inbox/${list.body.messages[0].id}`);
  const m = got.body.message;
  assert.equal(m.subject, 'Your receipt');
  assert.match(m.text, /Trip WH-00216: ₦4,100/, 'a plain-text part made from the HTML');
  assert.equal(m.auth.spf, 'pass');
  assert.deepEqual(m.auth.dkim, [{ domain: DOMAIN, result: 'pass' }]);
  assert.equal(m.auth.dmarc, 'pass');
  assert.equal(m.suspicious, false);
  const raw = await call('GET', `/inbox/${m.id}/raw`);
  assert.match(raw.body, /^Received: from mta1\.wheelers\.test/);
  assert.match(raw.body, /DKIM-Signature: .*d=wheelers\.test/s);
  assert.match(raw.body, /Feedback-ID: receipt:transactional:wheelers/);
  assert.match(raw.body, /Auto-Submitted: auto-generated/);
});

test('someone writes to support; the reply goes from support, threaded, and their answer joins the same conversation', async () => {
  const first = await smtpTo(inboundPort, {
    from: 'ada@remote.test', to: [SUPPORT],
    raw: `From: Ada Obi <ada@remote.test>\r\nTo: ${SUPPORT}\r\nSubject: My trip yesterday\r\nMessage-ID: <q1@remote.test>\r\nDate: ${new Date().toUTCString()}\r\n\r\nThe driver was great, but I was charged twice.\r\n`,
  });
  assert.equal(first.ok, true, first.response);
  const inboxNow = (await call('GET', `/inbox?mailbox=${encodeURIComponent(SUPPORT)}&unread=1&q=charged`)).body.messages;
  assert.equal(inboxNow.length, 1);
  const question = inboxNow[0];
  assert.equal(question.fromName, 'Ada Obi');

  const reply = await call('POST', `/inbox/${question.id}/reply`, { text: 'Sorry Ada, the second charge is refunded.' });
  assert.equal(reply.status, 202, JSON.stringify(reply.body));
  received.length = 0;
  await worker.runOnce();
  assert.equal(received.length, 1);
  const out = received[0].raw;
  assert.deepEqual(received[0].to, ['ada@remote.test']);
  assert.match(received[0].from, /^b\+[0-9a-f]{32}@bounce\.wheelers\.test$/, 'the envelope sender names the delivery (VERP)');
  assert.match(out, new RegExp(`From: Support <${SUPPORT}>|From: ${SUPPORT}`));
  assert.match(out, /Subject: Re: My trip yesterday/);
  assert.match(out, /In-Reply-To: <q1@remote\.test>/);
  assert.doesNotMatch(out, /Auto-Submitted/, 'a person\'s reply is not marked as automatic');

  const ourId = /Message-ID: (<[^>]+>)/i.exec(out)[1];
  await smtpTo(inboundPort, {
    from: 'ada@remote.test', to: [SUPPORT],
    raw: `From: ada@remote.test\r\nTo: ${SUPPORT}\r\nSubject: Re: Re: My trip yesterday\r\nMessage-ID: <q2@remote.test>\r\nIn-Reply-To: ${ourId}\r\nReferences: <q1@remote.test> ${ourId}\r\n\r\nThank you!\r\n`,
  });
  const answer = (await call('GET', `/inbox?mailbox=${encodeURIComponent(SUPPORT)}&q=thank`)).body.messages[0];
  assert.equal(answer.threadId, question.threadId);
  const thread = (await call('GET', `/inbox/${question.id}`)).body.thread;
  assert.equal(thread.received.length, 1);
  assert.equal(thread.sent.length, 1);
  assert.equal((await call('GET', `/inbox?mailbox=${encodeURIComponent(SUPPORT)}`)).body.messages.find((x) => x.id === question.id).readAt !== null, true, 'answering marks it read');
});

test('an address that does not exist bounces at once, is never sent to again, and can be taken off the list', async () => {
  const first = await send({ to: 'unknown@remote.test' });
  await worker.runOnce();
  const d = await delivery(first.body.id);
  assert.deepEqual([d.status, d.lastCode, d.lastEnhanced], ['BOUNCED', 550, '5.1.1']);
  const listed = await prisma.mailSuppression.findFirst({ where: { address: 'unknown@remote.test' } });
  assert.equal(listed.reason, 'HARD_BOUNCE');

  const again = await send({ to: ['unknown@remote.test', 'fine@remote.test'] });
  assert.deepEqual(again.body.deliveries.map((x) => x.status).sort(), ['QUEUED', 'SUPPRESSED']);
  assert.equal((await call('DELETE', '/suppressions/unknown@remote.test')).body.removed, 1);
});

test('"try later" waits and counts the try; urgent mail waits seconds, the rest minutes', async () => {
  const normal = await send({ to: 'later@remote.test' });
  const urgent = await send({ to: 'later2@remote.test', priority: 'URGENT', subject: 'Your code is 123456' });
  const before = Date.now();
  await worker.runOnce();
  const n = await delivery(normal.body.id);
  const u = await delivery(urgent.body.id);
  assert.deepEqual([n.status, n.attempts, n.lastCode], ['DEFERRED', 1, 451]);
  assert.ok(Math.abs(n.nextAttemptAt.getTime() - before - 5 * 60_000) < 15_000, 'normal: 5 minutes');
  assert.ok(Math.abs(u.nextAttemptAt.getTime() - before - 30_000) < 15_000, 'urgent: 30 seconds');
  assert.equal(await prisma.mailSuppression.count({ where: { address: 'later@remote.test' } }), 0);
});

test('a provider that says "too fast" is left alone for half an hour: nothing else goes to it meanwhile', async () => {
  const slow = await send({ to: 'slow@slowprov.test' });
  await worker.runOnce();
  assert.equal((await delivery(slow.body.id)).status, 'DEFERRED');
  const pause = await prisma.mailProviderPause.findUnique({ where: { provider: 'slowprov' } });
  assert.ok(pause.until.getTime() > Date.now() + 25 * 60_000);

  const next = await send({ to: 'fine@slowprov.test' });
  received.length = 0;
  await worker.runOnce();
  assert.equal(received.length, 0);
  const waiting = await delivery(next.body.id);
  assert.ok(['QUEUED', 'DEFERRED'].includes(waiting.status));
  assert.equal(waiting.attempts, 0, 'held back by us, not a failed try');
  await prisma.mailProviderPause.delete({ where: { provider: 'slowprov' } });
});

test('refused as spam: bounced but the address is kept (it is about us), and counted as blocked; a domain that does not exist bounces and is listed', async () => {
  const spam = await send({ to: 'policy@remote.test' });
  const nowhere = await send({ to: 'someone@nowhere.test' });
  await worker.runOnce();
  assert.equal((await delivery(spam.body.id)).status, 'BOUNCED');
  assert.equal(await prisma.mailSuppression.count({ where: { address: 'policy@remote.test' } }), 0);
  assert.equal(await prisma.mailEvent.count({ where: { messageId: spam.body.id, type: 'blocked' } }), 1);
  assert.equal((await delivery(nowhere.body.id)).status, 'BOUNCED');
  assert.equal(await prisma.mailSuppression.count({ where: { address: 'someone@nowhere.test' } }), 1);
  const stats = await call('GET', '/stats?hours=1');
  assert.ok(stats.body.blocked >= 1);
});

test('a bounce that comes later (accepted, then returned) marks the delivery and lists the address', async () => {
  const sent = await send({ to: 'gone@remote.test' });
  await worker.runOnce();
  const d = await delivery(sent.body.id);
  assert.equal(d.status, 'DELIVERED');
  const verp = mail.bounceAddress(d.id, BOUNCE);
  const dsn = [
    'From: Mail Delivery System <MAILER-DAEMON@remote.test>', `To: ${verp}`, 'Subject: Undelivered Mail Returned to Sender',
    'MIME-Version: 1.0', 'Content-Type: multipart/report; report-type=delivery-status; boundary="B"', '',
    '--B', 'Content-Type: text/plain', '', 'Your message could not be delivered.', '',
    '--B', 'Content-Type: message/delivery-status', '', 'Reporting-MTA: dns; mx.remote.test', '',
    'Final-Recipient: rfc822; gone@remote.test', 'Action: failed', 'Status: 5.1.1', 'Diagnostic-Code: smtp; 550 5.1.1 <gone@remote.test>: Recipient address rejected: User unknown', '',
    '--B--', '',
  ].join('\r\n');
  const r = await smtpTo(inboundPort, { from: '', to: [verp], raw: dsn });
  assert.equal(r.ok, true, r.response);
  const after = await prisma.mailDelivery.findUnique({ where: { id: d.id } });
  assert.deepEqual([after.status, after.lastEnhanced], ['BOUNCED', '5.1.1']);
  assert.equal((await prisma.mailSuppression.findFirst({ where: { address: 'gone@remote.test' } })).reason, 'HARD_BOUNCE');
  assert.equal((await call('GET', '/inbox?kind=BOUNCE')).body.messages.some((x) => x.subject.startsWith('Undelivered')), true);
});

test('a spam complaint (ARF) stops marketing to that person; receipts still go', async () => {
  const sent = await send({ to: 'grumpy@remote.test' });
  await worker.runOnce();
  const ourId = (await prisma.mailMessage.findUnique({ where: { id: sent.body.id } })).messageIdHeader;
  const arf = [
    'From: feedback@remote.test', `To: postmaster@${BOUNCE}`, 'Subject: Complaint', 'MIME-Version: 1.0',
    'Content-Type: multipart/report; report-type=feedback-report; boundary="F"', '',
    '--F', 'Content-Type: text/plain', '', 'A user marked this as spam.', '',
    '--F', 'Content-Type: message/feedback-report', '', 'Feedback-Type: abuse', 'Version: 1', 'Original-Rcpt-To: grumpy@remote.test', '',
    '--F', 'Content-Type: text/rfc822-headers', '', `From: noreply@${DOMAIN}`, 'To: grumpy@remote.test', `Message-ID: ${ourId}`, 'Subject: Hello', '',
    '--F--', '',
  ].join('\r\n');
  const r = await smtpTo(inboundPort, { from: 'feedback@remote.test', to: [`postmaster@${BOUNCE}`], raw: arf });
  assert.equal(r.ok, true, r.response);
  const listed = await prisma.mailSuppression.findMany({ where: { address: 'grumpy@remote.test' } });
  assert.deepEqual(listed.map((s) => [s.stream, s.reason]), [['MARKETING', 'COMPLAINT']]);
  assert.equal(await prisma.mailEvent.count({ where: { messageId: sent.body.id, type: 'complained' } }), 1);
  const receipt = await send({ to: 'grumpy@remote.test', subject: 'Receipt' });
  assert.equal(receipt.body.deliveries[0].status, 'QUEUED');
  const promo = await send({ to: 'grumpy@remote.test', stream: 'MARKETING', unsubscribeUrl: 'https://wheelersng.com/u/x' });
  assert.equal(promo.body.deliveries[0].status, 'SUPPRESSED');
});

test('the receiving server is not a relay, knows its mailboxes, and always takes postmaster@', async () => {
  const msg = (to) => ({ from: 'x@remote.test', to: [to], raw: `From: x@remote.test\r\nTo: ${to}\r\nSubject: hi\r\n\r\nhi\r\n` });
  const relay = await smtpTo(inboundPort, msg('someone@gmail.com'));
  assert.deepEqual([relay.ok, relay.code], [false, 554]);
  const nobody = await smtpTo(inboundPort, msg(`nobody@${IN}`));
  assert.deepEqual([nobody.ok, nobody.code], [false, 550]);
  assert.equal((await smtpTo(inboundPort, msg(`postmaster@${IN}`))).ok, true);
  // A forged "bounce" from an ordinary sender to an ordinary mailbox changes nothing.
  const forged = await smtpTo(inboundPort, { from: 'x@remote.test', to: [SUPPORT], raw: 'From: x@remote.test\r\nSubject: fake\r\nContent-Type: multipart/report; report-type=delivery-status; boundary="Z"\r\n\r\n--Z\r\nContent-Type: message/delivery-status\r\n\r\nFinal-Recipient: rfc822; fine@remote.test\r\nAction: failed\r\nStatus: 5.1.1\r\n\r\n--Z--\r\n' });
  assert.equal(forged.ok, true);
  assert.equal(await prisma.mailSuppression.count({ where: { address: 'fine@remote.test' } }), 0);
});

test('sending refuses what would hurt us: another domain in From, marketing without one-click unsubscribe, bad addresses; the same key is one email', async () => {
  assert.equal((await send({ from: 'boss@gmail.com', to: 'a@remote.test' })).body.code, 'FROM_NOT_OURS');
  assert.equal((await send({ to: 'a@remote.test', stream: 'MARKETING' })).status, 400);
  assert.equal((await send({ to: 'not an address' })).status, 400);
  assert.equal((await send({ to: 'a@remote.test', subject: 'x\r\nBcc: victim@remote.test' })).status, 202, 'a line break in the subject is flattened, never a new header');
  const key = `k-${randomUUID()}`;
  const one = await send({ to: 'a@remote.test', idempotencyKey: key });
  const two = await send({ to: 'a@remote.test', idempotencyKey: key });
  assert.deepEqual([one.status, two.status, two.body.id, two.body.duplicate], [202, 200, one.body.id, true]);
  assert.equal(await prisma.mailMessage.count({ where: { idempotencyKey: key } }), 1);
});

test('expired mail is given up on; a delivery a dead worker held is taken again', async () => {
  const late = await send({ to: 'a@remote.test', priority: 'URGENT' });
  await prisma.mailMessage.update({ where: { id: late.body.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
  const held = await send({ to: 'held@remote.test' });
  const d = await delivery(held.body.id);
  await prisma.mailDelivery.update({ where: { id: d.id }, data: { status: 'SENDING', leaseUntil: new Date(Date.now() - 60_000) } });
  await worker.runOnce();
  assert.equal((await delivery(late.body.id)).status, 'EXPIRED');
  assert.equal((await delivery(held.body.id)).status, 'DELIVERED');
});

test('the parts: MX routing, bounce reading, hard bounces, waits, bounce addresses, DNS records', async () => {
  const fake = (mx, a = {}) => ({
    resolveMx: async (d) => { if (mx[d] instanceof Error) throw mx[d]; return mx[d] ?? []; },
    resolve4: async (h) => a[h] ?? (() => { throw Object.assign(new Error('none'), { code: 'ENOTFOUND' }); })(),
  });
  const err = (code) => Object.assign(new Error(code), { code });
  const route = (mx, a, d) => createRouter({ smartHost: null }, fake(mx, a)).route(d);
  const google = await route({ 'acme.ng': [{ exchange: 'alt1.aspmx.l.google.com', priority: 5 }, { exchange: 'aspmx.l.google.com', priority: 1 }] }, { 'aspmx.l.google.com': ['1.1.1.1'], 'alt1.aspmx.l.google.com': ['2.2.2.2'] }, 'acme.ng');
  assert.deepEqual([google.provider, google.hosts.map((h) => h.name)], ['gmail', ['aspmx.l.google.com', 'alt1.aspmx.l.google.com']], 'a company on Google is paced as gmail, best MX first');
  assert.equal((await route({ 'nomail.ng': [{ exchange: '', priority: 0 }] }, {}, 'nomail.ng')).permanent, true, 'null MX');
  assert.equal((await route({ 'typo.ng': err('ENOTFOUND') }, {}, 'typo.ng')).permanent, true, 'no such domain');
  assert.equal((await route({ 'flaky.ng': err('ESERVFAIL') }, {}, 'flaky.ng')).permanent, false, 'DNS trouble: try later');
  const implicit = await route({ 'old.ng': err('ENODATA') }, { 'old.ng': ['3.3.3.3'] }, 'old.ng');
  assert.deepEqual(implicit.hosts.map((h) => h.name), ['old.ng'], 'no MX: the domain itself');

  assert.deepEqual(mail.parseDeliveryStatus('Reporting-MTA: dns; x\n\nFinal-Recipient: rfc822;a@b.ng\nAction: failed\nStatus: 5.2.2\nDiagnostic-Code: smtp; 552 5.2.2 Mailbox full\n'),
    [{ recipient: 'a@b.ng', action: 'failed', status: '5.2.2', diagnostic: '552 5.2.2 Mailbox full' }]);
  assert.equal(mail.isHardBounce(550, '5.1.1', 'User unknown'), true);
  assert.equal(mail.isHardBounce(552, '5.2.2', 'Mailbox full'), false, 'a full mailbox empties');
  assert.equal(mail.isHardBounce(554, '5.7.1', 'Rejected as spam'), false);
  assert.equal(mail.nextTryAfter(1, 'NORMAL'), 5 * 60_000);
  assert.equal(mail.nextTryAfter(99, 'NORMAL'), 12 * 3_600_000);
  const id = randomUUID();
  assert.equal(mail.deliveryFromBounceAddress(mail.bounceAddress(id, BOUNCE), BOUNCE), id);
  assert.equal(mail.deliveryFromBounceAddress(mail.bounceAddress(id, BOUNCE), 'elsewhere.test'), null);
  const records = mail.dnsRecords(config);
  assert.ok(records.some((r) => r.type === 'TXT' && r.name === `test._domainkey.${DOMAIN}` && r.value.includes(key.publicKeyBase64)));
  assert.ok(records.some((r) => r.type === 'MX' && r.name === IN && r.value === `10 mta1.${DOMAIN}`));
});

/* ── never twice: the duplicate audit ─────────────────────────────────── */

test('the same email asked for again (a retried call, a double tap) is sent once, even all at once; allowRepeat sends it again', async () => {
  const body = { to: 'twice@remote.test', subject: `Twice ${randomUUID()}`, text: 'Once only' };
  const all = await Promise.all([1, 2, 3, 4, 5].map(() => send(body)));
  const ids = new Set(all.map((r) => r.body.id));
  assert.equal(ids.size, 1, 'five calls at once, one email');
  assert.equal(all.filter((r) => r.body.duplicate).length, 4);
  const again = await send({ ...body, allowRepeat: true });
  assert.notEqual(again.body.id, all[0].body.id);
  assert.equal(await prisma.mailMessage.count({ where: { subject: body.subject } }), 2);
});

test('the line drops after the whole message went out: UNCONFIRMED, and never sent a second time', async () => {
  const sent = await send({ to: 'someone@drop.test', subject: `Dropped ${randomUUID()}` });
  dropped = 0;
  await worker.runOnce();
  const d = await delivery(sent.body.id);
  assert.equal(d.status, 'UNCONFIRMED', d.lastResponse);
  assert.ok(d.bodySentAt);
  await prisma.mailDelivery.update({ where: { id: d.id }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
  await worker.runOnce();
  assert.equal(dropped, 1, 'the server saw it once');
  assert.equal(await prisma.mailEvent.count({ where: { deliveryId: d.id, type: 'unconfirmed' } }), 1);
});

test('a worker that died after the message went out: UNCONFIRMED, not sent again; one that died before: sent', async () => {
  const after = await send({ to: 'after-crash@remote.test', subject: `Crash after ${randomUUID()}` });
  const before = await send({ to: 'before-crash@remote.test', subject: `Crash before ${randomUUID()}` });
  const a = await delivery(after.body.id);
  const b = await delivery(before.body.id);
  const expired = new Date(Date.now() - 60_000);
  await prisma.mailDelivery.update({ where: { id: a.id }, data: { status: 'SENDING', leaseUntil: expired, bodySentAt: new Date(Date.now() - 120_000), attempts: 1 } });
  await prisma.mailDelivery.update({ where: { id: b.id }, data: { status: 'SENDING', leaseUntil: expired, bodySentAt: null, attempts: 1 } });
  received.length = 0;
  await worker.runOnce();
  assert.equal((await delivery(after.body.id)).status, 'UNCONFIRMED');
  assert.equal((await delivery(before.body.id)).status, 'DELIVERED');
  assert.deepEqual(received.map((r) => r.to[0]), ['before-crash@remote.test']);
});

test('two workers at once never send one email twice', async () => {
  const subject = `Two workers ${randomUUID()}`;
  const many = await Promise.all(Array.from({ length: 12 }, (_, i) => send({ to: `w${i}@remote.test`, subject })));
  received.length = 0;
  const other = mail.createWorker(config, { router });
  await Promise.all([worker.runOnce(), other.runOnce(), worker.runOnce()]);
  const got = received.filter((r) => r.raw.includes(subject)).map((r) => r.to[0]).sort();
  assert.equal(got.length, 12);
  assert.equal(new Set(got).size, 12);
  for (const m of many) assert.equal((await delivery(m.body.id)).attempts, 1);
});

test('a sender that resends us the same message (it never heard our yes) is kept once', async () => {
  const raw = `From: dup@remote.test\r\nTo: ${SUPPORT}\r\nSubject: Same twice\r\nMessage-ID: <dup-${randomUUID()}@remote.test>\r\n\r\nHello\r\n`;
  const one = await smtpTo(inboundPort, { from: 'dup@remote.test', to: [SUPPORT], raw });
  const two = await smtpTo(inboundPort, { from: 'dup@remote.test', to: [SUPPORT], raw });
  assert.deepEqual([one.ok, two.ok], [true, true], 'both answered yes, so the sender stops');
  const id = /Message-ID: (<[^>]+>)/.exec(raw)[1];
  assert.equal(await prisma.mailInboxMessage.count({ where: { messageIdHeader: id } }), 1);
});

test('drafts: saved by version; an older copy cannot overwrite or send; sent once however often send is pressed; never changed after', async () => {
  const question = (await call('GET', `/inbox?mailbox=${encodeURIComponent(SUPPORT)}&q=charged`)).body.messages[0];
  const created = await call('POST', '/drafts', { mailbox: SUPPORT, inReplyToInboxId: question.id, text: 'Hi Ada,' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const draft = created.body;
  assert.deepEqual([draft.version, draft.subject, draft.toAddresses], [1, 'Re: My trip yesterday', ['ada@remote.test']]);

  const v2 = await call('PATCH', `/drafts/${draft.id}`, { version: 1, text: 'Hi Ada, refunded.' });
  assert.equal(v2.body.version, 2);
  // The other tab, still on version 1, autosaves: refused, and handed the newer draft.
  const stale = await call('PATCH', `/drafts/${draft.id}`, { version: 1, text: 'Hi Ada' });
  assert.deepEqual([stale.status, stale.body.code, stale.body.draft.text], [409, 'STALE', 'Hi Ada, refunded.']);
  // Send from the old screen: nothing goes.
  assert.equal((await call('POST', `/drafts/${draft.id}/send`, { version: 1 })).body.code, 'STALE');

  const sends = await Promise.all([1, 2, 3].map(() => call('POST', `/drafts/${draft.id}/send`, { version: 2 })));
  assert.equal(new Set(sends.map((r) => r.body.id)).size, 1, 'three presses, one email');
  assert.equal(await prisma.mailMessage.count({ where: { idempotencyKey: `draft:${draft.id}:v2` } }), 1);
  const late = await call('PATCH', `/drafts/${draft.id}`, { version: 2, text: 'changed after' });
  assert.deepEqual([late.status, late.body.code], [409, 'ALREADY_SENT']);
  assert.equal((await call('GET', '/drafts')).body.drafts.some((d) => d.id === draft.id), false, 'a sent draft leaves the list');

  received.length = 0;
  await worker.runOnce();
  const out = received.filter((r) => r.raw.includes('refunded'));
  assert.equal(out.length, 1);
  assert.match(out[0].raw, /In-Reply-To: <q1@remote\.test>/);
});

test('a draft claimed but never queued (the process stopped in between) is finished by pressing send again: one email', async () => {
  const d = (await call('POST', '/drafts', { mailbox: SUPPORT, to: 'kemi@remote.test', subject: 'Hello Kemi', text: 'Welcome' })).body;
  await prisma.mailDraft.update({ where: { id: d.id }, data: { sentAt: new Date() } });
  const first = await call('POST', `/drafts/${d.id}/send`, { version: 1 });
  const second = await call('POST', `/drafts/${d.id}/send`, { version: 1 });
  assert.equal(first.status, 202, JSON.stringify(first.body));
  assert.deepEqual([second.status, second.body.id], [200, first.body.id]);
  assert.equal(await prisma.mailMessage.count({ where: { idempotencyKey: `draft:${d.id}:v1` } }), 1);
  // Refused as written (no recipient): stays a draft.
  const empty = (await call('POST', '/drafts', { mailbox: SUPPORT, subject: 'x', text: 'y' })).body;
  assert.equal((await call('POST', `/drafts/${empty.id}/send`, { version: 1 })).status, 400);
  assert.equal((await prisma.mailDraft.findUnique({ where: { id: empty.id } })).sentAt, null);
});
