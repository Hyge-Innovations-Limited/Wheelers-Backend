import { userClient, virtualAccountClient } from '@wheleers/db';
import { QUICK_ACTION_IDS, HISTORY_ROW, REPEAT_ROW, REVERSE_ROW, recentTrips, reversed, buildQuickActions, buildHistoryList, buildRepeatButtons, quickActionsBody, type PastTrip } from '../http/quick-actions';
import { provisionDepositAccount } from '../onboarding/user-onboarding';
import { appendWhatsappConversation } from '../LLM/conversation-store';
import { getRideState, getRideMeta, getAcceptedBid, storePendingRoute, storePendingGeoChoices, clearPendingGeoChoices, clearPendingFarPlace, clearBookingMisses } from '../whatsapp-flows/bid-state';
import type { PendingRouteData } from '../whatsapp-flows/bid-state';
import { signFlowToken } from '../whatsapp-flows/encryption';
import { MetaWhatsappRouteDeps } from './deps';
import { createOffersFormChatHooks, sendCurrentOffers } from './ride-card';
import { replyAndLog, sendInteractive, sendMetaReply, sendMetaText } from './send';
import { BOOKING_START_PROMPT, planRouteSafe, sendSearchStarted, sendTripConfirmation } from './trip';
import { sendWalletPageButton } from './wallet';

export const supportContact = () => process.env['SUPPORT_CONTACT']?.trim() || null;

/**
 * The menu. One message with ONE button. With the Quick Actions form published,
 * the button opens it and every action is a screen inside (quick-actions-flow.ts);
 * otherwise it is WhatsApp's list picker, and numbered text if that is refused.
 */
export async function sendQuickActions(deps: MetaWhatsappRouteDeps, user: { id: string }, phone: string, activeRideId: string | null, log: string, greeting = false, bodyText?: string): Promise<void> {
  const who = await userClient.findById(user.id).catch(() => null);
  const firstName = who?.name?.trim().split(/\s+/)[0] || null;
  if (deps.whatsappQuickActionsFlowId) {
    const sent = await sendInteractive(deps, phone, {
      type: 'flow',
      body: { text: bodyText ?? quickActionsBody(greeting, firstName) },
      action: {
        name: 'flow',
        parameters: {
          flow_message_version: '3',
          flow_id: deps.whatsappQuickActionsFlowId,
          flow_token: signFlowToken(`menu:${user.id}`, deps.jwtSecret),
          flow_cta: 'Quick Actions',
          // data_exchange: opening calls our endpoint, so the menu is built for right now.
          flow_action: 'data_exchange',
        },
      },
    });
    if (sent) {
      await appendWhatsappConversation(deps.redisClient, phone, [{ role: 'user', content: log }, { role: 'assistant', content: bodyText ?? '[sent the quick actions form]' }]);
      return;
    }
  }
  const trips = await recentTrips(user.id, 1);
  const menu = buildQuickActions({
    bodyText,
    greeting,
    firstName,
    lastTrip: trips[0] ?? null,
    busy: Boolean(activeRideId),
    supportContact: supportContact(),
  });
  await appendWhatsappConversation(deps.redisClient, phone, [{ role: 'user', content: log }, { role: 'assistant', content: '[sent the quick actions menu]' }]);
  if (await sendInteractive(deps, phone, menu)) return;
  const rows = (menu['action'] as { sections: Array<{ rows: Array<{ title: string }> }> }).sections.flatMap((section) => section.rows);
  await sendMetaReply(deps, phone, `${greeting ? 'Hey!' : ''}What would you like to do?\n\n${rows.map((row, index) => `*${index + 1}.* ${row.title}`).join('\n')}\n\nReply with the number.`);
  await storePendingGeoChoices(deps.redisClient, user.id, { context: 'menu', options: rows.map((row) => ({ lat: 0, lng: 0, address: row.title })) }).catch(() => undefined);
}

/**
 * Book the same trip again — or the same trip backwards. The past ride's
 * coordinates are re-planned so distance and fare are today's, then it lands
 * on the ordinary trip card: Confirm or edit, then the price. Nothing new
 * after that.
 */
export async function bookFromPastTrip(deps: MetaWhatsappRouteDeps, user: { id: string }, phone: string, log: string, trip: PastTrip, backwards: boolean): Promise<void> {
  const { pickup, destination, stops } = backwards ? reversed(trip) : trip;
  const planned = await planRouteSafe(deps, pickup, destination, stops);
  if (!planned) {
    await replyAndLog(deps, phone, log, `I could not plan that trip today — a road may have changed.\n\nType it instead, e.g. *from ${shortAddress(pickup.address)} to ${shortAddress(destination.address)}*`);
    return;
  }
  await Promise.all([clearPendingGeoChoices(deps.redisClient, user.id), clearPendingFarPlace(deps.redisClient, user.id), clearBookingMisses(deps.redisClient, user.id)].map((step) => step.catch(() => undefined)));
  const route: PendingRouteData = {
    pickupLat: pickup.lat, pickupLng: pickup.lng, pickupAddress: pickup.address,
    destLat: destination.lat, destLng: destination.lng, destAddress: destination.address,
    stops,
    distanceKm: planned.distanceKm,
    durationSeconds: planned.durationSeconds,
    suggestedFareNgn: planned.suggestedFareNgn,
    minOfferNgn: planned.minOfferNgn,
    ratePerKmNgn: planned.ratePerKmNgn,
    route: planned.geometry,
  };
  await storePendingRoute(deps.redisClient, user.id, route);
  const said = await sendTripConfirmation(deps, user, phone, route, backwards ? '*Same trip, back the other way*' : '*Same trip as before*');
  await appendWhatsappConversation(deps.redisClient, phone, [{ role: 'user', content: log }, { role: 'assistant', content: said }]);
}

export const shortAddress = (address: string) => address.split(',')[0]?.trim() || address;

/** A tap on the menu, the history list, or a Repeat/Reverse button. */
export async function handleQuickAction(deps: MetaWhatsappRouteDeps, user: { id: string }, phone: string, replyId: string, incoming: string, activeRideId: string | null): Promise<void> {
  const log = incoming || `[tapped ${replyId}]`;
  const tripFrom = async (id: string) => (await recentTrips(user.id, 10)).find((trip) => trip.rideId === id) ?? null;

  if (replyId === QUICK_ACTION_IDS.addMoney) return sendWalletPageButton(deps, user, phone, log, 'deposit');
  if (replyId === QUICK_ACTION_IDS.withdraw) return sendWalletPageButton(deps, user, phone, log, 'withdraw');
  if (replyId === QUICK_ACTION_IDS.support) {
    const contact = supportContact();
    return replyAndLog(deps, phone, log, contact ? `*Wheelers support*\n\n${contact}\n\nA person will reply as soon as they can.` : 'Support is not set up yet — reply here and we will see it.');
  }
  if (replyId === QUICK_ACTION_IDS.currentTrip) {
    if (!activeRideId) return sendQuickActions(deps, user, phone, null, log);
    const state = await getRideState(deps.redisClient, activeRideId).catch(() => null);
    if (state === 'confirmed' || state === 'in_progress') {
      const accepted = await getAcceptedBid(deps.redisClient, activeRideId).catch(() => null);
      return replyAndLog(deps, phone, log, `*${accepted?.driverName ?? 'Your driver'}* is ${state === 'in_progress' ? 'driving you now' : 'on the way'}.\n\nYour ride card is just above — tap *Track live trip* on it, or reply *cancel*.`);
    }
    const said = await sendCurrentOffers(deps, phone, activeRideId);
    await appendWhatsappConversation(deps.redisClient, phone, [{ role: 'user', content: log }, { role: 'assistant', content: said }]);
    return;
  }

  // Everything below starts a booking: not while one is live.
  if (activeRideId) {
    return replyAndLog(deps, phone, log, 'You already have a ride going. Reply *cancel* to end it first, then book again.');
  }
  if (replyId === QUICK_ACTION_IDS.book) return replyAndLog(deps, phone, log, BOOKING_START_PROMPT);
  if (replyId === QUICK_ACTION_IDS.history) {
    const trips = await recentTrips(user.id, 5);
    const list = buildHistoryList(trips);
    if (!list) return replyAndLog(deps, phone, log, `No rides yet — your first one goes here.\n\n${BOOKING_START_PROMPT}`);
    await appendWhatsappConversation(deps.redisClient, phone, [{ role: 'user', content: log }, { role: 'assistant', content: `[sent ${trips.length} past rides to pick from]` }]);
    if (!await sendInteractive(deps, phone, list)) {
      await sendMetaReply(deps, phone, `Your recent rides:\n\n${trips.map((trip, index) => `*${index + 1}.* ${shortAddress(trip.pickup.address)} → ${shortAddress(trip.destination.address)}`).join('\n')}\n\nReply with the number to book it again.`);
      await storePendingGeoChoices(deps.redisClient, user.id, { context: 'history', options: trips.map((trip) => ({ lat: 0, lng: 0, address: trip.rideId })) }).catch(() => undefined);
    }
    return;
  }
  if (replyId === QUICK_ACTION_IDS.repeat || replyId === QUICK_ACTION_IDS.reverse) {
    const [last] = await recentTrips(user.id, 1);
    if (!last) return replyAndLog(deps, phone, log, `No completed ride to repeat yet.\n\n${BOOKING_START_PROMPT}`);
    return bookFromPastTrip(deps, user, phone, log, last, replyId === QUICK_ACTION_IDS.reverse);
  }
  const picked = HISTORY_ROW.exec(replyId);
  if (picked) {
    const trip = await tripFrom(picked[1]!);
    if (!trip) return replyAndLog(deps, phone, log, 'That ride is not in your recent history any more. Reply *menu* to see the list again.');
    await appendWhatsappConversation(deps.redisClient, phone, [{ role: 'user', content: log }, { role: 'assistant', content: `[offered Repeat / Reverse for ${trip.rideId}]` }]);
    if (!await sendInteractive(deps, phone, buildRepeatButtons(trip, '*This ride*'))) await bookFromPastTrip(deps, user, phone, log, trip, false);
    return;
  }
  const again = REPEAT_ROW.exec(replyId) ?? REVERSE_ROW.exec(replyId);
  if (again) {
    const trip = await tripFrom(again[1]!);
    if (!trip) return replyAndLog(deps, phone, log, 'That ride is not in your recent history any more. Reply *menu* to see the list again.');
    return bookFromPastTrip(deps, user, phone, log, trip, REVERSE_ROW.test(replyId));
  }
}

/**
 * What the offers FORM needs the chat to say. Only the two things a rider must
 * keep: the confirmed driver's details, and the Add money button. Changing the
 * price, declining and cancelling are answered inside the form and cost the
 * chat nothing.
 */
/**
 * What the Quick Actions form needs from the chat: the offers hooks (its OFFERS
 * screen is the offers form), where support points, the Withdraw button, and a
 * way to open an account number for a rider who has none yet.
 */
export function createQuickActionsChatHooks(deps: MetaWhatsappRouteDeps) {
  return {
    ...createOffersFormChatHooks(deps),
    supportContact,
    /** A bid placed inside a form (Edit trip or Quick Actions): the chat gets its one message, the See driver offers button. */
    onBidPlaced: async (userId: string, rideId: string, offerNgn: number): Promise<void> => {
      const [who, meta] = await Promise.all([userClient.findById(userId).catch(() => null), getRideMeta(deps.redisClient, rideId)]);
      if (!who?.phone || !meta) return;
      const said = await sendSearchStarted(deps, { id: userId }, who.phone, {
        pickupAddress: meta.pickupAddress, destAddress: meta.destinationAddress, stopAddresses: (meta.stops ?? []).map((stop) => stop.address), offerNgn,
      });
      await appendWhatsappConversation(deps.redisClient, who.phone, [{ role: 'user', content: `[bid ₦${offerNgn.toLocaleString()} in the form]` }, { role: 'assistant', content: said }]);
    },
    /** Book a ride from Quick Actions: booking is the chat's job — one clear prompt, no menu under it. */
    onBookInChat: async (userId: string): Promise<void> => {
      const phone = (await userClient.findById(userId).catch(() => null))?.phone;
      if (!phone) return;
      const prompt = `Where are you going?\n\n${BOOKING_START_PROMPT}`;
      await sendMetaText(deps, phone, prompt);
      await appendWhatsappConversation(deps.redisClient, phone, [{ role: 'user', content: '[chose Book a ride in Quick Actions]' }, { role: 'assistant', content: prompt }]);
    },
    onWithdraw: async (userId: string): Promise<void> => {
      const phone = (await userClient.findById(userId).catch(() => null))?.phone;
      if (!phone) return;
      await sendWalletPageButton(deps, { id: userId }, phone, '[chose Withdraw in Quick Actions]', 'withdraw');
    },
    ensureDepositAccount: async (userId: string) => {
      const who = await userClient.findById(userId).catch(() => null);
      await provisionDepositAccount(deps.paymentsClient, userId, who?.name ?? undefined, who?.phone ?? undefined).catch(() => undefined);
      const account = await virtualAccountClient.findByUserId(userId).catch(() => null);
      return account ? { bankName: account.bankName, accountNumber: account.accountNumber, accountName: account.accountName } : null;
    },
  };
}

