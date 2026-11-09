import { randomUUID } from 'node:crypto';
import { authenticate, type AuthenticateResult, type DNSResolver } from 'mailauth';
import { simpleParser, type AddressObject, type Attachment, type ParsedMail } from 'mailparser';
import { SMTPServer, type SMTPServerAddress, type SMTPServerSession } from 'smtp-server';
import { prisma } from '@wheleers/db';
import type { Prisma } from '@wheleers/db';
import { domainOfAddress, normaliseAddress } from './address';
import type { MailConfig } from './config';
import { originalMessageId, originalTo, parseDeliveryStatus, parseFeedbackReport } from './reports';
import { deliveryFromBounceAddress, isHardBounce } from './worker';

export type InboundDeps = {
  /** DNS for SPF, DKIM and DMARC checks; tests pass their own. */
  resolver?: DNSResolver;
};

/** Addresses every domain must take mail for (RFC 5321, RFC 2142), kept in their own mailboxes. */
const ROLE_MAILBOXES = ['postmaster', 'abuse'];
const MAX_RECIPIENTS = 50;
const CONNECTIONS_PER_MINUTE = 30;

class SmtpError extends Error {
  constructor(readonly responseCode: number, message: string) {
    super(message);
  }
}

const addressesOf = (value: AddressObject | AddressObject[] | undefined) =>
  (Array.isArray(value) ? value : value ? [value] : []).flatMap((a) => a.value).flatMap((v) => (v.group ? v.group : [v])).map((v) => v.address?.toLowerCase()).filter((a): a is string => Boolean(a));

const snippetOf = (text: string | undefined) => (text ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);

/**
 * The receiving side: an SMTP server on port 25 for our inbound domains.
 *
 * Who it takes mail for: our mailboxes (MailMailbox), postmaster@ and abuse@,
 * the DMARC report address, and bounce addresses (b+<delivery>@bounce…).
 * Anyone else on our domains: 550 no such user. Any other domain: 554, we
 * are not a relay (an open relay is on every blocklist within a day). No
 * AUTH: nobody sends through this server; our own mail goes out by the worker.
 *
 * Each message is checked (SPF, DKIM, DMARC), parsed, and kept before it is
 * accepted: a 250 means it is stored. A bounce marks its delivery bounced
 * (and suppresses an address that does not exist); a complaint suppresses
 * marketing to that person; anything else lands in the inbox.
 */
export function createInboundServer(config: MailConfig, deps: InboundDeps = {}) {
  const recent = new Map<string, number[]>();
  const knownMailboxes = { at: 0, set: new Set<string>() };

  async function mailboxes(): Promise<Set<string>> {
    if (Date.now() - knownMailboxes.at > 30_000) {
      knownMailboxes.set = new Set((await prisma.mailMailbox.findMany({ select: { address: true } })).map((m) => m.address));
      knownMailboxes.at = Date.now();
    }
    return knownMailboxes.set;
  }

  /** Where mail to this address goes, or why it is refused. */
  async function destination(address: string): Promise<{ kind: 'bounce'; deliveryId: string } | { kind: 'dmarc' } | { kind: 'mailbox'; mailbox: string }> {
    const domain = domainOfAddress(address);
    if (!config.inboundDomains.includes(domain)) throw new SmtpError(554, '5.7.1 Relaying denied: this server only takes mail for its own domains');
    if (address === config.dmarcMailbox) return { kind: 'dmarc' };
    const deliveryId = deliveryFromBounceAddress(address, config.bounceDomain);
    if (deliveryId) return { kind: 'bounce', deliveryId };
    const local = address.slice(0, address.lastIndexOf('@'));
    if (ROLE_MAILBOXES.includes(local) || (await mailboxes()).has(address)) return { kind: 'mailbox', mailbox: address };
    throw new SmtpError(550, '5.1.1 No such user here');
  }

  const server = new SMTPServer({
    name: config.hostname,
    banner: 'Wheelers mail',
    size: config.smtp.maxSizeBytes,
    authOptional: true,
    disabledCommands: ['AUTH'],
    disableReverseLookup: true,
    maxClients: 100,
    socketTimeout: 60_000,
    closeTimeout: 30_000,
    logger: false,
    ...(config.smtp.tlsKey && config.smtp.tlsCert ? { key: config.smtp.tlsKey, cert: config.smtp.tlsCert } : {}),

    onConnect(session, callback) {
      // A sender opening connection after connection: slowed down, not served.
      const now = Date.now();
      const times = (recent.get(session.remoteAddress) ?? []).filter((t) => now - t < 60_000);
      times.push(now);
      recent.set(session.remoteAddress, times);
      if (recent.size > 10_000) recent.delete(recent.keys().next().value!);
      if (times.length > CONNECTIONS_PER_MINUTE) return callback(new SmtpError(421, '4.7.0 Too many connections, try again later'));
      callback();
    },

    onMailFrom(address, _session, callback) {
      // The null sender (<>) is how bounces arrive: it must be taken.
      if (address.address && !normaliseAddress(address.address)) return callback(new SmtpError(553, '5.1.7 That sender address is not valid'));
      callback();
    },

    onRcptTo(address: SMTPServerAddress, session: SMTPServerSession, callback) {
      const rcpt = normaliseAddress(address.address);
      if (!rcpt) return callback(new SmtpError(553, '5.1.3 That address is not valid'));
      if (session.envelope.rcptTo.length >= MAX_RECIPIENTS) return callback(new SmtpError(452, '4.5.3 Too many recipients'));
      destination(rcpt).then(() => callback(), (error) => callback(error instanceof SmtpError ? error : new SmtpError(451, '4.3.0 Try again later')));
    },

    onData(stream, session, callback) {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('error', () => callback(new SmtpError(451, '4.3.0 Try again later')));
      stream.on('end', () => {
        if (stream.sizeExceeded) return callback(new SmtpError(552, '5.3.4 Message too big'));
        receive(Buffer.concat(chunks), session)
          .then((id) => callback(null, `Message accepted ${id}`))
          .catch((error) => {
            console.error('[mail] could not keep a received message', { error: error instanceof Error ? error.message : String(error) });
            // Not stored, so not accepted: the sender keeps it and tries again.
            callback(new SmtpError(451, '4.3.0 Try again later'));
          });
      });
    },
  });

  async function receive(raw: Buffer, session: SMTPServerSession): Promise<string> {
    const mailFrom = session.envelope.mailFrom ? session.envelope.mailFrom.address.toLowerCase() : '';
    const helo = session.hostNameAppearsAs || '';
    const ip = session.remoteAddress.replace(/^::ffff:/, '');
    const received = Buffer.from(
      `Received: from ${helo || 'unknown'} (${session.clientHostname || `[${ip}]`} [${ip}])\r\n\tby ${config.hostname} with ${session.secure ? 'ESMTPS' : 'ESMTP'} id ${session.id}\r\n\tfor <${session.envelope.rcptTo.map((r) => r.address).join('>, <')}>; ${new Date().toUTCString()}\r\n`,
    );

    let auth: AuthenticateResult | null = null;
    try {
      auth = await authenticate(raw, {
        ip, helo, sender: mailFrom, mta: config.hostname,
        disableArc: true, disableBimi: true,
        ...(deps.resolver ? { resolver: deps.resolver } : {}),
      });
    } catch (error) {
      console.warn('[mail] could not check SPF/DKIM/DMARC', { error: error instanceof Error ? error.message : String(error) });
    }
    const stored = Buffer.concat([received, auth?.headers ? Buffer.from(auth.headers) : Buffer.alloc(0), raw]);
    const parsed = await simpleParser(raw, { keepDeliveryStatus: true, skipTextToHtml: true, maxHtmlLengthToParse: 2 * 1024 * 1024 });

    // A mailbox removed since RCPT: that copy is dropped, the rest kept.
    const destinations = (await Promise.all(session.envelope.rcptTo.map((r) => destination(r.address.toLowerCase()).catch(() => null)))).filter((d) => d !== null);
    const reportType = (parsed.headers.get('content-type') as { params?: Record<string, string> } | undefined)?.params?.['report-type']?.toLowerCase();
    const bounceTo = destinations.filter((d): d is { kind: 'bounce'; deliveryId: string } => d.kind === 'bounce');
    const summary = summaryOf(auth);
    const base = { parsed, stored, summary, ip, helo, mailFrom };

    // Real bounces come to a bounce address, or at least from the null sender (<>): a report from anyone else changes nothing.
    if (bounceTo.length || (reportType === 'delivery-status' && mailFrom === '')) {
      return keepBounce(base, bounceTo.map((d) => d.deliveryId));
    }
    if (reportType === 'feedback-report') return keepComplaint(base);
    let first = '';
    for (const d of destinations) {
      if (d.kind === 'dmarc') first ||= (await keep(base, config.dmarcMailbox, 'DMARC_REPORT')).id;
      if (d.kind === 'mailbox') first ||= (await keep(base, d.mailbox, 'MESSAGE')).id;
    }
    return first;
  }

  type Base = { parsed: ParsedMail; stored: Buffer; summary: AuthSummary; ip: string; helo: string; mailFrom: string };

  async function threadFor(parsed: ParsedMail): Promise<string> {
    const refs = [parsed.inReplyTo, ...(Array.isArray(parsed.references) ? parsed.references : parsed.references ? [parsed.references] : [])].filter((r): r is string => Boolean(r));
    if (refs.length === 0) return randomUUID();
    const earlier = await prisma.mailInboxMessage.findFirst({ where: { messageIdHeader: { in: refs } }, select: { threadId: true }, orderBy: { receivedAt: 'asc' } });
    if (earlier) return earlier.threadId;
    // An answer to a reply we sent from the inbox: the thread of the message we answered.
    const ours = await prisma.mailMessage.findFirst({ where: { messageIdHeader: { in: refs }, inReplyToInboxId: { not: null } }, select: { inReplyToInboxId: true } });
    if (ours?.inReplyToInboxId) {
      const answered = await prisma.mailInboxMessage.findUnique({ where: { id: ours.inReplyToInboxId }, select: { threadId: true } });
      if (answered) return answered.threadId;
    }
    return randomUUID();
  }

  /**
   * Stores one copy for a mailbox. A sender that never heard our 250 (the line dropped after we
   * stored it) sends the same message again: same Message-ID, same mailbox, within 30 days, so
   * it is the copy we have, and nothing is done twice.
   */
  async function keep(b: Base, mailbox: string, kind: 'MESSAGE' | 'BOUNCE' | 'COMPLAINT' | 'DMARC_REPORT'): Promise<{ id: string; duplicate: boolean }> {
    const p = b.parsed;
    const threadId = await threadFor(p);
    return prisma.$transaction(async (tx) => {
      if (p.messageId) {
        // Two copies arriving at the same moment: the second waits here, then finds the first.
        await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))', `${mailbox} ${p.messageId}`);
        const have = await tx.mailInboxMessage.findFirst({
          where: { mailbox, messageIdHeader: p.messageId, receivedAt: { gt: new Date(Date.now() - 30 * 86_400_000) } },
          select: { id: true },
        });
        if (have) return { id: have.id, duplicate: true };
      }
      const fromValue = p.from?.value?.[0];
      const references = (Array.isArray(p.references) ? p.references : p.references ? [p.references] : []).slice(-50);
      const created = await tx.mailInboxMessage.create({
        data: {
          mailbox, kind,
          fromAddress: fromValue?.address?.toLowerCase() ?? null,
          fromName: fromValue?.name || null,
          toAddresses: addressesOf(p.to),
          ccAddresses: addressesOf(p.cc),
          subject: (p.subject ?? '(no subject)').slice(0, 998),
          messageIdHeader: p.messageId ?? null,
          inReplyTo: p.inReplyTo ?? null,
          references,
          threadId,
          sentAt: p.date && !Number.isNaN(p.date.getTime()) ? p.date : null,
          text: p.text ?? null,
          html: typeof p.html === 'string' ? p.html : null,
          snippet: snippetOf(p.text),
          sizeBytes: b.stored.length,
          auth: b.summary as unknown as Prisma.InputJsonValue,
          suspicious: b.summary.suspicious,
          remoteIp: b.ip, helo: b.helo || null, mailFrom: b.mailFrom || null,
          raw: { create: { raw: b.stored } },
          attachments: {
            create: p.attachments
              .filter((a) => !['message/delivery-status', 'message/feedback-report'].includes(a.contentType) || kind !== 'MESSAGE')
              .map((a: Attachment) => ({ filename: a.filename ?? null, contentType: a.contentType, sizeBytes: a.size, contentId: a.contentId ?? null, content: a.content })),
          },
        },
        select: { id: true },
      });
      return { id: created.id, duplicate: false };
    }, { timeout: 30_000 });
  }

  /** The text of a report's parts: a part of `type` from the attachments, or the message text. */
  const partText = (p: ParsedMail, types: string[]) =>
    p.attachments.filter((a) => types.includes(a.contentType.toLowerCase())).map((a) => a.content.toString('utf8')).join('\n\n');

  /** Which of our emails a report is about: the original's Message-ID, when it is one of ours. */
  async function ourMessage(b: Base): Promise<{ id: string; stream: 'TRANSACTIONAL' | 'MARKETING' } | null> {
    const original = partText(b.parsed, ['message/rfc822', 'text/rfc822-headers', 'message/rfc822-headers']);
    const ids = new Set<string>();
    const fromPart = originalMessageId(original);
    if (fromPart) ids.add(fromPart);
    // Not every server sends a proper report: any Message-ID of ours anywhere in it.
    for (const m of b.stored.toString('utf8').matchAll(new RegExp(`<[^<>\\s]+@${config.domain.replace(/\./g, '\\.')}>`, 'g'))) ids.add(m[0]);
    if (ids.size === 0) return null;
    return prisma.mailMessage.findFirst({ where: { messageIdHeader: { in: [...ids] } }, select: { id: true, stream: true } });
  }

  async function keepBounce(b: Base, verpDeliveries: string[]): Promise<string> {
    const { id, duplicate } = await keep(b, `bounces@${config.bounceDomain}`, 'BOUNCE');
    if (duplicate) return id;
    const reports = parseDeliveryStatus(partText(b.parsed, ['message/delivery-status', 'message/global-delivery-status']) || b.parsed.text || '');
    const deliveries = verpDeliveries.length
      ? await prisma.mailDelivery.findMany({ where: { id: { in: verpDeliveries } } })
      : await (async () => {
          const message = await ourMessage(b);
          if (!message) return [];
          const recipients = reports.map((r) => r.recipient).filter((r): r is string => Boolean(r));
          return prisma.mailDelivery.findMany({ where: { messageId: message.id, ...(recipients.length ? { recipient: { in: recipients } } : {}) } });
        })();

    for (const delivery of deliveries) {
      const report = reports.find((r) => r.recipient === delivery.recipient) ?? reports[0] ?? null;
      if (report?.action === 'delayed' || report?.action === 'delivered' || report?.action === 'relayed') {
        await prisma.mailEvent.create({ data: { messageId: delivery.messageId, deliveryId: delivery.id, type: report.action === 'delayed' ? 'delayed' : 'relayed', detail: { ...report, inboxId: id } } });
        continue;
      }
      // A failure, or a bounce too badly formed to read: bounced either way (it came to this delivery's own address).
      const status = report?.status ?? null;
      const diagnostic = report?.diagnostic ?? b.parsed.subject ?? 'bounced';
      const code = Number(/\b([45]\d\d)\b/.exec(diagnostic)?.[1] ?? (status?.startsWith('5') ? 550 : status?.startsWith('4') ? 450 : 0));
      const permanent = status ? status.startsWith('5') : code >= 500;
      const hard = permanent && isHardBounce(code || 550, status, diagnostic);
      await prisma.mailDelivery.update({ where: { id: delivery.id }, data: { status: 'BOUNCED', lastCode: code || null, lastEnhanced: status, lastResponse: diagnostic.slice(0, 500) } });
      if (hard) {
        await prisma.mailSuppression.upsert({
          where: { address_stream: { address: delivery.recipient, stream: 'ALL' } },
          create: { address: delivery.recipient, stream: 'ALL', reason: 'HARD_BOUNCE', detail: diagnostic.slice(0, 500) },
          update: {},
        });
      }
      await prisma.mailEvent.create({ data: { messageId: delivery.messageId, deliveryId: delivery.id, type: 'bounced', detail: { status, diagnostic, hard, late: true, inboxId: id } } });
    }
    return id;
  }

  async function keepComplaint(b: Base): Promise<string> {
    const { id, duplicate } = await keep(b, `fbl@${config.bounceDomain}`, 'COMPLAINT');
    if (duplicate) return id;
    const report = parseFeedbackReport(partText(b.parsed, ['message/feedback-report']));
    const message = await ourMessage(b);
    const original = partText(b.parsed, ['message/rfc822', 'text/rfc822-headers', 'message/rfc822-headers']);
    const recipient = report?.recipient ?? originalTo(original);
    if (recipient) {
      // No more marketing to someone who called our mail spam. Receipts and codes still go: they asked for those.
      await prisma.mailSuppression.upsert({
        where: { address_stream: { address: recipient, stream: 'MARKETING' } },
        create: { address: recipient, stream: 'MARKETING', reason: 'COMPLAINT', detail: report?.feedbackType ?? 'abuse' },
        update: {},
      });
    }
    if (message) {
      const delivery = recipient ? await prisma.mailDelivery.findFirst({ where: { messageId: message.id, recipient } }) : null;
      await prisma.mailEvent.create({ data: { messageId: message.id, deliveryId: delivery?.id ?? null, type: 'complained', detail: { recipient, feedbackType: report?.feedbackType ?? null, inboxId: id } } });
    }
    return id;
  }

  return {
    server,
    listen(port = config.smtp.port, host = '0.0.0.0'): Promise<number> {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          const address = server.server.address();
          resolve(typeof address === 'object' && address ? address.port : port);
        });
      });
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export type AuthSummary = {
  spf: string | null;
  dkim: Array<{ domain: string | null; result: string }>;
  dmarc: string | null;
  dmarcPolicy: string | null;
  suspicious: boolean;
};

/** SPF, DKIM and DMARC in short, and whether the message looks forged. */
export function summaryOf(auth: AuthenticateResult | null): AuthSummary {
  if (!auth) return { spf: null, dkim: [], dmarc: null, dmarcPolicy: null, suspicious: false };
  const spf = auth.spf ? auth.spf.status.result : null;
  const dkim = auth.dkim.results.map((r) => ({ domain: r.signingDomain ?? null, result: r.status.result }));
  const dmarc = auth.dmarc ? auth.dmarc.status.result : null;
  const dkimPass = dkim.some((d) => d.result === 'pass');
  return {
    spf,
    dkim,
    dmarc,
    dmarcPolicy: auth.dmarc ? auth.dmarc.policy ?? null : null,
    suspicious: dmarc === 'fail' || ((spf === 'fail' || spf === 'softfail') && !dkimPass),
  };
}
