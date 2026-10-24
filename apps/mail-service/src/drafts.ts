import { prisma } from '@wheleers/db';
import { AddressError, parseMailboxes } from './address';
import type { MailConfig } from './config';
import { enqueue, SendError, type Queued } from './outbox';

/**
 * Drafts in the inbox, written to never send the wrong thing:
 *
 *  - Nothing sends by itself. A draft goes out only when someone presses
 *    send; an expired login, a closed tab or a restart leaves it a draft.
 *  - Every save names the version it was made from. A save from an older
 *    copy (a second tab, an autosave that arrives late) is refused with the
 *    newer draft, never written over it.
 *  - Send names the version the person was looking at: if it changed since,
 *    nothing is sent and they see the newer one first.
 *  - Send happens once. The email's key is the draft and its version, so a
 *    send pressed twice, or retried after a timeout, is the same email; a
 *    draft already sent cannot be changed or sent again.
 */

export class DraftError extends SendError {
  constructor(message: string, code: string, readonly draft?: unknown) {
    super(message, code);
  }
}

type DraftFields = { to?: unknown; cc?: unknown; subject?: unknown; text?: unknown; html?: unknown };

function fields(input: DraftFields) {
  try {
    const out: { toAddresses?: string[]; ccAddresses?: string[]; subject?: string; text?: string | null; html?: string | null } = {};
    // A draft may be half written: addresses are checked as they are typed in, the rest when it is sent.
    if (input.to !== undefined) out.toAddresses = parseMailboxes(input.to, 'to').map((m) => m.address);
    if (input.cc !== undefined) out.ccAddresses = parseMailboxes(input.cc, 'cc').map((m) => m.address);
    if (input.subject !== undefined) out.subject = String(input.subject).replace(/\s+/g, ' ').slice(0, 998);
    if (input.text !== undefined) out.text = input.text === null ? null : String(input.text).slice(0, 2_000_000);
    if (input.html !== undefined) out.html = input.html === null ? null : String(input.html).slice(0, 5_000_000);
    return out;
  } catch (error) {
    if (error instanceof AddressError) throw new DraftError(error.message, 'BAD_REQUEST');
    throw error;
  }
}

async function current(id: string) {
  return prisma.mailDraft.findUnique({ where: { id } });
}

export const drafts = {
  async create(config: MailConfig, input: DraftFields & { mailbox?: unknown; inReplyToInboxId?: unknown }) {
    const mailbox = String(input.mailbox ?? '').trim().toLowerCase();
    if (!(await prisma.mailMailbox.findUnique({ where: { address: mailbox } }))) throw new DraftError(`${mailbox || 'mailbox'} is not one of our mailboxes`, 'BAD_REQUEST');
    const domain = mailbox.slice(mailbox.lastIndexOf('@') + 1);
    if (domain !== config.domain && !domain.endsWith(`.${config.domain}`)) throw new DraftError(`${mailbox} is not on ${config.domain}: we cannot sign mail from it`, 'FROM_NOT_OURS');
    let inReplyToInboxId: string | null = null;
    let subject = '';
    let to: string[] = [];
    if (typeof input.inReplyToInboxId === 'string') {
      const answered = await prisma.mailInboxMessage.findFirst({ where: { id: input.inReplyToInboxId, deletedAt: null, kind: 'MESSAGE' } });
      if (!answered) throw new DraftError('That message is not in the inbox', 'NOT_FOUND');
      inReplyToInboxId = answered.id;
      subject = /^re:/i.test(answered.subject) ? answered.subject : `Re: ${answered.subject}`;
      to = answered.fromAddress ? [answered.fromAddress] : [];
    }
    return prisma.mailDraft.create({
      data: { mailbox, inReplyToInboxId, subject, toAddresses: to, ccAddresses: [], ...fields(input) },
    });
  },

  list: (mailbox?: string | null) =>
    prisma.mailDraft.findMany({ where: { sentAt: null, ...(mailbox ? { mailbox: mailbox.toLowerCase() } : {}) }, orderBy: { updatedAt: 'desc' }, take: 100 }),

  get: (id: string) => current(id),

  /** A save, made from `version`. Refused when the draft moved on since, or was sent. */
  async save(id: string, version: unknown, input: DraftFields) {
    if (!Number.isInteger(version)) throw new DraftError('version is needed: the version this save was made from', 'BAD_REQUEST');
    const changes = fields(input);
    const done = await prisma.mailDraft.updateMany({ where: { id, version: version as number, sentAt: null }, data: { ...changes, version: { increment: 1 } } });
    if (done.count === 1) return current(id);
    const now = await current(id);
    if (!now) throw new DraftError('No such draft', 'NOT_FOUND');
    if (now.sentAt) throw new DraftError('This draft was sent already: it cannot change', 'ALREADY_SENT', now);
    throw new DraftError('This draft was changed somewhere else: here is the newer one', 'STALE', now);
  },

  async remove(id: string) {
    const done = await prisma.mailDraft.deleteMany({ where: { id, sentAt: null } });
    if (done.count === 1) return true;
    const now = await current(id);
    if (now?.sentAt) throw new DraftError('This draft was sent already', 'ALREADY_SENT', now);
    return false;
  },

  /**
   * Sends `version` of the draft, once. The draft is claimed first (marked sent, for that
   * version only), so an autosave that arrives a moment later is refused and cannot change
   * what goes. The email's key is the draft and its version: pressed twice, retried after a
   * timeout, or the process dying after the claim, it is the one email.
   */
  async send(config: MailConfig, id: string, version: unknown): Promise<Queued> {
    if (!Number.isInteger(version)) throw new DraftError('version is needed: the version on the screen', 'BAD_REQUEST');
    const draft = await current(id);
    if (!draft) throw new DraftError('No such draft', 'NOT_FOUND');
    const idempotencyKey = `draft:${draft.id}:v${version}`;

    if (draft.sentAt) {
      const sent = await prisma.mailMessage.findUnique({ where: { idempotencyKey }, select: { id: true, messageIdHeader: true, deliveries: { select: { recipient: true, status: true } } } });
      // Sent: the same version again is a retry, and gets the same answer.
      if (sent) return { id: sent.id, messageId: sent.messageIdHeader, duplicate: true, deliveries: sent.deliveries };
      // Claimed but never queued (the process stopped in between): this same version finishes it below.
      if (draft.sentMessageId !== null || draft.version !== version) throw new DraftError('This draft was sent already', 'ALREADY_SENT', draft);
    } else {
      if (draft.version !== version) throw new DraftError('This draft was changed since: look at the newer one before sending', 'STALE', draft);
      if (draft.toAddresses.length === 0) throw new DraftError('Who is it to? Add a recipient', 'BAD_REQUEST');
      const claimed = await prisma.mailDraft.updateMany({ where: { id, version: version as number, sentAt: null }, data: { sentAt: new Date() } });
      if (claimed.count === 0) {
        const now = await current(id);
        // Pressed twice at once: the other press is queueing this very version; answer with its email.
        if (now?.sentAt && now.version === version) {
          for (let i = 0; i < 20; i++) {
            const sent = await prisma.mailMessage.findUnique({ where: { idempotencyKey }, select: { id: true, messageIdHeader: true, deliveries: { select: { recipient: true, status: true } } } });
            if (sent) return { id: sent.id, messageId: sent.messageIdHeader, duplicate: true, deliveries: sent.deliveries };
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        }
        throw new DraftError(now?.sentAt ? 'This draft was sent already' : 'This draft was changed since: look at the newer one before sending', now?.sentAt ? 'ALREADY_SENT' : 'STALE', now);
      }
    }

    let threading: { inReplyTo?: string; references?: string[] } = {};
    if (draft.inReplyToInboxId) {
      const answered = await prisma.mailInboxMessage.findUnique({ where: { id: draft.inReplyToInboxId }, select: { messageIdHeader: true, references: true } });
      if (answered?.messageIdHeader) threading = { inReplyTo: answered.messageIdHeader, references: [...answered.references, answered.messageIdHeader] };
    }
    let queued: Queued;
    try {
      queued = await enqueue(config, {
        from: draft.mailbox,
        to: draft.toAddresses,
        ...(draft.ccAddresses.length ? { cc: draft.ccAddresses } : {}),
        subject: draft.subject || '(no subject)',
        ...(draft.text ? { text: draft.text } : {}),
        ...(draft.html ? { html: draft.html } : {}),
        ...threading,
        ...(draft.inReplyToInboxId ? { inReplyToInboxId: draft.inReplyToInboxId } : {}),
        idempotencyKey,
        tag: draft.inReplyToInboxId ? 'inbox_reply' : 'inbox_compose',
      });
    } catch (error) {
      // Refused as written (no text, a bad address): it stays a draft, to fix and send again.
      if (error instanceof SendError) await prisma.mailDraft.updateMany({ where: { id, sentMessageId: null }, data: { sentAt: null } });
      throw error;
    }
    await prisma.mailDraft.update({ where: { id }, data: { sentMessageId: queued.id } });
    if (draft.inReplyToInboxId) await prisma.mailInboxMessage.updateMany({ where: { id: draft.inReplyToInboxId, readAt: null }, data: { readAt: new Date() } });
    return queued;
  },
};
