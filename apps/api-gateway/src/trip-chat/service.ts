import type { GatewayAuthContext } from '../types';
import { isRecord } from '../utils/object';
import { requireTripParticipant } from './access';
import { createCallService } from './calls';
import type { TripChatDeps } from './deps';
import { TripChatError } from './errors';
import { sendTripMessage, tripHistory } from './messages';

/**
 * Trip chat and Live call, as the gateway sees them: the socket messages, the
 * history a chat screen opens on, and the sweep that stops a phone ringing.
 *
 *   chat:send     { rideId, content, clientId? }  → chat:send:accepted
 *   chat:history  { rideId }                      → chat:history
 *   call:start    { rideId }                      → call:start:accepted
 *   call:accept   { callId }                      → call:accept:accepted
 *   call:decline  { callId }                      → call:decline:accepted
 *   call:end      { callId, failed? }             → call:end:accepted
 *   call:signal   { callId, signal }              → call:signal:accepted
 *   call:current  { rideId }                      → call:current
 *
 * Pushed to the people on the trip: chat:message, call:incoming, call:accepted,
 * call:answered, call:signal, call:ended.
 */

export const TRIP_CHAT_MESSAGE_TYPES: ReadonlySet<string> = new Set([
  'chat:send', 'chat:history',
  'call:start', 'call:accept', 'call:decline', 'call:end', 'call:signal', 'call:current',
]);

const SWEEP_EVERY_MS = 2_000;

function text(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  return typeof value === 'string' ? value.trim() : '';
}

export function createTripChatService(deps: TripChatDeps) {
  const calls = createCallService(deps);
  let sweepTimer: ReturnType<typeof setInterval> | null = null;
  let sweeping = false;

  async function history(rideId: string, userId: string) {
    const { info, role, other } = await requireTripParticipant(rideId, userId);
    return {
      rideId: info.rideId,
      tripId: info.tripId,
      status: info.status,
      open: info.open,
      closesAt: info.closesAt ? info.closesAt.toISOString() : null,
      me: { role },
      other: {
        userId: other.userId,
        name: other.firstName,
        role: role === 'RIDER' ? 'DRIVER' : 'RIDER',
        ...(role === 'RIDER' && info.vehicle ? { vehicle: info.vehicle.label, plate: info.vehicle.plate } : {}),
      },
      callsEnabled: deps.calls.enabled,
      messages: await tripHistory(info),
    };
  }

  /** A page socket may act only on its own ride, and so only on calls of that ride. */
  async function guardPageCall(auth: GatewayAuthContext, callId: string): Promise<void> {
    if (!auth.page) return;
    const call = await calls.store.get(callId);
    if (call && call.rideId !== auth.page.rideId) throw new TripChatError('NOT_IN_CALL', 'This call is not yours.');
  }

  async function handleWsMessage(
    type: string,
    rawPayload: Record<string, unknown>,
    auth: GatewayAuthContext,
  ): Promise<{ type: string; payload: Record<string, unknown> } | null> {
    if (!TRIP_CHAT_MESSAGE_TYPES.has(type)) return null;
    const payload = isRecord(rawPayload) ? rawPayload : {};
    const userId = auth.userId;
    const rideId = auth.page ? auth.page.rideId : text(payload, 'rideId');
    const callId = text(payload, 'callId');

    switch (type) {
      case 'chat:send': {
        const message = await sendTripMessage(deps, { rideId, userId, content: payload['content'] });
        const clientId = text(payload, 'clientId');
        return {
          type: 'chat:send:accepted',
          payload: { messageId: message.messageId, rideId: message.rideId, ...(clientId ? { clientId } : {}), message: { ...message } },
        };
      }
      case 'chat:history':
        return { type: 'chat:history', payload: await history(rideId, userId) };
      case 'call:start':
        return { type: 'call:start:accepted', payload: await calls.start({ rideId, userId }) };
      case 'call:accept':
        await guardPageCall(auth, callId);
        return { type: 'call:accept:accepted', payload: await calls.accept({ callId, userId }) };
      case 'call:decline':
        await guardPageCall(auth, callId);
        return { type: 'call:decline:accepted', payload: await calls.decline({ callId, userId }) };
      case 'call:end':
        await guardPageCall(auth, callId);
        return { type: 'call:end:accepted', payload: await calls.end({ callId, userId, failed: payload['failed'] === true }) };
      case 'call:signal':
        await guardPageCall(auth, callId);
        return { type: 'call:signal:accepted', payload: await calls.signal({ callId, userId, signal: payload['signal'] }) };
      case 'call:current':
        return { type: 'call:current', payload: await calls.current({ rideId, userId }) };
      default:
        return null;
    }
  }

  async function sweepOnce(): Promise<void> {
    if (sweeping) return;
    sweeping = true;
    try {
      await calls.sweep();
    } catch (error) {
      console.warn('[live-call] sweep failed', { error: error instanceof Error ? error.message : String(error) });
    } finally {
      sweeping = false;
    }
  }

  return {
    handleWsMessage,
    history,
    sendMessage: (input: { rideId: string; userId: string; content: unknown }) => sendTripMessage(deps, input),
    calls,
    callsEnabled: deps.calls.enabled,
    /** Every process sweeps; the lock on each call means each ends once. */
    start(): void {
      if (sweepTimer) return;
      sweepTimer = setInterval(() => void sweepOnce(), SWEEP_EVERY_MS);
      sweepTimer.unref?.();
    },
    stop(): void {
      if (sweepTimer) clearInterval(sweepTimer);
      sweepTimer = null;
    },
    sweepOnce,
  };
}

export type TripChatService = ReturnType<typeof createTripChatService>;
