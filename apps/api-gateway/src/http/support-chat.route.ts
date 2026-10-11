import type { IncomingMessage, ServerResponse } from 'http';
import { randomUUID } from 'crypto';
import { supportClient } from '@wheleers/db';
import type { NotificationEvent } from '@wheleers/kafka-schemas';
import { clientIp, recordAdminActivity } from '../admin/activity';
import { getString, isRecord } from '../utils/object';
import { verifyAdminAuth } from './admin-auth.route';
import { authenticateHttpToken, HttpAuthError } from './authenticate';
import { readJsonBody, sendJson } from './utils';

/**
 * Chat with Wheelers support.
 *
 * For the person (rider or driver), signed in:
 *   GET  /support/chat             their conversation and its messages; opening it marks replies read
 *   POST /support/chat/messages    { content, rideId?, topic? }   send a message
 *
 * For the admin panel's support inbox:
 *   GET  /admin/support/conversations?status=open|resolved   the inbox, with how many are open and waiting
 *   GET  /admin/support/conversations?countsOnly=1           just those two numbers
 *   GET  /admin/support/conversations/:id                    one conversation, its messages and the trip it is about
 *   POST /admin/support/conversations/:id/messages  { content }   reply
 *   POST /admin/support/conversations/:id/assign                  take it
 *   POST /admin/support/conversations/:id/resolve                 close it
 *
 * A person has one open conversation at a time. A message with no ride named
 * is tied to the trip they are on, so support sees it without asking. A reply
 * reaches the person three ways: live on their socket (`support:message`), as
 * a push, and the next time the chat is opened.
 */
export interface SupportChatDeps {
  jwtSecret: string;
  adminApiKey: string;
  /** Live delivery to the person's open app. Absent in tests that do not need it. */
  sendToUser?: (userId: string, type: string, payload: Record<string, unknown>) => Promise<void>;
  publisher?: { publishNotificationEvent(event: NotificationEvent): Promise<void> };
}

export const SUPPORT_MESSAGE_MAX = 1000;
export const SUPPORT_MESSAGES_PER_MINUTE = 12;
const TOPIC_MAX = 80;

type Conversation = NonNullable<Awaited<ReturnType<typeof supportClient.currentFor>>>;
type Message = Awaited<ReturnType<typeof supportClient.messages>>[number];

const messageView = (message: Message) => ({
  id: message.id,
  from: message.sender === 'USER' ? 'you' : 'support',
  senderName: message.sender === 'SUPPORT' ? message.senderName ?? 'Support' : null,
  content: message.content,
  createdAt: message.createdAt.toISOString(),
});

const conversationView = (conversation: Conversation) => ({
  id: conversation.id,
  status: conversation.status === 'OPEN' ? 'open' : 'resolved',
  topic: conversation.topic,
  rideId: conversation.rideId,
  /** Who is answering, once someone has: "Ada". */
  agentName: conversation.assignedAdminName,
  createdAt: conversation.createdAt.toISOString(),
});

/** What the person typed, tidied: null when it is empty or too long. */
export function readSupportContent(value: unknown): { content: string } | { error: string; code: string } {
  const content = typeof value === 'string' ? value.replace(/\s+\n/g, '\n').trim() : '';
  if (!content) return { error: 'Type a message first.', code: 'EMPTY' };
  if (content.length > SUPPORT_MESSAGE_MAX) return { error: `Keep it under ${SUPPORT_MESSAGE_MAX} characters.`, code: 'TOO_LONG' };
  return { content };
}

async function handleForPerson(req: IncomingMessage, res: ServerResponse, deps: SupportChatDeps, url: URL): Promise<void> {
  let userId: string;
  try {
    ({ userId } = authenticateHttpToken(req, deps.jwtSecret));
  } catch (error) {
    sendJson(res, 401, { error: 'Please sign in again.', code: error instanceof HttpAuthError ? 'SIGNED_OUT' : 'AUTH_FAILED' });
    return;
  }

  if (url.pathname === '/support/chat') {
    if (req.method !== 'GET') { sendJson(res, 405, { error: 'Method not allowed' }); return; }
    const conversation = await supportClient.currentFor(userId);
    if (!conversation) {
      sendJson(res, 200, { conversation: null, messages: [] });
      return;
    }
    const messages = await supportClient.messages(conversation.id);
    await supportClient.readByUser(conversation.id);
    sendJson(res, 200, { conversation: conversationView(conversation), messages: messages.map(messageView) });
    return;
  }

  if (req.method !== 'POST') { sendJson(res, 405, { error: 'Method not allowed' }); return; }
  const body = await readJsonBody(req).catch(() => null);
  const read = readSupportContent(isRecord(body) ? body['content'] : undefined);
  if ('error' in read) {
    sendJson(res, 400, read);
    return;
  }
  if (await supportClient.sentRecently(userId, 60_000) >= SUPPORT_MESSAGES_PER_MINUTE) {
    sendJson(res, 429, { error: 'You are sending messages very quickly. Wait a minute, then try again.', code: 'RATE_LIMITED' });
    return;
  }

  const askedRide = isRecord(body) ? getString(body, 'rideId') : undefined;
  const rideId = askedRide && await supportClient.isOnRide(userId, askedRide)
    ? askedRide
    : await supportClient.liveRideOf(userId);
  const topic = (isRecord(body) ? getString(body, 'topic') : undefined)?.trim().slice(0, TOPIC_MAX) || null;

  const { conversation, message } = await supportClient.userSend({ userId, content: read.content, rideId, topic });
  sendJson(res, 201, { conversation: conversationView(conversation), message: messageView(message) });
}

async function tellPerson(deps: SupportChatDeps, userId: string, conversationId: string, message: Message): Promise<void> {
  const view = messageView(message);
  await deps.sendToUser?.(userId, 'support:message', { conversationId, message: view }).catch(() => undefined);
  await deps.publisher?.publishNotificationEvent({
    eventType: 'PUSH_SEND',
    notificationId: randomUUID(),
    userId,
    title: 'Wheelers support',
    body: message.content.length > 120 ? `${message.content.slice(0, 119)}…` : message.content,
    data: { type: 'support:message', conversationId },
    priority: 'high',
    timestamp: new Date().toISOString(),
  }).catch((error) => console.warn('[support-chat] push failed', { userId, error: error instanceof Error ? error.message : String(error) }));
}

async function handleForAdmin(req: IncomingMessage, res: ServerResponse, deps: SupportChatDeps, url: URL): Promise<void> {
  const auth = await verifyAdminAuth(req, deps);
  if (!auth) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return;
  }

  if (url.pathname === '/admin/support/conversations') {
    if (req.method !== 'GET') { sendJson(res, 405, { error: 'Method not allowed' }); return; }
    // The sidebar's badge: how many are waiting, without the list.
    if (url.searchParams.get('countsOnly')) {
      sendJson(res, 200, { counts: await supportClient.counts() });
      return;
    }
    const status = url.searchParams.get('status') === 'resolved' ? 'RESOLVED' : 'OPEN';
    const [rows, counts] = await Promise.all([supportClient.list(status), supportClient.counts()]);
    const live = await supportClient.liveRideIds(rows.flatMap((row) => (row.rideId ? [row.rideId] : [])));
    sendJson(res, 200, {
      status: status === 'OPEN' ? 'open' : 'resolved',
      counts,
      items: rows.map((row) => ({
        id: row.id,
        status: row.status === 'OPEN' ? 'open' : 'resolved',
        topic: row.topic,
        person: { id: row.user.id, name: row.user.name ?? 'No name yet', phone: row.user.phone, role: row.user.role },
        rideId: row.rideId,
        onLiveTrip: Boolean(row.rideId && live.has(row.rideId)),
        lastMessageAt: row.lastMessageAt.toISOString(),
        lastMessagePreview: row.lastMessagePreview,
        unread: row.unreadForSupport,
        assignedTo: row.assignedAdminName,
      })),
    });
    return;
  }

  const match = /^\/admin\/support\/conversations\/([^/]+)(?:\/(messages|assign|resolve))?$/.exec(url.pathname);
  const conversation = match ? await supportClient.find(match[1]!) : null;
  if (!match || !conversation) {
    sendJson(res, 404, { error: 'Conversation not found' });
    return;
  }
  const action = match[2];
  const page = `/admin/dashboard/support?c=${conversation.id}`;

  if (!action) {
    if (req.method !== 'GET') { sendJson(res, 405, { error: 'Method not allowed' }); return; }
    const [messages, ride] = await Promise.all([
      supportClient.messages(conversation.id),
      conversation.rideId ? supportClient.rideSummary(conversation.rideId) : null,
    ]);
    await supportClient.readBySupport(conversation.id);
    sendJson(res, 200, {
      conversation: {
        id: conversation.id,
        status: conversation.status === 'OPEN' ? 'open' : 'resolved',
        topic: conversation.topic,
        assignedTo: conversation.assignedAdminName,
        createdAt: conversation.createdAt.toISOString(),
        resolvedAt: conversation.resolvedAt?.toISOString() ?? null,
        person: { id: conversation.user.id, name: conversation.user.name ?? 'No name yet', phone: conversation.user.phone, email: conversation.user.email, role: conversation.user.role },
      },
      messages: messages.map((message) => ({
        id: message.id,
        from: message.sender === 'USER' ? 'person' : 'support',
        senderName: message.senderName,
        content: message.content,
        createdAt: message.createdAt.toISOString(),
      })),
      ride: ride ? {
        id: ride.id,
        status: ride.status,
        live: ['DRIVER_ASSIGNED', 'DRIVER_EN_ROUTE', 'ARRIVED', 'IN_PROGRESS'].includes(ride.status),
        pickupAddress: ride.pickupAddress,
        destAddress: ride.destAddress,
        fareNgn: Number(ride.agreedFareNgn ?? ride.fareEstimateNgn ?? 0) || null,
        startedAt: ride.startedAt?.toISOString() ?? null,
        createdAt: ride.createdAt.toISOString(),
        rider: ride.rider ? { name: ride.rider.name, phone: ride.rider.phone } : null,
        driver: ride.driver ? {
          name: ride.driver.user.name,
          phone: ride.driver.user.phone,
          car: [ride.driver.vehicleMake, ride.driver.vehicleModel].filter(Boolean).join(' ') || null,
          plate: ride.driver.vehiclePlate,
        } : null,
      } : null,
    });
    return;
  }

  if (req.method !== 'POST') { sendJson(res, 405, { error: 'Method not allowed' }); return; }

  if (action === 'messages') {
    const body = await readJsonBody(req).catch(() => null);
    const read = readSupportContent(isRecord(body) ? body['content'] : undefined);
    if ('error' in read) {
      sendJson(res, 400, read);
      return;
    }
    const sent = await supportClient.supportSend({ conversationId: conversation.id, content: read.content, adminId: auth.adminId, adminName: auth.adminName });
    recordAdminActivity({ adminId: auth.adminId, adminName: auth.adminName, kind: 'action', page, detail: { what: 'replied in support chat', conversationId: conversation.id, userId: conversation.userId }, ip: clientIp(req) });
    void tellPerson(deps, conversation.userId, conversation.id, sent.message);
    sendJson(res, 201, { message: { id: sent.message.id, from: 'support', senderName: sent.message.senderName, content: sent.message.content, createdAt: sent.message.createdAt.toISOString() } });
    return;
  }

  if (action === 'assign') {
    const updated = await supportClient.assign(conversation.id, { id: auth.adminId, name: auth.adminName });
    sendJson(res, 200, { assignedTo: updated.assignedAdminName });
    return;
  }

  await supportClient.resolve(conversation.id);
  recordAdminActivity({ adminId: auth.adminId, adminName: auth.adminName, kind: 'action', page, detail: { what: 'resolved a support chat', conversationId: conversation.id, userId: conversation.userId }, ip: clientIp(req) });
  void deps.sendToUser?.(conversation.userId, 'support:resolved', { conversationId: conversation.id }).catch(() => undefined);
  sendJson(res, 200, { status: 'resolved' });
}

/** Returns false when the path is not one of the support chat's. */
export async function handleSupportChatRoute(req: IncomingMessage, res: ServerResponse, deps: SupportChatDeps, url: URL): Promise<boolean> {
  if (url.pathname === '/support/chat' || url.pathname === '/support/chat/messages') {
    await handleForPerson(req, res, deps, url);
    return true;
  }
  if (url.pathname === '/admin/support/conversations' || url.pathname.startsWith('/admin/support/conversations/')) {
    await handleForAdmin(req, res, deps, url);
    return true;
  }
  return false;
}
