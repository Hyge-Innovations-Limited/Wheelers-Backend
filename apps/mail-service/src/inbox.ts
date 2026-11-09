import { prisma } from '@wheleers/db';
import { normaliseAddress } from './address';
import type { MailConfig } from './config';
import { enqueue, SendError, type Queued } from './outbox';

type Kind = 'MESSAGE' | 'BOUNCE' | 'COMPLAINT' | 'DMARC_REPORT';
const KINDS: Kind[] = ['MESSAGE', 'BOUNCE', 'COMPLAINT', 'DMARC_REPORT'];

const listFields = {
  id: true, mailbox: true, kind: true, fromAddress: true, fromName: true, toAddresses: true, subject: true,
  snippet: true, threadId: true, suspicious: true, sizeBytes: true, readAt: true, archivedAt: true, receivedAt: true,
  _count: { select: { attachments: true } },
} as const;

export const inbox = {
  /** Newest first, a page at a time (`before` is the last receivedAt seen). Deleted mail never; archived only when asked. */
  async list(q: { mailbox?: string | null; kind?: string | null; unread?: boolean; archived?: boolean; search?: string | null; limit?: number; before?: string | null }) {
    const kind = q.kind && KINDS.includes(q.kind as Kind) ? (q.kind as Kind) : 'MESSAGE';
    const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
    const before = q.before ? new Date(q.before) : null;
    const search = q.search?.trim().slice(0, 100);
    const rows = await prisma.mailInboxMessage.findMany({
      where: {
        kind,
        deletedAt: null,
        archivedAt: q.archived ? { not: null } : null,
        ...(q.mailbox ? { mailbox: q.mailbox.toLowerCase() } : {}),
        ...(q.unread ? { readAt: null } : {}),
        ...(before && !Number.isNaN(before.getTime()) ? { receivedAt: { lt: before } } : {}),
        ...(search ? { OR: [{ subject: { contains: search, mode: 'insensitive' } }, { fromAddress: { contains: search, mode: 'insensitive' } }, { fromName: { contains: search, mode: 'insensitive' } }, { text: { contains: search, mode: 'insensitive' } }] } : {}),
      },
      orderBy: { receivedAt: 'desc' },
      take: limit,
      select: listFields,
    });
    const unread = await prisma.mailInboxMessage.groupBy({ by: ['mailbox'], where: { kind: 'MESSAGE', deletedAt: null, archivedAt: null, readAt: null }, _count: true });
    return {
      messages: rows.map(({ _count, ...m }) => ({ ...m, attachments: _count.attachments })),
      next: rows.length === limit ? rows[rows.length - 1]!.receivedAt.toISOString() : null,
      unreadByMailbox: Object.fromEntries(unread.map((u) => [u.mailbox, u._count])),
    };
  },

  /** One message, its attachments (without their content) and the rest of its conversation, both ways. */
  async get(id: string) {
    const message = await prisma.mailInboxMessage.findFirst({
      where: { id, deletedAt: null },
      include: { attachments: { select: { id: true, filename: true, contentType: true, sizeBytes: true, contentId: true } } },
    });
    if (!message) return null;
    const [received, sent] = await Promise.all([
      prisma.mailInboxMessage.findMany({ where: { threadId: message.threadId, deletedAt: null, id: { not: id } }, select: { id: true, fromAddress: true, fromName: true, subject: true, snippet: true, receivedAt: true }, orderBy: { receivedAt: 'asc' } }),
      prisma.mailMessage.findMany({
        where: { inReplyToInboxId: { in: [id, ...(await prisma.mailInboxMessage.findMany({ where: { threadId: message.threadId }, select: { id: true } })).map((m) => m.id)] } },
        select: { id: true, fromAddress: true, subject: true, createdAt: true, deliveries: { select: { recipient: true, status: true } } },
        orderBy: { createdAt: 'asc' },
      }),
    ]);
    return { message, thread: { received, sent } };
  },

  raw: (id: string) => prisma.mailInboxRaw.findUnique({ where: { inboxMessageId: id } }),

  attachment: (id: string, attachmentId: string) => prisma.mailAttachment.findFirst({ where: { id: attachmentId, inboxMessageId: id } }),

  async mark(id: string, change: { read?: boolean; archived?: boolean }) {
    const data: { readAt?: Date | null; archivedAt?: Date | null } = {};
    if (typeof change.read === 'boolean') data.readAt = change.read ? new Date() : null;
    if (typeof change.archived === 'boolean') data.archivedAt = change.archived ? new Date() : null;
    const done = await prisma.mailInboxMessage.updateMany({ where: { id, deletedAt: null }, data });
    return done.count > 0;
  },

  /** To the bin: gone from every list now, removed for good after 30 days. */
  async remove(id: string) {
    const done = await prisma.mailInboxMessage.updateMany({ where: { id, deletedAt: null }, data: { deletedAt: new Date() } });
    return done.count > 0;
  },

  /**
   * Answers a message from the mailbox it came to: to its sender (Reply-To
   * first), "Re:" its subject, threaded (In-Reply-To, References), so their
   * mail app shows one conversation. Signed and sent like any of our mail.
   */
  async reply(config: MailConfig, id: string, input: { text?: string; html?: string; cc?: string | string[]; all?: boolean; idempotencyKey?: string }): Promise<Queued> {
    const message = await prisma.mailInboxMessage.findFirst({ where: { id, deletedAt: null, kind: 'MESSAGE' }, include: { raw: true } });
    if (!message) throw new SendError('That message is not in the inbox', 'NOT_FOUND');
    const replyTo = /^reply-to:\s*(.+)$/im.exec((message.raw?.raw.toString('utf8') ?? '').split(/\r?\n\r?\n/)[0]?.replace(/\r?\n[ \t]+/g, ' ') ?? '')?.[1];
    const to = (replyTo ? normaliseAddress(/<([^>]+)>/.exec(replyTo)?.[1] ?? replyTo) : null) ?? message.fromAddress;
    if (!to) throw new SendError('That message has no sender to answer');
    const mailboxDomain = message.mailbox.slice(message.mailbox.lastIndexOf('@') + 1);
    if (mailboxDomain !== config.domain && !mailboxDomain.endsWith(`.${config.domain}`)) {
      throw new SendError(`${message.mailbox} is not on ${config.domain}: we cannot sign a reply from it`, 'FROM_NOT_OURS');
    }
    const others = input.all ? [...message.toAddresses, ...message.ccAddresses].filter((a) => a !== message.mailbox && a !== to) : [];
    const cc = [...(Array.isArray(input.cc) ? input.cc : input.cc ? [input.cc] : []), ...others];
    const subject = /^re:/i.test(message.subject) ? message.subject : `Re: ${message.subject}`;
    const references = [...message.references, ...(message.messageIdHeader ? [message.messageIdHeader] : [])];
    const sent = await enqueue(config, {
      from: message.mailbox,
      to,
      ...(cc.length ? { cc } : {}),
      subject,
      ...(input.text !== undefined ? { text: input.text } : {}),
      ...(input.html !== undefined ? { html: input.html } : {}),
      ...(message.messageIdHeader ? { inReplyTo: message.messageIdHeader } : {}),
      references,
      inReplyToInboxId: message.id,
      tag: 'inbox_reply',
      // Without a key, the same reply pressed twice is still one email (the 10-minute repeat check).
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    });
    await prisma.mailInboxMessage.update({ where: { id }, data: { readAt: message.readAt ?? new Date() } });
    return sent;
  },
};
