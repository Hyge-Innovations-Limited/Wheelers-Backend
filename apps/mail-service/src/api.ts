import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { prisma } from '@wheleers/db';
import { normaliseAddress } from './address';
import type { MailConfig } from './config';
import { drafts, DraftError } from './drafts';
import { inbox } from './inbox';
import { enqueue, SendError, type SendInput } from './outbox';
import { dnsRecords } from './records';

/**
 * The internal API, for our own services (the api-gateway, later). It listens
 * on 127.0.0.1 only unless MAIL_API_HOST says otherwise, and then asks for
 * MAIL_API_TOKEN.
 *
 *   POST   /send                          an email (see SendInput) → 202 { id, deliveries }
 *   GET    /messages?status=&q=&limit=    sent mail, newest first
 *   GET    /messages/:id                  one, with each recipient's state and every event
 *   GET    /stats?hours=24                sent, delivered, bounced… by provider; the queue; pauses
 *   GET    /suppressions?q=               the never-send list
 *   POST   /suppressions                  { address, stream?, detail? }
 *   DELETE /suppressions/:address?stream= take one off (it bounced by mistake)
 *   GET    /mailboxes                     the addresses that receive into the inbox
 *   POST   /mailboxes                     { address, name? }
 *   DELETE /mailboxes/:address
 *   GET    /inbox?mailbox=&kind=&unread=1&archived=1&q=&limit=&before=
 *   GET    /inbox/:id                     the message, its attachments and its conversation
 *   GET    /inbox/:id/raw                 as it arrived (.eml)
 *   GET    /inbox/:id/attachments/:attId
 *   PATCH  /inbox/:id                     { read?, archived? }
 *   DELETE /inbox/:id                     to the bin (gone after 30 days)
 *   POST   /inbox/:id/reply               { text?, html?, cc?, all?, idempotencyKey? }
 *   GET    /drafts?mailbox=               unsent drafts
 *   POST   /drafts                        { mailbox, to?, cc?, subject?, text?, html?, inReplyToInboxId? }
 *   GET    /drafts/:id
 *   PATCH  /drafts/:id                    { version, …fields }  409 STALE (newer one returned) or ALREADY_SENT
 *   DELETE /drafts/:id
 *   POST   /drafts/:id/send               { version }  once; the same version again returns the same email
 *   GET    /dns                           the DNS records to set
 *   GET    /health
 */

const JSON_LIMIT = 12 * 1024 * 1024;

class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly code = 'ERROR') {
    super(message);
  }
}

function send(res: ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > JSON_LIMIT) throw new HttpError(413, 'The body is larger than 12 MB', 'TOO_LARGE');
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return parsed as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'The body must be a JSON object', 'BAD_JSON');
  }
}

function authorised(req: IncomingMessage, token: string | null): boolean {
  if (!token) return true;
  const given = Buffer.from(/^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '');
  const wanted = Buffer.from(token);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STREAMS = ['ALL', 'TRANSACTIONAL', 'MARKETING'];
const DELIVERY_STATUSES = ['QUEUED', 'SENDING', 'DEFERRED', 'DELIVERED', 'BOUNCED', 'SUPPRESSED', 'EXPIRED'];

export function createApi(config: MailConfig, extra: { health?: () => Record<string, unknown> } = {}) {
  async function route(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://mail');
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const method = req.method ?? 'GET';
    const q = (name: string) => url.searchParams.get(name);

    if (parts[0] === 'health' && method === 'GET') {
      await prisma.$queryRawUnsafe('SELECT 1');
      return send(res, 200, { ok: true, ...(extra.health?.() ?? {}) });
    }
    if (!authorised(req, config.api.token)) throw new HttpError(401, 'Unauthorized', 'UNAUTHORIZED');

    // ── sending ──
    if (parts[0] === 'send' && parts.length === 1 && method === 'POST') {
      const body = await readJson(req);
      const queued = await enqueue(config, body as unknown as SendInput);
      return send(res, queued.duplicate ? 200 : 202, queued);
    }
    if (parts[0] === 'messages' && parts.length === 1 && method === 'GET') {
      const status = q('status')?.toUpperCase() ?? null;
      if (status && !DELIVERY_STATUSES.includes(status)) throw new HttpError(400, `status is one of ${DELIVERY_STATUSES.join(', ')}`, 'BAD_REQUEST');
      const search = q('q')?.trim().toLowerCase();
      const rows = await prisma.mailMessage.findMany({
        where: {
          ...(status ? { deliveries: { some: { status: status as 'QUEUED' } } } : {}),
          ...(search ? { OR: [{ subject: { contains: search, mode: 'insensitive' } }, { deliveries: { some: { recipient: { contains: search } } } }, { tag: search }] } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: Math.min(Number(q('limit')) || 50, 200),
        select: { id: true, fromAddress: true, subject: true, stream: true, priority: true, tag: true, createdAt: true, deliveries: { select: { recipient: true, status: true, attempts: true, lastCode: true, lastResponse: true, deliveredAt: true } } },
      });
      return send(res, 200, { messages: rows });
    }
    if (parts[0] === 'messages' && parts.length === 2 && method === 'GET') {
      if (!UUID.test(parts[1]!)) throw new HttpError(404, 'No such message', 'NOT_FOUND');
      const message = await prisma.mailMessage.findUnique({
        where: { id: parts[1] },
        select: {
          id: true, fromAddress: true, subject: true, stream: true, priority: true, tag: true, messageIdHeader: true, sizeBytes: true, createdAt: true, expiresAt: true,
          deliveries: { orderBy: { createdAt: 'asc' } },
          events: { orderBy: { createdAt: 'asc' } },
        },
      });
      if (!message) throw new HttpError(404, 'No such message', 'NOT_FOUND');
      return send(res, 200, message);
    }
    if (parts[0] === 'stats' && method === 'GET') {
      const hours = Math.min(Math.max(Number(q('hours')) || 24, 1), 24 * 30);
      const since = new Date(Date.now() - hours * 3_600_000);
      const [byProvider, queue, pauses, blocked] = await Promise.all([
        prisma.mailDelivery.groupBy({ by: ['provider', 'status'], where: { createdAt: { gte: since } }, _count: true }),
        prisma.mailDelivery.groupBy({ by: ['status'], where: { status: { in: ['QUEUED', 'DEFERRED', 'SENDING'] } }, _count: true }),
        prisma.mailProviderPause.findMany({ where: { until: { gt: new Date() } } }),
        prisma.mailEvent.count({ where: { type: 'blocked', createdAt: { gte: since } } }),
      ]);
      const providers: Record<string, Record<string, number>> = {};
      for (const row of byProvider) (providers[row.provider] ??= {})[row.status] = row._count;
      return send(res, 200, {
        hours,
        providers,
        queue: Object.fromEntries(queue.map((r) => [r.status, r._count])),
        // Refused because of us (spam, policy, blocklists), not the address: watch this one.
        blocked,
        pauses,
        limitsPerHour: config.limitsPerHour,
      });
    }

    // ── the never-send list ──
    if (parts[0] === 'suppressions') {
      if (parts.length === 1 && method === 'GET') {
        const search = q('q')?.trim().toLowerCase();
        const rows = await prisma.mailSuppression.findMany({ where: search ? { address: { contains: search } } : {}, orderBy: { createdAt: 'desc' }, take: 200 });
        return send(res, 200, { suppressions: rows });
      }
      if (parts.length === 1 && method === 'POST') {
        const body = await readJson(req);
        const address = normaliseAddress(String(body.address ?? ''));
        const stream = String(body.stream ?? 'ALL').toUpperCase();
        if (!address) throw new HttpError(400, 'address is not an email address', 'BAD_REQUEST');
        if (!STREAMS.includes(stream)) throw new HttpError(400, 'stream is ALL, TRANSACTIONAL or MARKETING', 'BAD_REQUEST');
        const row = await prisma.mailSuppression.upsert({
          where: { address_stream: { address, stream } },
          create: { address, stream, reason: 'MANUAL', detail: typeof body.detail === 'string' ? body.detail.slice(0, 500) : null },
          update: {},
        });
        return send(res, 200, row);
      }
      if (parts.length === 2 && method === 'DELETE') {
        const address = normaliseAddress(parts[1]!);
        if (!address) throw new HttpError(400, 'not an email address', 'BAD_REQUEST');
        const stream = q('stream')?.toUpperCase();
        const done = await prisma.mailSuppression.deleteMany({ where: { address, ...(stream ? { stream } : {}) } });
        return send(res, 200, { removed: done.count });
      }
    }

    // ── mailboxes ──
    if (parts[0] === 'mailboxes') {
      if (parts.length === 1 && method === 'GET') return send(res, 200, { mailboxes: await prisma.mailMailbox.findMany({ orderBy: { address: 'asc' } }), inboundDomains: config.inboundDomains });
      if (parts.length === 1 && method === 'POST') {
        const body = await readJson(req);
        const address = normaliseAddress(String(body.address ?? ''));
        if (!address) throw new HttpError(400, 'address is not an email address', 'BAD_REQUEST');
        const domain = address.slice(address.lastIndexOf('@') + 1);
        if (!config.inboundDomains.includes(domain)) throw new HttpError(400, `We receive mail for ${config.inboundDomains.join(', ')} only (MAIL_INBOUND_DOMAINS)`, 'NOT_OUR_DOMAIN');
        const name = typeof body.name === 'string' ? body.name.trim().slice(0, 100) || null : null;
        const row = await prisma.mailMailbox.upsert({ where: { address }, create: { address, name }, update: { name } });
        return send(res, 200, row);
      }
      if (parts.length === 2 && method === 'DELETE') {
        const done = await prisma.mailMailbox.deleteMany({ where: { address: parts[1]!.toLowerCase() } });
        return send(res, 200, { removed: done.count });
      }
    }

    // ── the inbox ──
    if (parts[0] === 'inbox') {
      if (parts.length === 1 && method === 'GET') {
        return send(res, 200, await inbox.list({
          mailbox: q('mailbox'), kind: q('kind')?.toUpperCase() ?? null, unread: q('unread') === '1', archived: q('archived') === '1',
          search: q('q'), limit: Number(q('limit')) || 50, before: q('before'),
        }));
      }
      const id = parts[1] ?? '';
      if (!UUID.test(id)) throw new HttpError(404, 'No such message', 'NOT_FOUND');
      if (parts.length === 2 && method === 'GET') {
        const found = await inbox.get(id);
        if (!found) throw new HttpError(404, 'No such message', 'NOT_FOUND');
        return send(res, 200, found);
      }
      if (parts.length === 3 && parts[2] === 'raw' && method === 'GET') {
        const raw = await inbox.raw(id);
        if (!raw) throw new HttpError(404, 'No such message', 'NOT_FOUND');
        res.writeHead(200, { 'content-type': 'message/rfc822', 'content-disposition': `attachment; filename="${id}.eml"`, 'cache-control': 'no-store' });
        return res.end(raw.raw);
      }
      if (parts.length === 4 && parts[2] === 'attachments' && method === 'GET') {
        const file = UUID.test(parts[3]!) ? await inbox.attachment(id, parts[3]!) : null;
        if (!file) throw new HttpError(404, 'No such attachment', 'NOT_FOUND');
        const name = (file.filename ?? 'attachment').replace(/["\r\n\\]/g, '_');
        // Always a download, never shown inline: an attachment is someone else's file.
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="${name}"`, 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' });
        return res.end(file.content);
      }
      if (parts.length === 2 && method === 'PATCH') {
        const body = await readJson(req);
        const done = await inbox.mark(id, { ...(typeof body.read === 'boolean' ? { read: body.read } : {}), ...(typeof body.archived === 'boolean' ? { archived: body.archived } : {}) });
        if (!done) throw new HttpError(404, 'No such message', 'NOT_FOUND');
        return send(res, 200, { ok: true });
      }
      if (parts.length === 2 && method === 'DELETE') {
        if (!(await inbox.remove(id))) throw new HttpError(404, 'No such message', 'NOT_FOUND');
        return send(res, 200, { ok: true });
      }
      if (parts.length === 3 && parts[2] === 'reply' && method === 'POST') {
        const body = await readJson(req);
        const sent = await inbox.reply(config, id, {
          ...(typeof body.text === 'string' ? { text: body.text } : {}),
          ...(typeof body.html === 'string' ? { html: body.html } : {}),
          ...(body.cc !== undefined ? { cc: body.cc as string | string[] } : {}),
          all: body.all === true,
          ...(typeof body.idempotencyKey === 'string' ? { idempotencyKey: body.idempotencyKey } : {}),
        });
        return send(res, 202, sent);
      }
    }

    // ── drafts ──
    if (parts[0] === 'drafts') {
      if (parts.length === 1 && method === 'GET') return send(res, 200, { drafts: await drafts.list(q('mailbox')) });
      if (parts.length === 1 && method === 'POST') return send(res, 201, await drafts.create(config, await readJson(req)));
      const id = parts[1] ?? '';
      if (!UUID.test(id)) throw new HttpError(404, 'No such draft', 'NOT_FOUND');
      if (parts.length === 2 && method === 'GET') {
        const draft = await drafts.get(id);
        if (!draft) throw new HttpError(404, 'No such draft', 'NOT_FOUND');
        return send(res, 200, draft);
      }
      if (parts.length === 2 && method === 'PATCH') {
        const body = await readJson(req);
        return send(res, 200, await drafts.save(id, body.version, body));
      }
      if (parts.length === 2 && method === 'DELETE') {
        if (!(await drafts.remove(id))) throw new HttpError(404, 'No such draft', 'NOT_FOUND');
        return send(res, 200, { ok: true });
      }
      if (parts.length === 3 && parts[2] === 'send' && method === 'POST') {
        const body = await readJson(req);
        const sent = await drafts.send(config, id, body.version);
        return send(res, sent.duplicate ? 200 : 202, sent);
      }
    }

    if (parts[0] === 'dns' && method === 'GET') return send(res, 200, { records: dnsRecords(config) });
    throw new HttpError(404, 'Not found', 'NOT_FOUND');
  }

  const server = createServer((req, res) => {
    route(req, res).catch((error) => {
      if (error instanceof HttpError) return send(res, error.status, { error: error.message, code: error.code });
      if (error instanceof DraftError && (error.code === 'STALE' || error.code === 'ALREADY_SENT')) return send(res, 409, { error: error.message, code: error.code, draft: error.draft ?? null });
      if (error instanceof SendError) return send(res, error.code === 'NOT_FOUND' ? 404 : 400, { error: error.message, code: error.code });
      console.error('[mail] api error', { path: req.url, error: error instanceof Error ? error.message : String(error) });
      if (!res.headersSent) send(res, 500, { error: 'Something went wrong', code: 'INTERNAL' });
    });
  });

  return {
    server,
    listen(port = config.api.port, host = config.api.host): Promise<number> {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          const address = server.address();
          resolve(typeof address === 'object' && address ? address.port : port);
        });
      });
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
