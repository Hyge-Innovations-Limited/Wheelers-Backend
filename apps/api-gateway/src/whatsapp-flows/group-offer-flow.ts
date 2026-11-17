import { prisma, rideClient } from '@wheleers/db';
import type { RedisClient } from '../redis/client';
import { answerGroupOffer, GroupLiveError, offerForRide, offerViewFor } from '../rides/group-live';
import type { FlowRequestBody } from './encryption';
import { actionFor } from './flow-dispatch';
import { firstNameOf } from '../rides/group-people';
import { SELFIE_ASK } from '../whatsapp/group-selfie-text';

/**
 * A group ride offer as one WhatsApp form (token `grp:<userId>`, Timi, 17 Nov 2026), for riders not on the ride
 * page: who is going their way, the seat price, Ride together or No thanks. One answer, the first one counts
 * (rides/group-live.ts). A yes with no selfie on file: the rider sends one as a photo in the chat within 60 s
 * (a marker, not the chat's booking stage, so their search in the chat is left as it is). Endings are a note to
 * swipe away; nothing completes the form.
 */

type Screen = { screen: string; data: Record<string, unknown> };
/** Marks that the next photo in the chat is this rider's group ride selfie (90 s: the 60 s and a margin). */
export const groupSelfieExpectedKey = (userId: string) => `whatsapp:user:${userId}:group_selfie_expected`;
export async function expectGroupSelfie(redis: RedisClient, userId: string): Promise<void> {
  await redis.set(groupSelfieExpectedKey(userId), '1', 90).catch(() => undefined);
}
const naira = (n: number) => `₦${Math.round(n).toLocaleString('en-NG')}`;

function closed(heading: string, body: string): Screen {
  return { screen: 'OFFER', data: { heading, body, price: '', choices: [{ id: 'close', title: 'Close', description: 'Go back to the chat' }], error: '', has_error: false } };
}
const note = (headline: string, text: string): Screen => ({ screen: 'NOTE', data: { headline, note: text } });

async function searchOf(userId: string): Promise<string | null> {
  const ride = await rideClient.findActiveByRider(userId).catch(() => null);
  return ride && (String(ride.status) === 'REQUESTED' || String(ride.status) === 'MATCHING') ? ride.id : null;
}

export async function groupOfferScreen(redis: RedisClient, userId: string, error = ''): Promise<Screen> {
  const rideId = await searchOf(userId);
  const offer = rideId ? await offerForRide(redis, rideId) : null;
  if (!rideId || !offer) return closed('Nothing to decide here', 'This group ride offer has ended. Your own search goes on.');
  const users = await prisma.user.findMany({ where: { id: { in: offer.members.map((m) => m.riderId) } }, select: { id: true, name: true } }).catch(() => []);
  const names = new Map(users.map((u) => [u.id, firstNameOf(u.name)]));
  const view = await offerViewFor(redis, offer, rideId, names);
  if (!view) return closed('Nothing to decide here', 'This group ride offer has ended.');
  if (view.answer) return closed(view.answer === 'join' ? "You're in" : 'You said No thanks', view.answer === 'join' ? "We'll tell you in the chat when your group is set." : 'Your own search goes on.');
  const others = view.riders.filter((r) => !r.you).map((r) => `${r.name}${r.pickup ? ` (${r.pickup})` : ''}`);
  const to = view.stops.filter((s) => s.kind === 'dropoff' && s.you).map((s) => s.address.split(',')[0])[0] ?? '';
  return {
    screen: 'OFFER',
    data: {
      heading: `${others.length} rider${others.length === 1 ? ' is' : 's are'} going your way`,
      body: `${others.join(' and ')} ${others.length === 1 ? 'is' : 'are'} on your road${to ? ` to ${to}` : ''}.`,
      price: `Ride together for ${naira(view.seatPriceNgn)} instead of ${naira(view.ownPriceNgn)}, about ${view.extraMinutes} min more. You save ${naira(view.savedNgn)}. Faces checked.`,
      choices: [
        { id: 'join', title: 'Ride together', description: `Your seat ${naira(view.seatPriceNgn)}` },
        { id: 'decline', title: 'No thanks', description: 'Your own search goes on' },
      ],
      error,
      has_error: Boolean(error),
    },
  };
}

export async function handleGroupOfferFlow(body: FlowRequestBody, userId: string, deps: { redisClient: RedisClient }): Promise<Screen> {
  const action = actionFor(body, { OFFER: 'group_answer' });
  if (body.action !== 'data_exchange' || !action) return groupOfferScreen(deps.redisClient, userId);
  const choice = String(body.data?.['choice'] ?? '');
  if (choice === 'close') return note('All done', 'Nothing more to decide here.');
  if (choice !== 'join' && choice !== 'decline') return groupOfferScreen(deps.redisClient, userId, 'Pick one.');
  const rideId = await searchOf(userId);
  if (!rideId) return note('Nothing to decide here', 'This group ride offer has ended.');
  try {
    const result = await answerGroupOffer(deps.redisClient, rideId, userId, choice);
    if (choice === 'decline') return note('No problem', 'Your own search goes on.');
    if (result.selfieNeeded) {
      await expectGroupSelfie(deps.redisClient, userId);
      return note('Send a selfie', SELFIE_ASK);
    }
    return note("You're in", "We'll tell you in the chat when your group is set.");
  } catch (error) {
    if (error instanceof GroupLiveError) return groupOfferScreen(deps.redisClient, userId, error.message);
    console.error('[group-offer-flow] answer failed', { userId, error: error instanceof Error ? error.message : String(error) });
    return groupOfferScreen(deps.redisClient, userId, 'Could not send that. Try again.');
  }
}
