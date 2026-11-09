import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { convert as htmlToText } from 'html-to-text';
import MailComposer from 'nodemailer/lib/mail-composer';
import { prisma } from '@wheleers/db';
import { AddressError, domainOfAddress, formatMailbox, parseMailboxes, type Mailbox } from './address';
import type { MailConfig } from './config';
import { signMessage } from './dkim';
import { providerForDomain } from './providers';

/** What a caller asks us to send. */
export type SendInput = {
  /** "Wheelers <noreply@wheelersng.com>" (the default). Must be on our domain: we sign as it. */
  from?: string;
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  replyTo?: string;
  subject: string;
  text?: string;
  html?: string;
  /** TRANSACTIONAL (receipts, codes, notices) or MARKETING. */
  stream?: 'TRANSACTIONAL' | 'MARKETING';
  /** URGENT (a sign-in code): first in the queue, retried within seconds, given up on soon. */
  priority?: 'URGENT' | 'NORMAL';
  /**
   * The same key twice is the same email: sent once, the first answer returned again. Give one
   * per real event ("password_reset:<request id>"), so a retried job never sends twice. Without
   * one, the same email to the same people within 10 minutes counts as the same (a retried
   * call, a double tap) unless allowRepeat is set.
   */
  idempotencyKey?: string;
  allowRepeat?: boolean;
  /** Give up delivering after this. Default 15 minutes when URGENT, a day otherwise, 3 days for MARKETING. */
  expiresInMinutes?: number;
  /** What it is, for counting: "password_reset". */
  tag?: string;
  /** For marketing: the one-click unsubscribe link (RFC 8058) that Gmail and Yahoo ask for. */
  unsubscribeUrl?: string;
  /** Threading a reply. */
  inReplyTo?: string;
  references?: string[];
  inReplyToInboxId?: string;
};

export type Queued = {
  id: string;
  messageId: string;
  duplicate: boolean;
  deliveries: Array<{ recipient: string; status: string }>;
};

export class SendError extends Error {
  constructor(message: string, readonly code = 'BAD_REQUEST') {
    super(message);
  }
}

const MAX_RECIPIENTS = 50;
const MAX_RAW_BYTES = 10 * 1024 * 1024;
const TAG = /^[a-z0-9_.:-]{1,60}$/i;
/** Without a key, the same email again within this long is taken for a repeat of the first. */
const REPEAT_WINDOW_MS = 10 * 60_000;

/** Tells the worker in this process there is mail, so an urgent one does not wait for the next round. */
export const outboxSignal = new EventEmitter();

function plainHeader(value: string, field: string, max = 998): string {
  const v = value.replace(/\s+/g, ' ').trim();
  if (!v) throw new SendError(`${field} is empty`);
  if (v.length > max) throw new SendError(`${field} is longer than ${max} characters`);
  return v;
}

export function suppressionStreams(stream: 'TRANSACTIONAL' | 'MARKETING') {
  return ['ALL', stream];
}

/**
 * Checks, builds, signs and queues an email: one row for the message and one
 * per recipient. Recipients on the suppression list are kept as SUPPRESSED
 * (never sent). The same idempotencyKey again returns the first answer.
 */
export async function enqueue(config: MailConfig, input: SendInput): Promise<Queued> {
  const idempotencyKey = input.idempotencyKey?.trim() ? plainHeader(input.idempotencyKey, 'idempotencyKey', 200) : null;
  if (idempotencyKey) {
    const existing = await findByKey(idempotencyKey);
    if (existing) return existing;
  }

  let from: Mailbox;
  let to: Mailbox[];
  let cc: Mailbox[];
  let bcc: Mailbox[];
  let replyTo: Mailbox[];
  try {
    const fromList = parseMailboxes(input.from ?? config.defaultFrom, 'from');
    if (fromList.length !== 1) throw new SendError('from must be one address');
    from = fromList[0]!;
    to = parseMailboxes(input.to, 'to');
    cc = parseMailboxes(input.cc, 'cc');
    bcc = parseMailboxes(input.bcc, 'bcc');
    replyTo = parseMailboxes(input.replyTo, 'replyTo');
  } catch (error) {
    if (error instanceof AddressError) throw new SendError(error.message);
    throw error;
  }
  const fromDomain = domainOfAddress(from.address);
  // We can only sign for our own domain; mail "from" anyone else would fail DMARC (and is not ours to send).
  if (fromDomain !== config.domain && !fromDomain.endsWith(`.${config.domain}`)) {
    throw new SendError(`from must be an address on ${config.domain}`, 'FROM_NOT_OURS');
  }
  const recipients = [...new Set([...to, ...cc, ...bcc].map((m) => m.address))];
  if (recipients.length === 0) throw new SendError('to is needed');
  if (recipients.length > MAX_RECIPIENTS) throw new SendError(`at most ${MAX_RECIPIENTS} recipients`);

  const subject = plainHeader(typeof input.subject === 'string' ? input.subject : '', 'subject');
  const html = typeof input.html === 'string' && input.html.trim() ? input.html : null;
  const text = typeof input.text === 'string' && input.text.trim() ? input.text : html ? htmlToText(html, { wordwrap: 78 }) : null;
  if (!text) throw new SendError('text or html is needed');
  const stream = input.stream === 'MARKETING' ? 'MARKETING' : 'TRANSACTIONAL';
  const priority = input.priority === 'URGENT' ? 'URGENT' : 'NORMAL';
  if (input.tag !== undefined && !TAG.test(input.tag)) throw new SendError('tag: letters, numbers and _ . : - only, at most 60');
  const tag = input.tag ?? null;
  const defaultMinutes = priority === 'URGENT' ? 15 : stream === 'MARKETING' ? 3 * 24 * 60 : 24 * 60;
  const minutes = Number.isFinite(input.expiresInMinutes) ? Math.min(Math.max(Number(input.expiresInMinutes), 1), 5 * 24 * 60) : defaultMinutes;

  const headers: Record<string, string> = {
    // Gmail's complaint feedback groups by this (campaign:stream:sender).
    'Feedback-ID': `${tag ?? 'mail'}:${stream.toLowerCase()}:wheelers`,
  };
  if (stream === 'TRANSACTIONAL' && !input.inReplyToInboxId) {
    // Tells out-of-office robots not to answer a notice (RFC 3834).
    headers['Auto-Submitted'] = 'auto-generated';
  }
  if (input.unsubscribeUrl) {
    let url: URL;
    try {
      url = new URL(input.unsubscribeUrl);
    } catch {
      throw new SendError('unsubscribeUrl is not a link');
    }
    if (url.protocol !== 'https:') throw new SendError('unsubscribeUrl must be https');
    headers['List-Unsubscribe'] = `<${url.toString()}>`;
    headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
  } else if (stream === 'MARKETING') {
    throw new SendError('marketing mail needs an unsubscribeUrl (Gmail and Yahoo require one-click unsubscribe)');
  }

  const messageIdHeader = `<${randomUUID()}@${config.domain}>`;
  const references = (input.references ?? []).filter((r) => typeof r === 'string' && /^<[^<>\s]+>$/.test(r)).slice(-20);
  const inReplyTo = input.inReplyTo && /^<[^<>\s]+>$/.test(input.inReplyTo) ? input.inReplyTo : undefined;

  const composed = await new MailComposer({
    from: formatMailbox(from),
    to: to.map(formatMailbox),
    cc: cc.length ? cc.map(formatMailbox) : undefined,
    replyTo: replyTo.length ? replyTo.map(formatMailbox) : undefined,
    subject,
    text,
    html: html ?? undefined,
    messageId: messageIdHeader,
    date: new Date(),
    inReplyTo,
    references: references.length ? references : undefined,
    headers,
    xMailer: false,
    disableFileAccess: true,
    disableUrlAccess: true,
  }).compile().build();

  if (!config.dkim.privateKey) throw new SendError('No DKIM key is set (MAIL_DKIM_KEY_PATH): unsigned mail goes to spam, so none is sent', 'NO_DKIM_KEY');
  const raw = await signMessage(composed, config.domain, config.dkim.selector, config.dkim.privateKey);
  if (raw.length > MAX_RAW_BYTES) throw new SendError(`the email is ${Math.round(raw.length / 1024 / 1024)} MB; at most 10 MB`);

  // Who, what and from whom, not when: the same email asked for twice hashes the same.
  const contentHash = createHash('sha256')
    .update(JSON.stringify([from.address, [...recipients].sort(), subject, text, html ?? '', stream, inReplyTo ?? '']))
    .digest('hex');
  const checkRepeat = !idempotencyKey && input.allowRepeat !== true;

  const suppressed = new Set(
    (await prisma.mailSuppression.findMany({ where: { address: { in: recipients }, stream: { in: suppressionStreams(stream) } }, select: { address: true } }))
      .map((s) => s.address),
  );

  try {
    const message = await prisma.$transaction(async (tx) => {
      if (checkRepeat) {
        // Two identical calls at once: the lock makes the second wait and then find the first.
        await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))', contentHash);
        const repeat = await tx.mailMessage.findFirst({
          where: { contentHash, createdAt: { gt: new Date(Date.now() - REPEAT_WINDOW_MS) } },
          orderBy: { createdAt: 'asc' },
          select: { id: true, messageIdHeader: true, deliveries: { select: { recipient: true, status: true } } },
        });
        if (repeat) return { repeat };
      }
      const created = await tx.mailMessage.create({
        data: {
          stream, priority, fromAddress: from.address, subject, messageIdHeader, raw, sizeBytes: raw.length,
          idempotencyKey, contentHash, tag, inReplyToInboxId: input.inReplyToInboxId ?? null,
          expiresAt: new Date(Date.now() + minutes * 60_000),
        },
        select: { id: true },
      });
      for (const recipient of recipients) {
        const domain = domainOfAddress(recipient);
        const status = suppressed.has(recipient) ? 'SUPPRESSED' : 'QUEUED';
        const delivery = await tx.mailDelivery.create({
          data: { messageId: created.id, recipient, domain, provider: providerForDomain(domain) ?? 'other', status },
          select: { id: true },
        });
        await tx.mailEvent.create({ data: { messageId: created.id, deliveryId: delivery.id, type: status === 'SUPPRESSED' ? 'suppressed' : 'queued', detail: { recipient } } });
      }
      return created;
    });
    if ('repeat' in message) {
      return { id: message.repeat.id, messageId: message.repeat.messageIdHeader, duplicate: true, deliveries: message.repeat.deliveries };
    }
    outboxSignal.emit('queued', priority);
    return {
      id: message.id,
      messageId: messageIdHeader,
      duplicate: false,
      deliveries: recipients.map((recipient) => ({ recipient, status: suppressed.has(recipient) ? 'SUPPRESSED' : 'QUEUED' })),
    };
  } catch (error) {
    // Two calls with the same key at once: the second loses the race and answers like the first.
    if (idempotencyKey && (error as { code?: string })?.code === 'P2002') {
      const existing = await findByKey(idempotencyKey);
      if (existing) return existing;
    }
    throw error;
  }
}

async function findByKey(idempotencyKey: string): Promise<Queued | null> {
  const found = await prisma.mailMessage.findUnique({
    where: { idempotencyKey },
    select: { id: true, messageIdHeader: true, deliveries: { select: { recipient: true, status: true } } },
  });
  return found ? { id: found.id, messageId: found.messageIdHeader, duplicate: true, deliveries: found.deliveries } : null;
}
