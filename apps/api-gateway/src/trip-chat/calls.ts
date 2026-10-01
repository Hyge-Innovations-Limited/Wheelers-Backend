import { randomUUID } from 'crypto';
import { tripCallClient, type TripCallStatus } from '@wheleers/db';
import { loadTripChat, requireOpen, requireTripParticipant, type TripChatInfo } from './access';
import { createCallStore, type LiveCall } from './call-store';
import { CALLS_PER_TEN_MINUTES, MAX_CALL_MS, nowOf, RING_MS, type TripChatDeps } from './deps';
import { TripChatError } from './errors';
import { iceServersFor } from './ice-servers';
import { overLimit } from './limits';
import { recordCallLine } from './messages';

/**
 * Live call: a voice call between a trip's rider and driver, phone to phone
 * over WebRTC, through our own STUN/TURN server. The gateway never carries a
 * sound; it rings, answers and hangs up, and passes each side's connection
 * details (offer, answer, network candidates) to the other.
 *
 *   caller                     gateway                        callee
 *   call:start        ──▶  ring (socket, push or WhatsApp)  ──▶ call:incoming
 *                                                        ◀── call:accept
 *   call:accepted     ◀──
 *   call:signal offer ──▶                                 ──▶ call:signal
 *                     ◀──                                 ◀── call:signal answer
 *   candidates both ways as call:signal; then the sound flows between the phones.
 *   call:end (either) ──▶  call:ended to both, and a line in the chat
 *
 * One call at a time per trip. It rings 30 seconds on an app and 45 on
 * WhatsApp, and is cut off after 30 minutes.
 */

type Outcome = 'completed' | 'declined' | 'cancelled' | 'missed' | 'failed';

const STATUS_OF: Record<Outcome, TripCallStatus> = {
  completed: 'COMPLETED',
  declined: 'DECLINED',
  cancelled: 'CANCELLED',
  missed: 'MISSED',
  failed: 'FAILED',
};

/** What the connection details may look like. Anything else is not passed on. */
const SIGNAL_TYPES: ReadonlySet<string> = new Set(['offer', 'answer', 'candidate', 'candidates']);
const MAX_SIGNAL_BYTES = 32 * 1024;

function minutesAndSeconds(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function roleWord(role: 'RIDER' | 'DRIVER'): string {
  return role === 'DRIVER' ? 'driver' : 'rider';
}

export function createCallService(deps: TripChatDeps) {
  const store = createCallStore(deps.redis);
  const ringMs = deps.calls.ringMs ?? RING_MS;
  const maxCallMs = deps.calls.maxCallMs ?? MAX_CALL_MS;

  const ice = (userId: string) => iceServersFor(userId, deps.calls.turn, nowOf(deps));

  /** What either side's screen needs to show the call. */
  function describe(call: LiveCall, forUserId: string) {
    const isCaller = call.callerId === forUserId;
    const now = nowOf(deps);
    return {
      callId: call.callId,
      rideId: call.rideId,
      tripId: call.tripId,
      state: call.state,
      direction: isCaller ? 'outgoing' : 'incoming',
      other: isCaller
        ? { userId: call.calleeId, name: call.calleeName, role: call.calleeRole }
        : { userId: call.callerId, name: call.callerName, role: call.callerRole },
      calleeChannel: call.calleeChannel,
      ringSecondsLeft: call.state === 'ringing' ? Math.max(0, Math.ceil((call.ringDeadline - now) / 1000)) : 0,
      answeredAt: call.answeredAt ? new Date(call.answeredAt).toISOString() : null,
    };
  }

  async function mustGet(callId: string, userId: string): Promise<LiveCall> {
    const call = await store.get(typeof callId === 'string' ? callId : '');
    if (!call) throw new TripChatError('CALL_GONE', 'This call has ended.');
    if (call.callerId !== userId && call.calleeId !== userId) throw new TripChatError('NOT_IN_CALL', 'This call is not yours.');
    return call;
  }

  /** Tell the person rung that they are being called, wherever they are. */
  async function ring(call: LiveCall, info: TripChatInfo): Promise<void> {
    await deps.sockets.sendToUser(call.calleeId, 'call:incoming', { ...describe(call, call.calleeId), iceServers: ice(call.calleeId) })
      .catch(() => undefined);

    if (call.calleeChannel === 'whatsapp') {
      if (!deps.whatsapp || !info.rider.phone) return;
      // 📞 on the ride card instead of a new message; the message only when there is no card.
      if (await deps.whatsapp.setCardStatus(call.rideId, 'call')) return;
      const url = deps.whatsapp.pageUrl(call.calleeId, call.rideId, call.callId);
      const body = `*${call.callerName}, your ${roleWord(call.callerRole)}, is calling.*\n\nTap *Answer call* to talk. It rings for ${Math.round(ringMs.whatsapp / 1000)} seconds.`;
      await deps.whatsapp.send(info.rider.phone, body, url ? { text: 'Answer call', url } : undefined)
        .catch((error) => console.warn('[live-call] WhatsApp ring failed', { callId: call.callId, error: error instanceof Error ? error.message : String(error) }));
      return;
    }

    // An app behind another app, or a locked phone: a high-priority push. (A
    // call screen that rings on a locked phone comes with the next app build.)
    await deps.publisher.publishNotificationEvent({
      eventType: 'PUSH_SEND',
      notificationId: randomUUID(),
      userId: call.calleeId,
      title: `${call.callerName} is calling`.slice(0, 100),
      body: `Your ${roleWord(call.callerRole)} is calling you on Wheelers. Tap to answer.`,
      data: { type: 'call:incoming', callId: call.callId, rideId: call.rideId },
      priority: 'high',
      timestamp: new Date(nowOf(deps)).toISOString(),
    }).catch(() => undefined);
  }

  /** The person rung never answered (or the caller gave up first): say so where they will see it. */
  async function tellMissed(call: LiveCall, info: TripChatInfo): Promise<void> {
    if (call.calleeChannel === 'whatsapp') {
      if (!deps.whatsapp || !info.rider.phone) return;
      // The 📞 stays on the card until they open the chat: that is the missed call.
      if (await deps.whatsapp.setCardStatus(call.rideId, 'call')) return;
      const url = deps.whatsapp.pageUrl(call.calleeId, call.rideId);
      await deps.whatsapp.send(info.rider.phone, `You missed a call from *${call.callerName}*, your ${roleWord(call.callerRole)}.`, url ? { text: 'Call back', url } : undefined)
        .catch(() => undefined);
      return;
    }
    await deps.publisher.publishNotificationEvent({
      eventType: 'PUSH_SEND',
      notificationId: randomUUID(),
      userId: call.calleeId,
      title: `Missed call from ${call.callerName}`.slice(0, 100),
      body: `Your ${roleWord(call.callerRole)} called. Open your trip to call back or send a message.`,
      data: { type: 'call:missed', callId: call.callId, rideId: call.rideId },
      priority: 'normal',
      timestamp: new Date(nowOf(deps)).toISOString(),
    }).catch(() => undefined);
  }

  /**
   * The end of a call, however it came: hung up, declined, never answered, cut
   * off. `decide` looks at the call as it is at that instant, under the lock:
   * a call answered a moment ago is not "missed", and one hung up a moment
   * after it was answered is a call, not a decline. Only the first ending
   * counts; the rest find it already ended.
   */
  async function finish(
    callId: string,
    decide: (call: LiveCall, now: number) => { outcome: Outcome; endReason: string } | null,
  ): Promise<LiveCall | null> {
    const ended = await store.withLock(callId, async () => {
      const call = await store.get(callId);
      if (!call || call.state === 'ended') return null;
      const now = nowOf(deps);
      const decision = decide(call, now);
      if (!decision) return null;
      const { endReason } = decision;
      const wasAnswered = call.state === 'active';
      // "Failed" after they had talked is just the end of the call.
      const finalOutcome: Outcome = decision.outcome === 'failed' && wasAnswered ? 'completed' : decision.outcome;
      const next: LiveCall = { ...call, state: 'ended', endedAt: now, endReason };
      await store.save(next);
      await store.clearTimers(callId);
      await store.releaseRide(call.rideId, callId);
      return { call: next, outcome: finalOutcome, wasAnswered, endReason };
    });
    if (!ended) return null;

    const { call, outcome: finalOutcome, wasAnswered, endReason } = ended;
    const durationSeconds = wasAnswered && call.answeredAt ? Math.max(0, Math.round((call.endedAt! - call.answeredAt) / 1000)) : null;
    await tripCallClient.ended(call.callId, {
      status: STATUS_OF[finalOutcome],
      endReason,
      endedAt: new Date(call.endedAt!),
      durationSeconds,
    }).catch((error) => console.warn('[live-call] call record not closed', { callId, error: error instanceof Error ? error.message : String(error) }));

    const payload = { callId: call.callId, rideId: call.rideId, reason: finalOutcome, endReason, durationSeconds };
    await Promise.all([
      deps.sockets.sendToUser(call.callerId, 'call:ended', payload).catch(() => undefined),
      deps.sockets.sendToUser(call.calleeId, 'call:ended', payload).catch(() => undefined),
    ]);

    const info = await loadTripChat(call.rideId).catch(() => null);
    if (info) {
      const line = durationSeconds !== null
        ? `Call · ${minutesAndSeconds(durationSeconds)}`
        : finalOutcome === 'declined' ? 'Call declined'
          : finalOutcome === 'failed' ? 'Call could not connect'
            : 'Missed call';
      await recordCallLine(deps, info, { userId: call.callerId, role: call.callerRole }, line)
        .catch((error) => console.warn('[live-call] call line not written', { callId, error: error instanceof Error ? error.message : String(error) }));
      if (finalOutcome === 'missed' || finalOutcome === 'cancelled') await tellMissed(call, info);
      // Talked, or they said no: the card goes back to 🟢.
      else if (call.calleeChannel === 'whatsapp') await deps.whatsapp?.setCardStatus(call.rideId, 'live');
    }
    return call;
  }

  return {
    /** Ring the other person on this trip. */
    async start(input: { rideId: string; userId: string }) {
      if (!deps.calls.enabled) throw new TripChatError('CALLS_OFF', 'Calling is not available yet. Send a message instead.');
      const { info, role, other } = await requireTripParticipant(input.rideId, input.userId);
      requireOpen(info);

      const current = await store.currentForRide(info.rideId);
      if (current) {
        throw new TripChatError('CALL_BUSY', current.calleeId === input.userId && current.state === 'ringing'
          ? 'They are already calling you. Answer that call.'
          : 'A call is already going on this trip.');
      }
      if (await overLimit(deps.redis, `tripcall:rate:${input.userId}:${info.rideId}`, CALLS_PER_TEN_MINUTES, 600)) {
        throw new TripChatError('CALL_LIMIT', 'You have called a lot in the last few minutes. Send a message, or try again shortly.');
      }

      const me = role === 'RIDER' ? info.rider : info.driver!;
      const calleeChannel = other === info.rider && info.channel === 'WHATSAPP' ? 'whatsapp' : 'app';
      const now = nowOf(deps);
      const call: LiveCall = {
        callId: randomUUID(),
        rideId: info.rideId,
        tripId: info.tripId,
        callerId: input.userId,
        callerRole: role,
        callerName: me.firstName,
        calleeId: other.userId,
        calleeRole: role === 'RIDER' ? 'DRIVER' : 'RIDER',
        calleeName: other.firstName,
        calleeChannel,
        state: 'ringing',
        createdAt: now,
        ringDeadline: now + (calleeChannel === 'whatsapp' ? ringMs.whatsapp : ringMs.app),
      };
      // Two people pressing Call at the same instant: one of them gets the line.
      if (!(await store.claimRide(info.rideId, call.callId))) {
        throw new TripChatError('CALL_BUSY', 'A call is already going on this trip.');
      }
      await store.save(call);
      await store.ringUntil(call.callId, call.ringDeadline);
      await tripCallClient.start({
        id: call.callId, rideId: call.rideId, callerId: call.callerId, callerRole: call.callerRole,
        calleeId: call.calleeId, calleeChannel: call.calleeChannel,
      }).catch((error) => console.warn('[live-call] call record not written', { callId: call.callId, error: error instanceof Error ? error.message : String(error) }));

      await ring(call, info);
      return { ...describe(call, input.userId), iceServers: ice(input.userId) };
    },

    /** The person rung picks up. Every other screen of theirs stops ringing. */
    async accept(input: { callId: string; userId: string }) {
      const answered = await store.withLock(input.callId, async () => {
        const call = await mustGet(input.callId, input.userId);
        if (call.calleeId !== input.userId) throw new TripChatError('NOT_IN_CALL', 'Only the person being called can answer.');
        if (call.state === 'ended') throw new TripChatError('CALL_GONE', 'This call has ended.');
        if (call.state === 'active') return { call, fresh: false };
        const now = nowOf(deps);
        const next: LiveCall = { ...call, state: 'active', answeredAt: now };
        await store.save(next);
        await store.activeUntil(call.callId, now + maxCallMs);
        return { call: next, fresh: true };
      });
      const { call, fresh } = answered;
      if (fresh) {
        await tripCallClient.answered(call.callId, new Date(call.answeredAt!)).catch(() => undefined);
        await Promise.all([
          deps.sockets.sendToUser(call.callerId, 'call:accepted', describe(call, call.callerId)).catch(() => undefined),
          deps.sockets.sendToUser(call.calleeId, 'call:answered', { callId: call.callId, rideId: call.rideId }).catch(() => undefined),
        ]);
      }
      return { ...describe(call, input.userId), iceServers: ice(input.userId) };
    },

    async decline(input: { callId: string; userId: string }) {
      const call = await mustGet(input.callId, input.userId);
      if (call.calleeId !== input.userId) throw new TripChatError('NOT_IN_CALL', 'Only the person being called can decline.');
      await finish(call.callId, (current) => ({ outcome: current.state === 'active' ? 'completed' : 'declined', endReason: 'declined' }));
      return { callId: call.callId };
    },

    /**
     * Either side hangs up. Before it is answered, the caller hanging up is a
     * missed call for the other person, and the callee hanging up is a decline.
     * `failed`: the phones could not reach each other.
     */
    async end(input: { callId: string; userId: string; failed?: boolean }) {
      const call = await mustGet(input.callId, input.userId);
      if (call.state === 'ended') return { callId: call.callId };
      await finish(call.callId, (current) => {
        const endReason = input.failed ? 'no_connection' : 'hung_up';
        if (input.failed) return { outcome: 'failed', endReason };
        if (current.state === 'active') return { outcome: 'completed', endReason };
        return { outcome: current.callerId === input.userId ? 'cancelled' : 'declined', endReason };
      });
      return { callId: call.callId };
    },

    /** Pass one side's connection details to the other, untouched. */
    async signal(input: { callId: string; userId: string; signal: unknown }) {
      const call = await mustGet(input.callId, input.userId);
      if (call.state === 'ended') throw new TripChatError('CALL_GONE', 'This call has ended.');
      const signal = input.signal;
      if (!signal || typeof signal !== 'object' || !SIGNAL_TYPES.has(String((signal as { type?: unknown }).type))) {
        throw new TripChatError('BAD_SIGNAL', 'That call message was not understood.');
      }
      if (JSON.stringify(signal).length > MAX_SIGNAL_BYTES) throw new TripChatError('BAD_SIGNAL', 'That call message is too large.');
      const to = call.callerId === input.userId ? call.calleeId : call.callerId;
      await deps.sockets.sendToUser(to, 'call:signal', { callId: call.callId, rideId: call.rideId, from: input.userId, signal: signal as Record<string, unknown> });
      return { callId: call.callId };
    },

    /** The call on this trip right now, for a screen that opens mid-ring (from a push, or the WhatsApp link). */
    async current(input: { rideId: string; userId: string }) {
      await requireTripParticipant(input.rideId, input.userId);
      const call = await store.currentForRide(input.rideId);
      if (!call) return { rideId: input.rideId, call: null };
      return { rideId: input.rideId, call: { ...describe(call, input.userId), iceServers: ice(input.userId) } };
    },

    /** Stop what has rung too long, and cut off what has run too long. Every process may run it; each call ends once. */
    async sweep(): Promise<number> {
      const now = nowOf(deps);
      const due = await store.due(now);
      let ended = 0;
      for (const callId of due.ringing) {
        const call = await store.get(callId);
        if (!call || call.state !== 'ringing') { await store.clearRinging(callId); continue; }
        const done = await finish(callId, (current, at) =>
          current.state === 'ringing' && current.ringDeadline <= at ? { outcome: 'missed', endReason: 'no_answer' } : null);
        if (done) ended += 1;
      }
      for (const callId of due.active) {
        const done = await finish(callId, (current, at) =>
          current.state === 'active' && (current.answeredAt ?? at) + maxCallMs <= at ? { outcome: 'completed', endReason: 'too_long' } : null);
        if (done) ended += 1;
      }
      return ended;
    },

    describe,
    store,
  };
}

export type CallService = ReturnType<typeof createCallService>;
