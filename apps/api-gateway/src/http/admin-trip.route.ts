import type { IncomingMessage, ServerResponse } from 'http';
import { chatClient, stellarClient, tripCallClient, tripCodeClient } from '@wheleers/db';
import type { StellarService } from '../stellar/service';
import type { RedisClient } from '../redis/client';
import { loadTripChat } from '../trip-chat/access';
import { cardStatusOf } from '../trip-chat/card-status';
import { verifyAdminAuth } from './admin-auth.route';
import { sendJson } from './utils';

/**
 * A trip, as support sees it on the admin ride page:
 *
 *   GET  /admin/rides/:rideId/trip               the chat thread, the calls, the trip code's state, the WhatsApp card status
 *   POST /admin/rides/:rideId/trip-code/unlock   start without the code (the rider could not give it)
 *
 * The code itself is never shown here: support reading it out to a driver
 * would be an unlock with no record. An unlock keeps who did it, and when.
 */

export interface AdminTripRouteDeps {
  jwtSecret: string;
  adminApiKey: string;
  redis: RedisClient;
  sockets: { sendToUser(userId: string, type: string, payload: Record<string, unknown>): Promise<void> };
  /** The trip's Stellar Testnet transfers, with explorer links. Absent when Stellar is off. */
  stellar?: StellarService | null;
}

/** Before the trip starts: waiting for the driver, or the driver at the pickup. */
const UNLOCKABLE = new Set(['DRIVER_ASSIGNED', 'DRIVER_EN_ROUTE', 'ARRIVED']);

function codeState(state: Awaited<ReturnType<typeof tripCodeClient.state>>) {
  if (!state?.tripCode) return { status: 'none' as const, wrongTries: 0 };
  const status = state.tripCodeUnlockedAt ? 'unlocked' : state.tripCodeVerifiedAt ? 'verified' : 'waiting';
  return {
    status,
    wrongTries: state.tripCodeWrongTries,
    verifiedAt: state.tripCodeVerifiedAt?.toISOString() ?? null,
    unlockedBy: state.tripCodeUnlockedBy ?? null,
    unlockedAt: state.tripCodeUnlockedAt?.toISOString() ?? null,
  };
}

export async function handleAdminTripRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AdminTripRouteDeps,
  url: URL,
): Promise<boolean> {
  const match = url.pathname.match(/^\/admin\/rides\/([^/]+)\/(trip|trip-code\/unlock)$/);
  if (!match) return false;
  const rideId = decodeURIComponent(match[1]!);
  const action = match[2];
  if ((action === 'trip' && req.method !== 'GET') || (action !== 'trip' && req.method !== 'POST')) {
    sendJson(res, 405, { error: 'Method not allowed' });
    return true;
  }
  const admin = await verifyAdminAuth(req, deps);
  if (!admin) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return true;
  }
  res.setHeader('Cache-Control', 'no-store');

  const info = await loadTripChat(rideId).catch(() => null);
  if (!info) {
    sendJson(res, 404, { error: 'No such ride' });
    return true;
  }

  if (action === 'trip') {
    const [messages, calls, code, card, stellarTransfers] = await Promise.all([
      chatClient.latestForRide(rideId, 500),
      tripCallClient.listForRide(rideId),
      tripCodeClient.state(rideId),
      cardStatusOf(deps.redis, rideId).catch(() => null),
      deps.stellar ? stellarClient.listForRide(rideId) : Promise.resolve([]),
    ]);
    const nameOf = (userId: string) => (userId === info.rider.userId ? info.rider.name : info.driver?.userId === userId ? info.driver.name : 'Unknown');
    sendJson(res, 200, {
      rideId,
      tripId: info.tripId,
      status: info.status,
      channel: info.channel,
      chatOpen: info.open,
      rider: { userId: info.rider.userId, name: info.rider.name },
      driver: info.driver ? { userId: info.driver.userId, name: info.driver.name } : null,
      tripCode: codeState(code),
      whatsappCardStatus: card,
      stellar: deps.stellar ? stellarTransfers.map((t) => deps.stellar!.describe(t)) : null,
      messages: messages.map((m) => ({
        id: m.id, senderRole: m.senderRole, senderName: nameOf(m.senderId), kind: m.kind, content: m.content, createdAt: m.createdAt.toISOString(),
      })),
      calls: calls.map((c) => ({
        id: c.id,
        caller: { role: c.callerRole, name: nameOf(c.callerId) },
        callee: { name: nameOf(c.calleeId), channel: c.calleeChannel },
        status: c.status,
        endReason: c.endReason,
        startedAt: c.createdAt.toISOString(),
        answeredAt: c.answeredAt?.toISOString() ?? null,
        endedAt: c.endedAt?.toISOString() ?? null,
        durationSeconds: c.durationSeconds,
      })),
    });
    return true;
  }

  // POST unlock
  const code = await tripCodeClient.state(rideId);
  if (!code?.tripCode) {
    sendJson(res, 409, { error: 'This trip has no trip code to unlock.', code: 'NO_CODE' });
    return true;
  }
  if (code.tripCodeVerifiedAt || code.tripCodeUnlockedAt) {
    sendJson(res, 409, { error: 'The code is already done with on this trip.', code: 'ALREADY_DONE', tripCode: codeState(code) });
    return true;
  }
  if (!UNLOCKABLE.has(info.status)) {
    sendJson(res, 409, { error: 'Only a trip that has not started can be unlocked.', code: 'NOT_UNLOCKABLE' });
    return true;
  }
  await tripCodeClient.unlock(rideId, admin.adminName);
  console.info('[admin] trip code unlocked', { rideId, by: admin.adminName });
  // The driver's Start button stops asking.
  if (info.driver) {
    await deps.sockets.sendToUser(info.driver.userId, 'trip:code:unlocked', { rideId }).catch(() => undefined);
  }
  sendJson(res, 200, { unlocked: true, tripCode: codeState(await tripCodeClient.state(rideId)) });
  return true;
}
