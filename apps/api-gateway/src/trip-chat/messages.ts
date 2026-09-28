import { randomUUID } from 'crypto';
import { chatClient } from '@wheleers/db';
import { ChatMessageSentEvent } from '@wheleers/kafka-schemas';
import { requireOpen, requireTripParticipant, type TripChatInfo, type TripRole } from './access';
import { MAX_MESSAGE_CHARS, MESSAGES_PER_MINUTE, type TripChatDeps } from './deps';
import { TripChatError } from './errors';
import { overLimit } from './limits';
import { containsPhoneNumber } from './phone-guard';

/**
 * Trip chat messages: text only, between a trip's rider and driver, while the
 * chat is open. Saved against the ride, then delivered at once to every
 * socket both people have open (app or Trip chat page), and to whoever is not
 * looking: a push to an app, a WhatsApp message to a WhatsApp rider.
 */

export interface TripMessageView {
  messageId: string;
  rideId: string;
  tripId: string | null;
  senderId: string;
  senderRole: TripRole;
  senderName: string;
  content: string;
  kind: 'text' | 'call';
  createdAt: string;
}

interface ChatRow {
  id: string;
  rideId: string;
  senderId: string;
  senderRole: string;
  content: string;
  kind?: string | null;
  createdAt: Date;
}

export function toView(row: ChatRow, info: Pick<TripChatInfo, 'tripId' | 'rider' | 'driver'>): TripMessageView {
  const role: TripRole = row.senderRole === 'DRIVER' ? 'DRIVER' : 'RIDER';
  const sender = role === 'DRIVER' ? info.driver : info.rider;
  return {
    messageId: row.id,
    rideId: row.rideId,
    tripId: info.tripId,
    senderId: row.senderId,
    senderRole: role,
    senderName: sender?.firstName ?? (role === 'DRIVER' ? 'Driver' : 'Rider'),
    content: row.content,
    kind: row.kind === 'call' ? 'call' : 'text',
    createdAt: row.createdAt.toISOString(),
  };
}

/** Trim the ends, and no more than one blank line in a row. */
export function tidy(content: unknown): string {
  return typeof content === 'string' ? content.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim() : '';
}

const roleLabel = (role: TripRole) => (role === 'DRIVER' ? 'driver' : 'rider');

export async function sendTripMessage(
  deps: TripChatDeps,
  input: { rideId: string; userId: string; content: unknown },
): Promise<TripMessageView> {
  const { info, role } = await requireTripParticipant(input.rideId, input.userId);
  requireOpen(info);

  const content = tidy(input.content);
  if (!content) throw new TripChatError('EMPTY', 'Type a message first.');
  if (content.length > MAX_MESSAGE_CHARS) {
    throw new TripChatError('TOO_LONG', `That message is too long. Keep it under ${MAX_MESSAGE_CHARS} characters.`);
  }
  if (role === 'DRIVER' && containsPhoneNumber(content)) {
    throw new TripChatError('PHONE_NUMBER', "Phone numbers can't be sent in the chat. Tap Call to talk to your rider.");
  }
  if (await overLimit(deps.redis, `tripchat:rate:${input.userId}:${info.rideId}`, MESSAGES_PER_MINUTE, 60)) {
    throw new TripChatError('RATE_LIMITED', 'You are sending messages too quickly. Wait a moment.');
  }

  const row = await chatClient.create({ rideId: info.rideId, senderId: input.userId, senderRole: role, content, kind: 'text' });
  const view = toView(row, info);
  await deliver(deps, info, view);
  return view;
}

/** "Missed call", "Call · 3:12": written by the call service, from the caller, into the same thread. */
export async function recordCallLine(
  deps: TripChatDeps,
  info: Pick<TripChatInfo, 'rideId' | 'tripId' | 'rider' | 'driver' | 'channel'>,
  caller: { userId: string; role: TripRole },
  content: string,
): Promise<TripMessageView> {
  const row = await chatClient.create({ rideId: info.rideId, senderId: caller.userId, senderRole: caller.role, content, kind: 'call' });
  const view = toView(row, info);
  await deliver(deps, info, view);
  return view;
}

export async function tripHistory(info: TripChatInfo, limit = 100): Promise<TripMessageView[]> {
  const rows = await chatClient.latestForRide(info.rideId, limit);
  return rows.map((row) => toView(row, info));
}

/**
 * To both people's sockets at once (the sender's other screens show it too),
 * then to the recipient wherever they are not looking. Call lines only go to
 * the sockets: the call service says "missed call" itself.
 */
async function deliver(
  deps: TripChatDeps,
  info: Pick<TripChatInfo, 'rideId' | 'tripId' | 'rider' | 'driver' | 'channel'>,
  view: TripMessageView,
): Promise<void> {
  const payload = { ...view } as unknown as Record<string, unknown>;
  const people = [info.rider.userId, info.driver?.userId].filter((id): id is string => Boolean(id));
  await Promise.all(people.map((userId) => deps.sockets.sendToUser(userId, 'chat:message', payload).catch(() => undefined)));

  // The event stream keeps its record of every message; delivery no longer waits on it.
  void deps.publisher.publishRideEvent(ChatMessageSentEvent.parse({
    eventType: 'CHAT_MESSAGE_SENT',
    rideId: view.rideId,
    messageId: view.messageId,
    senderId: view.senderId,
    senderRole: view.senderRole,
    content: view.content.slice(0, 1000),
    kind: view.kind,
    timestamp: view.createdAt,
  })).catch((error) => console.warn('[trip-chat] chat event not published', { error: error instanceof Error ? error.message : String(error) }));

  if (view.kind !== 'text') return;
  const recipient = view.senderRole === 'DRIVER' ? info.rider : info.driver;
  if (!recipient) return;
  const sender = view.senderRole === 'DRIVER' ? info.driver : info.rider;
  const senderName = sender?.firstName ?? 'Your trip';

  if (recipient === info.rider && info.channel === 'WHATSAPP') {
    await forwardToWhatsappRider(deps, info, senderName, view.content);
    return;
  }

  // An app: a push, always. The app is often behind the map; it hides the
  // banner itself when this chat is the screen already open.
  await deps.publisher.publishNotificationEvent({
    eventType: 'PUSH_SEND',
    notificationId: randomUUID(),
    userId: recipient.userId,
    title: `${senderName} (your ${roleLabel(view.senderRole)})`.slice(0, 100),
    body: view.content.length > 180 ? `${view.content.slice(0, 177)}…` : view.content,
    data: { type: 'chat:message', rideId: info.rideId, messageId: view.messageId },
    priority: 'high',
    timestamp: new Date(view.createdAt).toISOString(),
  }).catch(() => undefined);
}

/**
 * A WhatsApp rider has no app to buzz. If the Trip chat page is open (it keeps
 * a socket only while it is on screen), the page already has the message.
 * Otherwise it goes to their WhatsApp, with the button back to the page.
 */
async function forwardToWhatsappRider(
  deps: TripChatDeps,
  info: Pick<TripChatInfo, 'rideId' | 'rider'>,
  driverName: string,
  content: string,
): Promise<void> {
  if (!deps.whatsapp || !info.rider.phone) return;
  if (await deps.sockets.isUserConnected(info.rider.userId).catch(() => false)) return;
  const url = deps.whatsapp.pageUrl(info.rider.userId, info.rideId);
  const body = `*${driverName} (your driver):*\n${content}`.slice(0, 1024);
  await deps.whatsapp.send(info.rider.phone, body, url ? { text: 'Reply', url } : undefined)
    .catch((error) => console.warn('[trip-chat] WhatsApp copy failed', { error: error instanceof Error ? error.message : String(error) }));
}

