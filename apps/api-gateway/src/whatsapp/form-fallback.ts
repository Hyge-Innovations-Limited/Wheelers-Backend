import { userDeviceClient } from '@wheleers/db';
import type { RedisClient } from '../redis/client';
import { verifyFlowToken } from '../whatsapp-flows/encryption';
import { sendInteractive } from './send';
import { ridePageUrl } from './trip';
import type { MetaWhatsappRouteDeps } from '../http/whatsapp.route';

/**
 * A WhatsApp form (Flow) does not open on WhatsApp Desktop, WhatsApp Web or a linked second device: the person
 * sees "open on your phone". We cannot see the device, so:
 *   a form is sent → noted (the outgoing-message hook, every sender);
 *   WhatsApp says it was read (or, with read receipts off, delivered) → a check 40 s (90 s) later;
 *   still not opened and they have not written since → one message with a link to the same step on our web page;
 *   twice for one person → their profile says forms do not open, and from then on the link follows each form at once.
 * Opening a form (the form's first call to us) or writing in the chat cancels the check. The welcome form has no
 * web page of its own: its unopened sends only count (consent.ts already falls back to the text question).
 */

const pendingKey = (userId: string) => `whatsapp:form-pending:${userId}`;
const unopenedKey = (userId: string) => `whatsapp:forms-unopened:${userId}`;
const closedKey = (userId: string) => `whatsapp:forms-closed:${userId}`;
export const FORM_CHECKS_KEY = 'whatsapp:form-checks';
export const READ_WAIT_MS = 40_000;
export const DELIVERED_WAIT_MS = 90_000;
const PENDING_TTL_SECONDS = 3600;
const UNOPENED_TTL_SECONDS = 30 * 24 * 3600;
export const FOLLOW_UP_TEXT = "Can't open it here? Continue on your phone, or tap below.";

type Pending = { sentAt: number; kind: string; phone: string; checkFrom?: 'read' | 'delivered' };
type LinkDeps = Pick<MetaWhatsappRouteDeps, 'metaAccessToken' | 'metaPhoneNumberId' | 'appBaseUrl' | 'jwtSecret'>;

async function getJson<T>(redis: RedisClient, key: string): Promise<T | null> {
  const raw = await redis.get(key).catch(() => null);
  if (!raw) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
}

/** A sent message's body (Meta's /messages JSON): the form's person (from its signed token), phone and kind. */
export function formInMessage(rawBody: string, secret: string): { userId: string; phone: string; kind: string } | null {
  let body: Record<string, unknown>;
  try { body = JSON.parse(rawBody) as Record<string, unknown>; } catch { return null; }
  const interactive = body.interactive as Record<string, unknown> | undefined;
  if (body.type !== 'interactive' || interactive?.type !== 'flow') return null;
  const params = (interactive.action as Record<string, unknown> | undefined)?.parameters as Record<string, unknown> | undefined;
  const token = typeof params?.flow_token === 'string' ? params.flow_token : null;
  const payload = token ? verifyFlowToken(token, secret) : null;
  if (!payload) return null;
  const parts = payload.split(':');
  const uuid = (x: string | undefined) => Boolean(x && /^[0-9a-f-]{36}$/i.test(x));
  // "<userId>" (the ride-search form), "<kind>:<userId>" (welcome, menu, edit…) or "<rideId>:<userId>" (offers, bids).
  if (parts.length === 1) return uuid(parts[0]) ? { userId: parts[0]!, phone: String(body.to ?? ''), kind: 'search' } : null;
  const userId = parts[1];
  if (!uuid(userId)) return null;
  const kind = uuid(parts[0]) ? 'offers' : parts[0]!;
  return { userId, phone: String(body.to ?? ''), kind };
}

export async function noteFormSent(redis: RedisClient, form: { userId: string; phone: string; kind: string }, now = Date.now()): Promise<void> {
  const pending: Pending = { sentAt: now, kind: form.kind, phone: form.phone };
  await redis.set(pendingKey(form.userId), JSON.stringify(pending), PENDING_TTL_SECONDS);
  // Known not to open forms: the link right away (a few seconds, so it lands after the form).
  if ((await redis.get(closedKey(form.userId)).catch(() => null)) === '1') {
    await redis.send('ZADD', FORM_CHECKS_KEY, String(now + 3000), form.userId);
  }
}

/** The form's first call to our endpoint: it opened, so this person's WhatsApp shows forms. */
export async function noteFormOpened(redis: RedisClient, userId: string): Promise<void> {
  await redis.del(pendingKey(userId)).catch(() => undefined);
  await redis.send('ZREM', FORM_CHECKS_KEY, userId).catch(() => undefined);
  await redis.del(unopenedKey(userId)).catch(() => undefined);
  const wasClosed = (await redis.get(closedKey(userId)).catch(() => null)) === '1';
  await redis.del(closedKey(userId)).catch(() => undefined);
  const known = await redis.setIfNotExists(`whatsapp:forms-open-noted:${userId}`, '1', 24 * 3600).catch(() => false);
  if (known || wasClosed) await userDeviceClient.record(userId, { source: 'whatsapp', formsOpen: true }).catch(() => undefined);
}

/** They wrote in the chat: whatever they are doing, no link now. */
export async function noteUserWrote(redis: RedisClient, userId: string): Promise<void> {
  if (!(await redis.get(pendingKey(userId)).catch(() => null))) return;
  await redis.del(pendingKey(userId)).catch(() => undefined);
  await redis.send('ZREM', FORM_CHECKS_KEY, userId).catch(() => undefined);
}

/** WhatsApp's read / delivered news for a message to this person: the check starts from it. */
export async function noteStatus(redis: RedisClient, userId: string, status: 'read' | 'delivered', at: number): Promise<void> {
  const pending = await getJson<Pending>(redis, pendingKey(userId));
  if (!pending || at < pending.sentAt - 5000) return;
  if (status === 'delivered' && pending.checkFrom) return;
  if (status === 'read' && pending.checkFrom === 'read') return;
  const due = at + (status === 'read' ? READ_WAIT_MS : DELIVERED_WAIT_MS);
  await redis.send('ZADD', FORM_CHECKS_KEY, String(due), userId);
  await redis.set(pendingKey(userId), JSON.stringify({ ...pending, checkFrom: status }), PENDING_TTL_SECONDS);
}

/** The link message: the same step on our web page. */
export async function sendFormLink(deps: LinkDeps, userId: string, phone: string): Promise<boolean> {
  const url = ridePageUrl(deps as MetaWhatsappRouteDeps, userId);
  if (!url) return false;
  return sendInteractive(deps as MetaWhatsappRouteDeps, phone, {
    type: 'cta_url',
    body: { text: FOLLOW_UP_TEXT },
    action: { name: 'cta_url', parameters: { display_text: 'Open in browser', url } },
  });
}

/** Due checks: each claimed by ZREM (one process sends), then the link when the form is still unopened. */
export async function sweepFormChecks(
  redis: RedisClient,
  sendLink: (userId: string, phone: string) => Promise<boolean>,
  now = Date.now(),
): Promise<Array<{ userId: string; sent: boolean; closed: boolean }>> {
  const due = await redis.send('ZRANGEBYSCORE', FORM_CHECKS_KEY, '-inf', String(now), 'LIMIT', '0', '50').catch(() => null);
  const out: Array<{ userId: string; sent: boolean; closed: boolean }> = [];
  if (!Array.isArray(due)) return out;
  for (const item of due) {
    const userId = String(item);
    const claimed = await redis.send('ZREM', FORM_CHECKS_KEY, userId).catch(() => 0);
    if (Number(claimed) !== 1) continue;
    const pending = await getJson<Pending>(redis, pendingKey(userId));
    if (!pending) continue;
    await redis.del(pendingKey(userId)).catch(() => undefined);
    const sent = pending.kind === 'welcome' || !pending.phone ? false : await sendLink(userId, pending.phone).catch(() => false);
    const unopened = Number(await redis.send('INCR', unopenedKey(userId)).catch(() => 0)) || 0;
    await redis.send('EXPIRE', unopenedKey(userId), String(UNOPENED_TTL_SECONDS)).catch(() => undefined);
    const closed = unopened >= 2;
    if (closed && (await redis.setIfNotExists(closedKey(userId), '1', UNOPENED_TTL_SECONDS).catch(() => false))) {
      await userDeviceClient.record(userId, { source: 'whatsapp', formsOpen: false }).catch(() => undefined);
    }
    out.push({ userId, sent, closed });
  }
  return out;
}
