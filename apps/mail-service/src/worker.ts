import { prisma } from '@wheleers/db';
import type { Prisma } from '@wheleers/db';
import type { MailConfig } from './config';
import { outboxSignal, suppressionStreams } from './outbox';
import { isRateLimit } from './providers';
import { createRouter, type Router } from './route';
import { attemptDelivery, enhancedCode, type Attempt, type AttemptInput } from './smtp-client';

type Claimed = { id: string; messageId: string; recipient: string; domain: string; provider: string; attempts: number };

export type WorkerDeps = {
  router?: Pick<Router, 'route'>;
  attempt?: (input: AttemptInput) => Promise<Attempt>;
  now?: () => Date;
};

/** Waits between tries. Urgent (a code) in seconds; the rest in minutes to hours, until the email expires. */
const NORMAL_BACKOFF_MIN = [5, 15, 30, 60, 120, 240, 480, 720];
const URGENT_BACKOFF_SEC = [30, 60, 120, 240, 300];
/** How long a provider that said "slow down" gets left alone. */
const PAUSE_MINUTES = 30;
/** How long one delivery may take before another worker may take it over: past the longest try (a 10-minute wait for the final answer, after DELIVERY_BUDGET_MS). */
const LEASE_MINUTES = 30;
/** No more servers are tried after this long on one delivery; it is tried again later. */
const DELIVERY_BUDGET_MS = 5 * 60_000;
const TICK_MS = 2_000;

/** An address that does not exist: never send to it again (other 5xx are about us or the message, not the address). */
export function isHardBounce(code: number, enhanced: string | null, text: string): boolean {
  if (enhanced && /^5\.(1\.(1|2|3|6|10)|2\.1)$/.test(enhanced)) return true;
  return code >= 550 && code <= 553 && /(user|mailbox|recipient|address)\s*(unknown|not found|does not exist|doesn'?t exist|unavailable|disabled|invalid)|no such (user|mailbox|recipient)|invalid recipient|unknown recipient/i.test(text);
}

export function nextTryAfter(attempts: number, priority: 'URGENT' | 'NORMAL'): number {
  if (priority === 'URGENT') return URGENT_BACKOFF_SEC[Math.min(attempts - 1, URGENT_BACKOFF_SEC.length - 1)]! * 1000;
  return NORMAL_BACKOFF_MIN[Math.min(attempts - 1, NORMAL_BACKOFF_MIN.length - 1)]! * 60_000;
}

/** Now in UTC, the way Prisma stores times (timestamp without time zone). */
const utcNow = "timezone('UTC', now())";

/**
 * The sending side. Each round: deliveries a worker died holding are let go;
 * due ones are taken (urgent first; never two workers on one, by SKIP
 * LOCKED; never one for a paused provider); each is checked again (expired?
 * suppressed since?), routed by MX, held back if its provider has had its
 * hour's share, and tried on each server in turn until one answers. Then:
 * delivered; refused for good (bounced, and suppressed when the address does
 * not exist); refused for now or unreachable (tried again later, the provider
 * paused if it said too fast).
 */
export function createWorker(config: MailConfig, deps: WorkerDeps = {}) {
  const router = deps.router ?? createRouter(config);
  const attempt = deps.attempt ?? attemptDelivery;
  const now = deps.now ?? (() => new Date());
  const inFlight = new Map<string, number>();
  let running = false;
  let timer: NodeJS.Timeout | null = null;
  let round: Promise<void> | null = null;
  let lastRoundAt: Date | null = null;
  let lastCleanupAt = 0;

  async function event(messageId: string, deliveryId: string, type: string, detail: Record<string, unknown>) {
    await prisma.mailEvent.create({ data: { messageId, deliveryId, type, detail: detail as Prisma.InputJsonValue } }).catch(() => undefined);
  }

  async function sentToProviderThisHour(provider: string): Promise<number> {
    return prisma.mailDelivery.count({ where: { provider, lastAttemptAt: { gt: new Date(now().getTime() - 3_600_000) } } });
  }

  async function settle(d: Claimed, data: Record<string, unknown>) {
    await prisma.mailDelivery.update({ where: { id: d.id }, data: { ...data, leaseUntil: null } });
  }

  async function deliver(d: Claimed): Promise<void> {
    const message = await prisma.mailMessage.findUnique({ where: { id: d.messageId }, select: { raw: true, expiresAt: true, priority: true, stream: true } });
    if (!message) return;

    if (message.expiresAt <= now()) {
      await settle(d, { status: 'EXPIRED' });
      return event(d.messageId, d.id, 'expired', { recipient: d.recipient, attempts: d.attempts - 1 });
    }
    // Put on the list since it was queued (it bounced from another email meanwhile).
    const blocked = await prisma.mailSuppression.findFirst({ where: { address: d.recipient, stream: { in: suppressionStreams(message.stream) } } });
    if (blocked) {
      await settle(d, { status: 'SUPPRESSED' });
      return event(d.messageId, d.id, 'suppressed', { recipient: d.recipient, reason: blocked.reason });
    }

    type Why = { code?: number; enhanced?: string | null; response?: string; reason?: string; mx?: string; paused?: string };
    /** Not now: tried again in `ms`. `counts` false when it was held back by us (pacing, a pause), not refused. */
    const later = async (ms: number, why: Why, counts = true) => {
      await settle(d, {
        status: 'DEFERRED',
        nextAttemptAt: new Date(now().getTime() + ms),
        ...(counts ? {} : { attempts: { decrement: 1 } }),
        ...(why.code !== undefined
          ? { lastCode: why.code, lastEnhanced: why.enhanced ?? null, lastResponse: why.response ?? null }
          : why.reason ? { lastCode: null, lastEnhanced: null, lastResponse: why.reason.slice(0, 500) } : {}),
      });
      await event(d.messageId, d.id, counts ? 'deferred' : 'held', { recipient: d.recipient, ...why, retryInSeconds: Math.round(ms / 1000) });
    };

    const route = await router.route(d.domain);
    if (!route.ok) {
      if (route.permanent) {
        await settle(d, { status: 'BOUNCED', lastCode: null, lastEnhanced: '5.1.2', lastResponse: route.reason });
        await suppress(d.recipient, 'HARD_BOUNCE', route.reason);
        return event(d.messageId, d.id, 'bounced', { recipient: d.recipient, reason: route.reason, hard: true });
      }
      return later(nextTryAfter(d.attempts, message.priority), { reason: route.reason });
    }

    const provider = route.provider;
    if (provider !== d.provider) await prisma.mailDelivery.update({ where: { id: d.id }, data: { provider } });
    const pause = await prisma.mailProviderPause.findUnique({ where: { provider } });
    if (pause && pause.until > now()) return later(pause.until.getTime() - now().getTime(), { reason: `${provider} asked us to slow down` }, false);
    // Its share for the hour is used up (the warm-up limits): held, not counted as a try.
    const limit = config.limitsPerHour[provider] ?? config.limitsPerHour.other ?? 500;
    if ((await sentToProviderThisHour(provider)) + (inFlight.get(provider) ?? 0) >= limit) {
      return later(10 * 60_000, { reason: `${provider}: ${limit} an hour reached` }, false);
    }

    inFlight.set(provider, (inFlight.get(provider) ?? 0) + 1);
    let result: Attempt = { kind: 'unreachable', reason: 'no server tried' };
    let usedHost = '';
    try {
      await prisma.mailDelivery.update({ where: { id: d.id }, data: { lastAttemptAt: now(), bodySentAt: null } });
      let bodyMarked: Promise<unknown> = Promise.resolve();
      const startedAt = Date.now();
      // Each server in turn, each of its addresses, until one answers (yes or no).
      outer: for (const host of route.hosts) {
        for (const ip of host.ips) {
          if (Date.now() - startedAt > DELIVERY_BUDGET_MS) break outer;
          usedHost = host.name;
          result = await attempt({
            ip, hostName: host.name, port: host.port, helo: config.hostname, localAddress: config.outboundIp,
            envelopeFrom: bounceAddress(d.id, config.bounceDomain), recipient: d.recipient, raw: message.raw,
            // Kept at once: if this process dies before the answer, the email is not sent a second time.
            onBodySent: () => { bodyMarked = prisma.mailDelivery.update({ where: { id: d.id }, data: { bodySentAt: new Date() } }).catch(() => undefined); },
          });
          await bodyMarked;
          if (result.kind !== 'unreachable') break outer;
        }
      }
    } finally {
      inFlight.set(provider, Math.max(0, (inFlight.get(provider) ?? 1) - 1));
    }

    if (result.kind === 'delivered') {
      await settle(d, { status: 'DELIVERED', deliveredAt: now(), lastCode: result.code, lastEnhanced: enhancedCode(result.response), lastResponse: result.response, mxHost: usedHost });
      return event(d.messageId, d.id, 'delivered', { recipient: d.recipient, mx: usedHost, response: result.response, tls: result.tls, attempt: d.attempts });
    }
    if (result.kind === 'unconfirmed') {
      await settle(d, { status: 'UNCONFIRMED', lastCode: null, lastEnhanced: null, lastResponse: result.reason.slice(0, 500), mxHost: usedHost });
      return event(d.messageId, d.id, 'unconfirmed', { recipient: d.recipient, mx: usedHost, reason: result.reason, resent: false });
    }
    if (result.kind === 'refused' && result.permanent) {
      const hard = isHardBounce(result.code, result.enhanced, result.response);
      await settle(d, { status: 'BOUNCED', lastCode: result.code, lastEnhanced: result.enhanced, lastResponse: result.response, mxHost: usedHost });
      if (hard) await suppress(d.recipient, 'HARD_BOUNCE', `${result.code} ${result.response}`);
      // Not about the address (5.7.x: blocked, spam, policy): it is about us. Counted apart, for the reputation page.
      return event(d.messageId, d.id, hard ? 'bounced' : 'blocked', { recipient: d.recipient, mx: usedHost, code: result.code, enhanced: result.enhanced, response: result.response, hard });
    }
    if (result.kind === 'refused' && isRateLimit(result.code, result.response)) {
      await prisma.mailProviderPause.upsert({
        where: { provider },
        create: { provider, until: new Date(now().getTime() + PAUSE_MINUTES * 60_000), reason: result.response.slice(0, 300) },
        update: { until: new Date(now().getTime() + PAUSE_MINUTES * 60_000), reason: result.response.slice(0, 300) },
      });
      return later(PAUSE_MINUTES * 60_000, { mx: usedHost, code: result.code, enhanced: result.enhanced, response: result.response, paused: provider });
    }
    const wait = nextTryAfter(d.attempts, message.priority);
    if (result.kind === 'refused') return later(wait, { mx: usedHost, code: result.code, enhanced: result.enhanced, response: result.response });
    return later(wait, { reason: result.reason });
  }

  async function suppress(address: string, reason: 'HARD_BOUNCE', detail: string) {
    await prisma.mailSuppression.upsert({
      where: { address_stream: { address, stream: 'ALL' } },
      create: { address, stream: 'ALL', reason, detail: detail.slice(0, 500) },
      update: {},
    });
  }

  /**
   * Taken by a worker that is gone (crashed, restarted). If the message had not gone out yet,
   * it goes back in the queue. If it had (bodySentAt), it most likely arrived: UNCONFIRMED,
   * never sent a second time.
   */
  async function releaseStale() {
    await prisma.$executeRawUnsafe(`
      UPDATE "MailDelivery" SET status = 'UNCONFIRMED', "leaseUntil" = NULL, "lastResponse" = 'the worker stopped after the message went out, before the answer', "updatedAt" = ${utcNow}
      WHERE status = 'SENDING' AND "leaseUntil" < ${utcNow} AND "bodySentAt" IS NOT NULL`);
    await prisma.$executeRawUnsafe(`
      UPDATE "MailDelivery" SET status = 'DEFERRED', "leaseUntil" = NULL, "nextAttemptAt" = ${utcNow}, "updatedAt" = ${utcNow}
      WHERE status = 'SENDING' AND "leaseUntil" < ${utcNow} AND "bodySentAt" IS NULL`);
  }

  async function claim(limit: number): Promise<Claimed[]> {
    return prisma.$queryRawUnsafe<Claimed[]>(`
      WITH due AS (
        SELECT d.id FROM "MailDelivery" d
        JOIN "MailMessage" m ON m.id = d."messageId"
        WHERE d.status IN ('QUEUED', 'DEFERRED') AND d."nextAttemptAt" <= ${utcNow}
          AND NOT EXISTS (SELECT 1 FROM "MailProviderPause" p WHERE p.provider = d.provider AND p.until > ${utcNow})
        ORDER BY m.priority, d."nextAttemptAt"
        LIMIT $1
        FOR UPDATE OF d SKIP LOCKED
      )
      UPDATE "MailDelivery" d
      SET status = 'SENDING', "leaseUntil" = ${utcNow} + interval '${LEASE_MINUTES} minutes', attempts = d.attempts + 1, "updatedAt" = ${utcNow}
      FROM due WHERE d.id = due.id
      RETURNING d.id, d."messageId", d.recipient, d.domain, d.provider, d.attempts`, limit);
  }

  /** Sent mail older than MAIL_KEEP_DAYS goes (its deliveries and events with it); the inbox's deleted mail after 30 days. Hourly. */
  async function cleanup() {
    if (Date.now() - lastCleanupAt < 3_600_000) return;
    lastCleanupAt = Date.now();
    const before = new Date(Date.now() - config.keepDays * 86_400_000);
    await prisma.mailMessage.deleteMany({ where: { createdAt: { lt: before } } });
    await prisma.mailInboxMessage.deleteMany({ where: { deletedAt: { lt: new Date(Date.now() - 30 * 86_400_000) } } });
    await prisma.mailProviderPause.deleteMany({ where: { until: { lt: new Date() } } });
  }

  /** One round: everything due now, at most `workerConcurrency` at a time. */
  async function runOnce(): Promise<number> {
    await releaseStale();
    let done = 0;
    for (;;) {
      const batch = await claim(config.workerConcurrency);
      if (batch.length === 0) break;
      await Promise.all(batch.map((d) => deliver(d).catch(async (error) => {
        console.error('[mail] delivery failed unexpectedly', { deliveryId: d.id, error: error instanceof Error ? error.message : String(error) });
        // Not sent yet: try again in a minute. Already sent (the failure came after, saving the
        // answer): never again. If even this fails, the lease runs out and releaseStale decides the same way.
        await prisma.mailDelivery.updateMany({ where: { id: d.id, status: 'SENDING', bodySentAt: null }, data: { status: 'DEFERRED', leaseUntil: null, nextAttemptAt: new Date(Date.now() + 60_000) } }).catch(() => undefined);
        await prisma.mailDelivery.updateMany({ where: { id: d.id, status: 'SENDING', bodySentAt: { not: null } }, data: { status: 'UNCONFIRMED', leaseUntil: null } }).catch(() => undefined);
      })));
      done += batch.length;
    }
    lastRoundAt = new Date();
    await cleanup().catch((error) => console.warn('[mail] cleanup failed', { error: error instanceof Error ? error.message : String(error) }));
    return done;
  }

  function schedule(ms: number) {
    if (!running) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (round) return schedule(TICK_MS);
      round = runOnce()
        .catch((error) => console.error('[mail] worker round failed', { error: error instanceof Error ? error.message : String(error) }))
        .then(() => undefined)
        .finally(() => {
          round = null;
          schedule(TICK_MS);
        });
    }, ms);
  }

  const onQueued = () => { if (!round) schedule(0); };

  return {
    runOnce,
    start() {
      if (running) return;
      running = true;
      outboxSignal.on('queued', onQueued);
      schedule(0);
    },
    /** Lets the round in progress finish (its emails would otherwise wait for the lease). */
    async stop() {
      running = false;
      outboxSignal.off('queued', onQueued);
      if (timer) clearTimeout(timer);
      timer = null;
      await round;
    },
    status: () => ({ running, lastRoundAt, inFlight: Object.fromEntries(inFlight) }),
  };
}

/** The envelope sender for one delivery (VERP): a bounce sent to it says exactly which delivery failed. */
export function bounceAddress(deliveryId: string, bounceDomain: string): string {
  return `b+${deliveryId.replace(/-/g, '')}@${bounceDomain}`;
}

/** The delivery a bounce address names, or null. */
export function deliveryFromBounceAddress(address: string, bounceDomain: string): string | null {
  const m = /^b\+([0-9a-f]{32})@(.+)$/i.exec(address);
  if (!m || m[2]!.toLowerCase() !== bounceDomain) return null;
  const h = m[1]!.toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
