import { RideCancelledEvent } from '@wheleers/kafka-schemas';
import { rideClient, userClient } from '@wheleers/db';
import type { RedisClient } from '../redis/client';
import type { GatewayPublisher } from '../websocket/publisher';
import { actOnWaiting, WaitingDealError, waitingNow } from '../rides/waiting-deal';
import { CANCELLATION_REASONS } from '../whatsapp/parse';
import type { FlowRequestBody } from './encryption';
import { actionFor } from './flow-dispatch';
import { cleanupRideKeys, clearActiveRide, clearBookingStage, clearPendingAccept, rememberChatCancellation } from './bid-state';

/**
 * The waiting price as one WhatsApp form (token `wait:<userId>`, Timi, 16 Nov 2026), for riders not on the
 * ride page. Two messages reach the chat: the question when the free minutes end ("Choose") and the driver's
 * counter ("Answer"); everything else happens here.
 *
 *   PRICE   the entry screen: the prices a minute (the driver's own first, as "Accept ₦80/min", when they asked one)
 *           and Cancel ride   [Send]   -> NOTE "Sent ₦60/min" / "Agreed: ₦80/min", or CANCEL
 *           Nothing to decide (agreed, the driver gone, the trip started): the same screen with one choice, Close.
 *   CANCEL  the chat's own three reasons   [Cancel ride]   -> NOTE "Ride cancelled" (the chat's cancel, exactly)
 *   NOTE    something to read, then swipe down. Nothing completes the form (completing disables the button on
 *           the message and posts "Response sent"); DONE is there only because a form needs a last screen.
 *
 * The offer and the acceptance go through rides/waiting-deal.ts like the ride page and the apps.
 */

export interface WaitingFlowDeps {
  redisClient: RedisClient;
  publisher: GatewayPublisher;
}

type Screen = { screen: string; data: Record<string, unknown> };

export const WAITING_FLOW_ACTIONS = { PRICE: 'wait_price', CANCEL: 'wait_cancel' } as const;
export const WAITING_SUBMITS_PER_MINUTE = 10;

const CLOSE = 'close';
type Choice = { id: string; title: string; description?: string };
/** A list option; no empty description (the live forms never send one). */
const option = (id: string, title: string, description = ''): Choice => (description ? { id, title, description } : { id, title });
const CANCEL = 'cancel';
const naira = (n: number) => `₦${n.toLocaleString('en-NG')}`;

function priceScreen(heading: string, body: string, choices: Choice[], error = ''): Screen {
  return { screen: 'PRICE', data: { heading, body, choices, error, has_error: Boolean(error) } };
}

/** Nothing to decide: the entry screen (the only one a form opens on) with one choice, Close. */
function closedScreen(heading: string, body: string): Screen {
  return priceScreen(heading, body, [option(CLOSE, 'Close', 'Go back to the chat')]);
}

function note(headline: string, text: string): Screen {
  return { screen: 'NOTE', data: { headline, note: text } };
}

function cancelScreen(error = ''): Screen {
  return {
    screen: 'CANCEL',
    data: { reasons: Object.entries(CANCELLATION_REASONS).map(([id, title]) => option(id, title)), error, has_error: Boolean(error) },
  };
}

/** The rider's ride while the driver waits at the pickup; null otherwise. */
async function waitingRide(userId: string) {
  const ride = await rideClient.findActiveByRider(userId).catch(() => null);
  if (!ride || ride.riderId !== userId) return null;
  const now = await waitingNow(ride.id).catch(() => null);
  if (!now || now.status !== 'ARRIVED' || !now.waiting) return null;
  return { ride, waiting: now.waiting };
}

/** What the entry screen shows now. */
export async function waitingPriceScreen(userId: string, error = '', at: Date = new Date()): Promise<Screen> {
  const found = await waitingRide(userId);
  if (!found) return closedScreen('Nothing to decide here', 'Your driver is no longer waiting at the pickup.');
  const { waiting } = found;
  const deal = waiting.deal;
  if (deal.rateNgn !== null) return closedScreen(`Agreed: ${naira(deal.rateNgn)}/min`, 'Waiting time counts from when you agreed.');
  if (waiting.stoppedAt) return closedScreen('Nothing to decide here', 'Your driver has stopped waiting.');
  const waited = at.getTime() - Date.parse(waiting.arrivedAt);
  if (waited < deal.baseFreeSeconds * 1000) return closedScreen('Waiting is still free', `Your driver has waited less than ${Math.round(deal.baseFreeSeconds / 60)} min.`);

  const offer = deal.offer;
  const cancel = option(CANCEL, 'Cancel ride', "Free. You won't be charged.");
  if (offer?.by === 'driver') {
    const accept = option(`accept:${offer.ngn}`, `Accept ${naira(offer.ngn)}/min`, "Your driver's price");
    const others = deal.offersLeft > 0 ? deal.rates.filter((n) => n !== offer.ngn).map((n) => option(`rate:${n}`, `${naira(n)}/min`)) : [];
    return priceScreen(`Your driver asks ${naira(offer.ngn)}/min`, others.length ? 'Accept it, or pick another price.' : 'Accept it, or cancel.', [accept, ...others, cancel], error);
  }
  const rates = deal.rates.map((n) => option(`rate:${n}`, `${naira(n)}/min`, offer?.by === 'rider' && offer.ngn === n ? 'Your offer' : ''));
  if (offer?.by === 'rider') {
    return priceScreen(`You offered ${naira(offer.ngn)}/min`, 'Waiting for your driver. You can change your price.', [...rates, cancel], error);
  }
  return priceScreen(
    'Keep your driver waiting',
    'Pick a price a minute. Your driver can accept or ask for another. Nothing is charged until you both agree.',
    [...rates, cancel],
    error,
  );
}

async function overRateLimit(redis: RedisClient, userId: string): Promise<boolean> {
  const key = `whatsapp:user:${userId}:waiting_form_submits:${Math.floor(Date.now() / 60_000)}`;
  const used = Number(await redis.get(key).catch(() => null)) || 0;
  await redis.set(key, String(used + 1), 120).catch(() => undefined);
  return used >= WAITING_SUBMITS_PER_MINUTE;
}

/**
 * Cancel the booked ride exactly as the chat does after its reason (http/whatsapp.route.ts, awaiting_cancel_reason):
 * the reason is kept for the one "Ride cancelled … refund" message, RIDE_CANCELLED goes out, the chat's keys are cleared.
 */
async function cancelAsTheChatDoes(deps: WaitingFlowDeps, userId: string, ride: { id: string; driverId: string | null }, reason: string): Promise<void> {
  const phone = (await userClient.findById(userId).catch(() => null))?.phone ?? null;
  if (phone) await rememberChatCancellation(deps.redisClient, ride.id, phone, reason).catch(() => undefined);
  await deps.publisher.publishRideEvent(RideCancelledEvent.parse({
    eventType: 'RIDE_CANCELLED',
    rideId: ride.id,
    riderId: userId,
    driverId: ride.driverId ?? undefined,
    cancelledBy: 'rider',
    reason,
    timestamp: new Date().toISOString(),
  }));
  await clearActiveRide(deps.redisClient, userId);
  await cleanupRideKeys(deps.redisClient, ride.id);
  await clearPendingAccept(deps.redisClient, userId);
  await clearBookingStage(deps.redisClient, userId);
}

export async function handleWaitingFlow(body: FlowRequestBody, userId: string, deps: WaitingFlowDeps): Promise<Screen> {
  const action = actionFor(body, { PRICE: WAITING_FLOW_ACTIONS.PRICE, CANCEL: WAITING_FLOW_ACTIONS.CANCEL });
  const data = body.data ?? {};
  if (body.action !== 'data_exchange' || !action) return waitingPriceScreen(userId);

  if (await overRateLimit(deps.redisClient, userId)) {
    return action === WAITING_FLOW_ACTIONS.CANCEL ? cancelScreen('Try again in a minute.') : waitingPriceScreen(userId, 'Try again in a minute.');
  }

  if (action === WAITING_FLOW_ACTIONS.CANCEL) {
    const reason = CANCELLATION_REASONS[String(data['reason'] ?? '')];
    if (!reason) return cancelScreen('Pick a reason.');
    const found = await waitingRide(userId);
    if (!found) return note('Nothing to cancel here', 'Your driver is no longer waiting at the pickup.');
    // Once per ride: a double tap (or Meta retrying the request) never cancels twice.
    const claimKey = `ride:${found.ride.id}:waiting-form-cancel`;
    if (!(await deps.redisClient.setIfNotExists(claimKey, '1', 15 * 60).catch(() => true))) {
      return note('Ride cancelled', "Cancelling is free. You won't be charged.");
    }
    try {
      await cancelAsTheChatDoes(deps, userId, { id: found.ride.id, driverId: found.ride.driverId ?? null }, reason);
    } catch (error) {
      await deps.redisClient.del(claimKey).catch(() => undefined);
      console.error('[waiting-flow] cancel failed', { userId, error: error instanceof Error ? error.message : String(error) });
      return cancelScreen('Could not cancel. Try again.');
    }
    return note('Ride cancelled', "Cancelling is free. You won't be charged.");
  }

  const choice = String(data['choice'] ?? '');
  if (choice === CLOSE) return note('All done', 'Nothing more to decide here.');
  if (choice === CANCEL) return cancelScreen();
  const pick = /^(rate|accept):(\d+)$/.exec(choice);
  if (!pick) return waitingPriceScreen(userId, 'Pick a price.');
  const found = await waitingRide(userId);
  if (!found) return waitingPriceScreen(userId);
  const ngn = Number(pick[2]);
  try {
    const waiting = await actOnWaiting(found.ride.id, userId, { action: pick[1] === 'accept' ? 'accept' : 'offer', ngn });
    const agreed = waiting?.deal.rateNgn;
    if (typeof agreed === 'number') return note(`Agreed: ${naira(agreed)}/min`, 'Waiting time counts from now.');
    return note(`Sent ${naira(ngn)}/min`, "We'll message you when your driver answers.");
  } catch (error) {
    if (error instanceof WaitingDealError) return waitingPriceScreen(userId, error.message);
    console.error('[waiting-flow] could not send the price', { userId, error: error instanceof Error ? error.message : String(error) });
    return waitingPriceScreen(userId, 'Could not send that. Try again.');
  }
}
