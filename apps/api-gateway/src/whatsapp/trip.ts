import { GoogleMapsRoutePlanner } from '@wheleers/config';
import { createWalletPageToken, RIDE_PAGE_TOKEN_TTL_SECONDS } from '../auth/local';
import { appendWhatsappConversation } from '../LLM/conversation-store';
import { geocodeMissLine } from '../LLM/geocoding';
import { findPlaceOptions, kmBetween, SAME_CITY_KM, SAME_PLACE_KM } from '../LLM/geocoding';
import { findGroupRideSuggestion } from '../group-ride/suggestion';
import { getActiveRide, clearPendingAreaHint, clearPendingLocation, setBookingStage, clearBookingStage, storePendingRoute, getPendingRoute, clearPendingRoute, clearPendingGeoChoices, clearPendingFarPlace, clearBookingMisses, markOffersMessageSent } from '../whatsapp-flows/bid-state';
import { MAX_CHAT_STOPS } from '../whatsapp-flows/bid-state';
import type { PendingRouteData, RouteStop } from '../whatsapp-flows/bid-state';
import { signFlowToken } from '../whatsapp-flows/encryption';
import { sendBidPlacedMessage } from '../whatsapp-flows/whatsapp-notifier';
import { tripLines as sharedTripLines } from '../whatsapp-flows/trip-text';
import { MetaWhatsappRouteDeps } from './deps';
import { CANCELLATION_REASON_PROMPT } from './parse';
import { askIfFarPlaceIsMeant, sendPlaceChoices } from './places';
import { clip, replyAndLog, sendInteractive, sendMetaLinkButton, sendMetaReply } from './send';

/**
 * Two points of a trip that are the same place — Google answers those with an
 * empty route ("missing route distance"), which read as an outage. Named here
 * so the reply can say which two, and ask which to change.
 */
/** Google returns no route for two points this close — one building, one gate. */
export const NO_ROUTE_KM = 0.05;

export function samePlacePair(
  pickup: { lat: number; lng: number },
  destination: { lat: number; lng: number },
  stops: RouteStop[] = [],
  withinKm: number = SAME_PLACE_KM,
): [string, string] | null {
  const points = [
    { label: 'pickup', ...pickup },
    ...stops.map((stop, index) => ({ label: `stop ${index + 1}`, lat: stop.lat, lng: stop.lng })),
    { label: 'destination', ...destination },
  ];
  for (let a = 0; a < points.length; a++) {
    for (let b = a + 1; b < points.length; b++) {
      if (kmBetween(points[a]!, points[b]!) < withinKm) return [points[a]!.label, points[b]!.label];
    }
  }
  return null;
}

/** "Your pickup and destination are the same place" — with what to do about it. */
export function samePlaceReply(pair: [string, string], address: string): string {
  return `Your ${pair[0]} and your ${pair[1]} are the same place: *${address}*.\n\nSend a different ${pair[1]}, or say which one to change — e.g. *change pickup to Ikeja City Mall*.`;
}

export async function planRouteSafe(
  deps: MetaWhatsappRouteDeps,
  pickup: { lat: number; lng: number; address: string },
  destination: { lat: number; lng: number; address: string },
  stops: RouteStop[] = [],
): Promise<Awaited<ReturnType<GoogleMapsRoutePlanner['planRoute']>> | null> {
  // Only the truly identical case is refused here (a 300 m hop is still a ride); the edit
  // paths ask about anything under SAME_PLACE_KM before they get this far.
  if (samePlacePair(pickup, destination, stops, NO_ROUTE_KM)) {
    console.info('[whatsapp] route not planned — two points are the same place', { pickup: pickup.address, destination: destination.address });
    return null;
  }
  try {
    return await deps.routePlanner.planRoute({ origin: pickup, destination, ...(stops.length ? { stops } : {}) });
  } catch (error) {
    console.warn('[whatsapp] route planning failed', {
      pickup: pickup.address,
      destination: destination.address,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export const ROUTE_PLAN_FAILED_REPLY =
  'I could not find a driving route between those points.\n\nCheck the addresses, or share a location pin.';

/**
 * Every normal booking is a potential group ride. Appended to the fare quote
 * when open group requests share this corridor; empty string otherwise, so
 * the suggestion never blocks or delays the normal flow's message.
 */
export async function buildGroupSuggestionLine(
  userId: string,
  pickup: { lat: number; lng: number },
  destination: { lat: number; lng: number },
): Promise<string> {
  const suggestion = await findGroupRideSuggestion(userId, pickup, destination);
  if (!suggestion) return '';
  return `\n\n${suggestion.count} rider${suggestion.count === 1 ? ' is' : 's are'} already heading your way. Reply *group* to share the car — you set your own seat price, always cheaper than riding alone!`;
}

/** The rider's own link to the bidding page: name a price, watch offers, accept one. */
export function ridePageUrl(deps: MetaWhatsappRouteDeps, userId: string): string | null {
  if (!deps.appBaseUrl) return null;
  const token = createWalletPageToken(userId, 'ride', deps.jwtSecret, RIDE_PAGE_TOKEN_TTL_SECONDS);
  return `${deps.appBaseUrl.replace(/\/+$/, '')}/widget/ride/ride.html#t=${encodeURIComponent(token)}`;
}

/**
 * A fare quote, with a button to name the price on the bidding page. Typing
 * the price in the chat still works — it is the fallback for a phone that will
 * not open the page — so the text says so.
 */
export async function sendQuoteWithPriceButton(
  deps: MetaWhatsappRouteDeps,
  user: { id: string },
  phone: string,
  quote: string,
): Promise<string> {
  // Every quote in this file comes through here — so this is the one place
  // that says: a trip is CONFIRMED before a price is asked for. A changed trip
  // is stored without `confirmed`, and is shown for confirmation again.
  const trip = await getPendingRoute(deps.redisClient, user.id).catch(() => null);
  if (trip && !trip.confirmed) {
    const firstLine = quote.split('\n')[0] ?? '';
    return sendTripConfirmation(deps, user, phone, trip, /^\*[^*]+\*$/.test(firstLine) ? firstLine : undefined);
  }

  // With the trip form on, bidding is in the form — never the web page. This is
  // the fallback for a phone that could not open it: the price is typed here.
  const url = deps.whatsappEditTripFlowId ? null : ridePageUrl(deps, user.id);
  if (!url) {
    await sendMetaReply(deps, phone, quote);
    return quote;
  }
  await sendMetaLinkButton(deps, phone,
    quote.replace('Send your offer (e.g.', 'Tap *Set your price* — or just type your offer (e.g.'),
    'Set your price', url);
  return quote;
}

/**
 * The one chat message a search needs. With the offers form: "your bid is in" with
 * the button that opens it — and no offers message ever follows, the form shows
 * them live. Without the form: "Finding you a driver", and offers follow in the chat.
 */
export async function sendSearchStarted(
  deps: MetaWhatsappRouteDeps,
  user: { id: string },
  phone: string,
  trip: { pickupAddress: string; destAddress: string; offerNgn: number; stopAddresses?: string[] },
): Promise<string> {
  if (deps.metaAccessToken && deps.metaPhoneNumberId) {
    const notifier = { metaAccessToken: deps.metaAccessToken, metaPhoneNumberId: deps.metaPhoneNumberId, offersFormFlowId: deps.whatsappOffersFormFlowId, flowTokenSecret: deps.jwtSecret };
    if (await sendBidPlacedMessage(notifier, phone, user.id, trip)) {
      const rideId = await getActiveRide(deps.redisClient, user.id).catch(() => null);
      if (rideId) await markOffersMessageSent(deps.redisClient, rideId).catch(() => undefined);
      return `[your bid of ₦${trip.offerNgn.toLocaleString()} is in — sent the See driver offers button]`;
    }
  }
  const url = ridePageUrl(deps, user.id);
  const lines = [
    `*Finding you a driver!*`,
    ``,
    ...sharedTripLines({ pickupAddress: trip.pickupAddress, destAddress: trip.destAddress, stops: (trip.stopAddresses ?? []).map((address) => ({ address })) }),
    ``,
    `Your offer: ₦${trip.offerNgn.toLocaleString()}`,
    ``,
    `Drivers' offers will land right here in this chat — tap the one you want.`,
  ];
  const text = lines.join('\n');
  // The button is only for changing the price; offers are never on that page.
  if (url) await sendMetaLinkButton(deps, phone, text, 'Change my price', url);
  else await sendMetaReply(deps, phone, text);
  return text;
}

export const BOOKING_START_PROMPT =
  'Send your *pickup* and your *destination*, e.g.\n*From Ikeja City Mall to Unilag gate, Yaba*\n\nOr share your pickup location pin first, then type the destination.';

/** Throw the half-made booking away and begin again. */
export async function startBookingOver(
  deps: MetaWhatsappRouteDeps,
  user: { id: string },
  phone: string,
  incomingMessage: string,
): Promise<void> {
  await Promise.all([
    clearPendingRoute(deps.redisClient, user.id),
    clearPendingLocation(deps.redisClient, user.id),
    clearPendingAreaHint(deps.redisClient, user.id),
    clearPendingGeoChoices(deps.redisClient, user.id),
    clearPendingFarPlace(deps.redisClient, user.id),
    clearBookingMisses(deps.redisClient, user.id),
    clearBookingStage(deps.redisClient, user.id),
  ].map((step) => step.catch(() => undefined)));
  await replyAndLog(deps, phone, incomingMessage, `No problem — let's start fresh.\n\n${BOOKING_START_PROMPT}`);
}

/**
 * Change one end of a quoted trip and re-quote it. Every way of asking for
 * that — "edit destination …", a sentence the model understood, a bare address
 * resent at the price step, a "yes" to a far-away place — lands here.
 */
export async function replanPendingRoute(
  deps: MetaWhatsappRouteDeps,
  user: { id: string },
  phone: string,
  incomingMessage: string,
  pendingRoute: PendingRouteData,
  field: 'pickup' | 'destination',
  address: string,
  /** A place the rider has already settled on: picked from the list, or a far one they said yes to. */
  chosen?: { lat: number; lng: number; address: string; farConfirmed?: boolean },
): Promise<void> {
  const isPickup = field === 'pickup';
  const otherEnd = isPickup
    ? { lat: pendingRoute.destLat, lng: pendingRoute.destLng }
    : { lat: pendingRoute.pickupLat, lng: pendingRoute.pickupLng };

  let geo: { lat: number; lng: number; formattedAddress: string } | null = chosen
    ? { lat: chosen.lat, lng: chosen.lng, formattedAddress: chosen.address }
    : null;
  if (!geo) {
    const matches = await findPlaceOptions(deps.googleMapsApiKey, address, { spokenText: incomingMessage, near: otherEnd });
    if (matches.length > 1) {
      // "No, Caleb law" has more than one answer too — ask, never guess.
      await sendPlaceChoices(deps, user, phone, incomingMessage, {
        context: isPickup ? 'edit_pickup' : 'edit_destination',
        field,
        typed: address,
        candidates: matches,
      });
      return;
    }
    geo = matches[0] ?? null;
  }
  if (!geo) {
    await replyAndLog(deps, phone, incomingMessage,
      `${geocodeMissLine(address)}\n\nPlease try a more specific ${field} address or share a location pin\n\nYour booking is unchanged.`);
    return;
  }

  const place = { lat: geo.lat, lng: geo.lng, address: geo.formattedAddress };
  if (!chosen?.farConfirmed && await askIfFarPlaceIsMeant(deps, user, phone, incomingMessage, field, place, otherEnd)) return;

  const pickup = isPickup ? place : { lat: pendingRoute.pickupLat, lng: pendingRoute.pickupLng, address: pendingRoute.pickupAddress };
  const destination = isPickup ? { lat: pendingRoute.destLat, lng: pendingRoute.destLng, address: pendingRoute.destAddress } : place;

  const clash = samePlacePair(pickup, destination, pendingRoute.stops);
  if (clash) {
    await setBookingStage(deps.redisClient, user.id, isPickup ? 'editing_pickup' : 'editing_destination');
    await replyAndLog(deps, phone, incomingMessage, `${samePlaceReply(clash, place.address)}\n\nYour booking is unchanged.`);
    return;
  }

  const plannedRoute = await planRouteSafe(deps, pickup, destination, pendingRoute.stops);
  if (!plannedRoute) {
    await replyAndLog(deps, phone, incomingMessage, `${ROUTE_PLAN_FAILED_REPLY}\n\nYour booking is unchanged.`);
    return;
  }

  const suggestedFare = plannedRoute.suggestedFareNgn;
  const minFare = plannedRoute.minOfferNgn;
  await storePendingRoute(deps.redisClient, user.id, {
    pickupLat: pickup.lat,
    pickupLng: pickup.lng,
    pickupAddress: pickup.address,
    destLat: destination.lat,
    destLng: destination.lng,
    destAddress: destination.address,
    distanceKm: plannedRoute.distanceKm,
    durationSeconds: plannedRoute.durationSeconds,
    suggestedFareNgn: suggestedFare,
    minOfferNgn: minFare,
    ratePerKmNgn: plannedRoute.ratePerKmNgn,
    route: plannedRoute.geometry,
    stops: pendingRoute.stops,
  });
  await setBookingStage(deps.redisClient, user.id, 'awaiting_price');
  await clearBookingMisses(deps.redisClient, user.id).catch(() => undefined);

  await quoteAndLog(deps, user, phone, incomingMessage, [
    `*${isPickup ? 'Pickup updated!' : 'Destination updated!'}*`,
    ``,
    `Pickup: *${pickup.address}*`,
    ``,
    `Destination: *${destination.address}*`,
    ``,
    `${plannedRoute.distanceKm.toFixed(1)} km · ~${Math.ceil(plannedRoute.durationSeconds / 60)} min`,
    `Minimum fare: ₦${minFare.toLocaleString()}`,
    `Suggested fare: ₦${suggestedFare.toLocaleString()}`,
    ``,
    `Send your offer (e.g. *${suggestedFare.toLocaleString()}* or *${Math.round(suggestedFare * 0.85).toLocaleString()}*)`,
  ].join('\n'));
}

/* ── confirm the trip before the price: Confirm · Add a stop · Edit ─────── */

export const TRIP_CONFIRM_ID = 'trip_confirm';

export const TRIP_ADD_STOP_ID = 'trip_add_stop';

export const TRIP_EDIT_ID = 'trip_edit';

export const TRIP_EDIT_PICKUP_ID = 'trip_edit_pickup';

export const TRIP_EDIT_DESTINATION_ID = 'trip_edit_destination';

/** "Which one is it?" after a lone place: the place waits here for the tap. */
export const TRIP_DRAFT_PICKUP_ID = 'trip_draft_pickup';

export const TRIP_DRAFT_DESTINATION_ID = 'trip_draft_destination';

export const TRIP_DRAFT_STOP_ID = 'trip_draft_stop';

export const endDraftKey = (userId: string) => `whatsapp:user:${userId}:end_draft`;

/**
 * Does the message itself say WHICH end it is about? "from X" and "pick me at X" name
 * the pickup; "to X", "going to X", "drop me at X" the destination. "Change it to X"
 * and a bare place name say neither — the model used to guess destination, and a
 * rider who meant the pickup got the wrong trip.
 */
export function namedEnd(message: string): 'pickup' | 'destination' | null {
  const m = ` ${message.trim().toLowerCase()} `;
  if (/\b(pick\s*-?\s*up|pick me|from|origin|start(ing)? point|where i am|i am at|i'm at)\b/.test(m)) return 'pickup';
  if (/\b(destination|drop|dropoff|drop-off|going to|heading to|take me to|headed to|dest)\b/.test(m) || /^\s*to\s+/.test(m)) return 'destination';
  return null;
}

/** The lone place is kept, and the rider is asked which end (or stop) it is. */
export async function askWhichEnd(deps: MetaWhatsappRouteDeps, user: { id: string }, phone: string, incomingMessage: string, trip: PendingRouteData, address: string): Promise<void> {
  await deps.redisClient.set(endDraftKey(user.id), JSON.stringify({ address }), 600);
  const body = [
    `Got *${address}*. Which one is it?`,
    ``,
    `Pickup now: *${trip.pickupAddress}*`,
    ``,
    `Destination now: *${trip.destAddress}*`,
  ].join('\n');
  const buttons = [
    { id: TRIP_DRAFT_PICKUP_ID, title: 'New pickup' },
    { id: TRIP_DRAFT_DESTINATION_ID, title: 'New destination' },
    ...((trip.stops?.length ?? 0) < MAX_CHAT_STOPS ? [{ id: TRIP_DRAFT_STOP_ID, title: 'Add as a stop' }] : []),
  ];
  await appendWhatsappConversation(deps.redisClient, phone, [{ role: 'user', content: incomingMessage }, { role: 'assistant', content: body }]);
  const sent = await sendInteractive(deps, phone, { type: 'button', body: { text: body }, action: { buttons: buttons.map((button) => ({ type: 'reply', reply: button })) } });
  if (!sent) await sendMetaReply(deps, phone, `${body}\n\nReply *pickup*, *destination* or *stop*.`);
}

/**
 * A place typed with no end named: is it a refinement of one of the ends already on
 * the trip? "No, Caleb law" when the destination is Caleb University shares a word
 * with it — that is the destination, corrected. A place that shares nothing with
 * either end is new, and only the rider knows which end it is.
 */
export const PLACE_FILLER = new Set(['lagos', 'nigeria', 'street', 'road', 'close', 'avenue', 'estate', 'state', 'bus', 'stop', 'junction', 'the', 'and', 'of']);

export function refinedEnd(address: string, trip: PendingRouteData): 'pickup' | 'destination' | null {
  const words = (text: string) => new Set(text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((word) => word.length >= 4 && !PLACE_FILLER.has(word)));
  const typed = words(address);
  const overlaps = (end: string) => [...words(end)].some((word) => typed.has(word));
  const pickup = overlaps(trip.pickupAddress);
  const destination = overlaps(trip.destAddress);
  if (pickup === destination) return null;
  return pickup ? 'pickup' : 'destination';
}

/** Where a change with no end named goes: the end the message names, the end it refines, or the question. */
export async function changeEndOrAsk(deps: MetaWhatsappRouteDeps, user: { id: string }, phone: string, incomingMessage: string, trip: PendingRouteData, modelSaid: 'pickup' | 'destination', address: string): Promise<void> {
  const field = namedEnd(incomingMessage) ?? refinedEnd(address, trip);
  if (field) return replanPendingRoute(deps, user, phone, incomingMessage, trip, field, address);
  // The model picked an end for a place that names none and refines neither — that is the guess that put a
  // rider's new pickup in as the destination. Ask.
  void modelSaid;
  return askWhichEnd(deps, user, phone, incomingMessage, trip, address);
}

export const TRIP_CANCEL_ID = 'trip_cancel';

export const TRIP_REMOVE_STOP = /^trip_remove_stop_(\d)$/;

/** Pickup, every stop in order, destination — the same lines on the card, the quote and the edit list. */
/** The trip as text — see trip-text.ts, the one template every message uses. */
export function tripLines(trip: PendingRouteData): string[] {
  return sharedTripLines({ pickupAddress: trip.pickupAddress, destAddress: trip.destAddress, stops: trip.stops });
}

/**
 * "Is this your trip?" — shown after the destination is known and after every
 * change, BEFORE any price is asked for. Three taps: it is right, add a stop,
 * or change something. Typing works too ("add a stop at Yaba market", "no, pick
 * me at the gate") — the step's handler reads it.
 */
export async function sendTripConfirmation(
  deps: MetaWhatsappRouteDeps,
  user: { id: string },
  phone: string,
  trip: PendingRouteData,
  headline?: string,
): Promise<string> {
  await setBookingStage(deps.redisClient, user.id, 'awaiting_trip_confirm');

  // WhatsApp allows a message reply buttons OR one form button — never both. With
  // the form published, the card is ONE message with ONE button: confirming,
  // editing and stops all happen in the form, and the price step follows it.
  if (deps.whatsappEditTripFlowId) {
    const formCard = [
      headline ?? '*Check your trip*',
      ``,
      ...tripLines(trip),
      ``,
      `${trip.distanceKm.toFixed(1)} km · ~${Math.ceil(trip.durationSeconds / 60)} min · suggested fare ₦${trip.suggestedFareNgn.toLocaleString()}`,
      ``,
      `Tap *${TRIP_FORM_CTA}* — confirm it as it is, change the pickup or destination, or add a stop. All in one place.`,
      ``,
      `_Form not opening? Reply_ *yes* _to confirm, or just type the change, e.g._ add a stop at Yaba market`,
    ].join('\n');
    if (await sendTripForm(deps, user.id, phone, formCard, TRIP_FORM_CTA)) return formCard;
  }

  const canAddStop = (trip.stops?.length ?? 0) < MAX_CHAT_STOPS;
  const body = [
    headline ?? '*Check your trip*',
    ``,
    ...tripLines(trip),
    ``,
    `${trip.distanceKm.toFixed(1)} km · ~${Math.ceil(trip.durationSeconds / 60)} min · suggested fare ₦${trip.suggestedFareNgn.toLocaleString()}`,
    ``,
    `All correct? Tap *Confirm trip*. To change anything tap *Edit trip* — or just type it, e.g. _add a stop at Yaba market_.`,
  ].join('\n');

  const buttons = [
    { id: TRIP_CONFIRM_ID, title: 'Confirm trip' },
    ...(canAddStop ? [{ id: TRIP_ADD_STOP_ID, title: 'Add a stop' }] : []),
    { id: TRIP_EDIT_ID, title: 'Edit trip' },
  ];
  const sent = await sendInteractive(deps, phone, {
    type: 'button',
    body: { text: body.slice(0, 1024) },
    action: { buttons: buttons.map((button) => ({ type: 'reply', reply: button })) },
  });
  if (!sent) await sendMetaReply(deps, phone, `${body}\n\nReply *confirm*, *add stop* or *edit*.`);
  return body;
}

/** The "Edit trip" sheet: WhatsApp's own picker, one row per thing that can change. */
export async function sendTripEditMenu(deps: MetaWhatsappRouteDeps, phone: string, trip: PendingRouteData): Promise<string> {
  const stops = trip.stops ?? [];
  const rows = [
    { id: TRIP_EDIT_PICKUP_ID, title: 'Change pickup', description: clip(trip.pickupAddress, 72) },
    { id: TRIP_EDIT_DESTINATION_ID, title: 'Change destination', description: clip(trip.destAddress, 72) },
    ...(stops.length < MAX_CHAT_STOPS ? [{ id: TRIP_ADD_STOP_ID, title: 'Add a stop', description: 'A place to pass through on the way' }] : []),
    ...stops.map((stop, index) => ({ id: `trip_remove_stop_${index + 1}`, title: `Remove stop ${index + 1}`, description: clip(stop.address, 72) })),
    { id: TRIP_CANCEL_ID, title: 'Cancel booking', description: 'Throw this trip away' },
  ];
  const body = `*Edit your trip*\n\n${tripLines(trip).join('\n')}\n\nTap *Choose* and pick what to change.`;
  const sent = await sendInteractive(deps, phone, {
    type: 'list',
    body: { text: body.slice(0, 1024) },
    action: { button: 'Choose', sections: [{ title: 'What to change', rows }] },
  });
  if (!sent) {
    await sendMetaReply(deps, phone, `${body}\n\nType what to change — e.g. *edit pickup Unilag gate*, *edit destination Yaba*, *add a stop at Shoprite*${stops.length ? ', *remove stop 1*' : ''}.`);
  }
  return body;
}

/** 20 characters — WhatsApp's limit for a form button. */
export const TRIP_FORM_CTA = 'Confirm or edit trip';

/**
 * A message whose button opens the trip form (edit-trip-flow.ts), filled with
 * the trip as it stands. False when it could not be sent, so the caller carries
 * on with reply buttons in the chat.
 */
export async function sendTripForm(deps: MetaWhatsappRouteDeps, userId: string, phone: string, body: string, cta: string): Promise<boolean> {
  if (!deps.whatsappEditTripFlowId) return false;
  return sendInteractive(deps, phone, {
    type: 'flow',
    body: { text: body.slice(0, 1024) },
    action: {
      name: 'flow',
      parameters: {
        flow_message_version: '3',
        flow_id: deps.whatsappEditTripFlowId,
        flow_token: signFlowToken(`edit:${userId}`, deps.jwtSecret),
        flow_cta: cta.slice(0, 20),
        // data_exchange: opening calls our endpoint's INIT, so the boxes arrive filled in.
        flow_action: 'data_exchange',
      },
    },
  });
}

/**
 * They ASKED to edit (typed "edit", "add a stop", or tapped a button on a card
 * sent before the form existed): a short message with the form's button. The
 * normal path needs no such message — the trip card's own button is the form.
 */
export async function sendEditTripForm(deps: MetaWhatsappRouteDeps, userId: string, phone: string, addingStop: boolean): Promise<boolean> {
  return sendTripForm(deps, userId, phone,
    addingStop
      ? '*Add your stop* — tap below and type it in a Stop box. You can change the pickup or destination there too.\n\n_Form not opening? Just type it here, e.g._ add a stop at Yaba market'
      : '*Edit your trip* — pickup, stops and destination, all in one place.\n\n_Form not opening? Just type the change here, e.g._ pick me at Unilag gate',
    addingStop ? 'Add a stop' : 'Edit trip');
}

/** The trip is right: now, and only now, the price. */
export async function confirmTripAndQuote(
  deps: MetaWhatsappRouteDeps,
  user: { id: string },
  phone: string,
  incomingMessage: string,
  trip: PendingRouteData,
): Promise<void> {
  await storePendingRoute(deps.redisClient, user.id, { ...trip, confirmed: true });
  await setBookingStage(deps.redisClient, user.id, 'awaiting_price');
  await clearBookingMisses(deps.redisClient, user.id).catch(() => undefined);
  await quoteAndLog(deps, user, phone, incomingMessage, [
    `*Trip confirmed*`,
    ``,
    ...tripLines(trip),
    ``,
    `${trip.distanceKm.toFixed(1)} km · ~${Math.ceil(trip.durationSeconds / 60)} min`,
    `Minimum fare: ₦${trip.minOfferNgn.toLocaleString()}`,
    `Suggested fare: ₦${trip.suggestedFareNgn.toLocaleString()}`,
    ``,
    `Send your offer (e.g. *${trip.suggestedFareNgn.toLocaleString()}* or *${Math.round(trip.suggestedFareNgn * 0.85).toLocaleString()}*)`,
  ].join('\n'));
}

/** Re-plan the same ends with a different list of stops, and show the trip again. */
export async function replanWithStops(
  deps: MetaWhatsappRouteDeps,
  user: { id: string },
  phone: string,
  incomingMessage: string,
  trip: PendingRouteData,
  stops: RouteStop[],
  headline: string,
): Promise<void> {
  const pickup = { lat: trip.pickupLat, lng: trip.pickupLng, address: trip.pickupAddress };
  const destination = { lat: trip.destLat, lng: trip.destLng, address: trip.destAddress };
  const planned = await planRouteSafe(deps, pickup, destination, stops);
  if (!planned) {
    await replyAndLog(deps, phone, incomingMessage, `I could not find a driving route through that stop. Your trip is unchanged — try a different place, or share a location pin`);
    return;
  }
  const next: PendingRouteData = {
    ...trip,
    stops,
    distanceKm: planned.distanceKm,
    durationSeconds: planned.durationSeconds,
    suggestedFareNgn: planned.suggestedFareNgn,
    minOfferNgn: planned.minOfferNgn,
    ratePerKmNgn: planned.ratePerKmNgn,
    route: planned.geometry,
    confirmed: false,
    offerNgn: undefined,
  };
  await storePendingRoute(deps.redisClient, user.id, next);
  await clearBookingMisses(deps.redisClient, user.id).catch(() => undefined);
  const said = await sendTripConfirmation(deps, user, phone, next, headline);
  await appendWhatsappConversation(deps.redisClient, phone, [
    { role: 'user', content: incomingMessage },
    { role: 'assistant', content: said },
  ]);
}

export const ADD_STOP_PROMPT = 'Where do you want to stop?\n\nType the place — e.g. *"Yaba market"* or *"Shoprite Ikeja"* — or share a location pin\n\nReply *back* to leave the trip as it is.';

export async function askForStop(deps: MetaWhatsappRouteDeps, user: { id: string }, phone: string, incomingMessage: string, trip: PendingRouteData): Promise<void> {
  if ((trip.stops?.length ?? 0) >= MAX_CHAT_STOPS) {
    await replyAndLog(deps, phone, incomingMessage, `A trip can have up to ${MAX_CHAT_STOPS} stops, and yours has ${MAX_CHAT_STOPS}. Remove one first — tap *Edit trip*.`);
    return;
  }
  await setBookingStage(deps.redisClient, user.id, 'adding_stop');
  await replyAndLog(deps, phone, incomingMessage, ADD_STOP_PROMPT);
}

/**
 * Add a stop by name (looked up like every other place: Places first, the
 * picker when there is more than one answer) or as a place already settled on
 * (picked from the list, or a shared pin).
 */
export async function addStopToTrip(
  deps: MetaWhatsappRouteDeps,
  user: { id: string },
  phone: string,
  incomingMessage: string,
  trip: PendingRouteData,
  typed: string,
  chosen?: RouteStop,
): Promise<void> {
  const stops = trip.stops ?? [];
  if (stops.length >= MAX_CHAT_STOPS) {
    await askForStop(deps, user, phone, incomingMessage, trip);
    return;
  }
  const pickup = { lat: trip.pickupLat, lng: trip.pickupLng };

  // Only the three fields: a picked place arrives with the picker's bookkeeping on it,
  // and whatever is stored here is sent to drivers as the stop.
  let stop: RouteStop | null = chosen ? { lat: chosen.lat, lng: chosen.lng, address: chosen.address } : null;
  if (!stop) {
    const matches = await findPlaceOptions(deps.googleMapsApiKey, typed, { spokenText: incomingMessage, near: pickup });
    if (matches.length > 1) {
      await setBookingStage(deps.redisClient, user.id, 'adding_stop');
      await sendPlaceChoices(deps, user, phone, incomingMessage, { context: 'stop', field: 'stop', typed, candidates: matches });
      return;
    }
    stop = matches[0] ? { lat: matches[0].lat, lng: matches[0].lng, address: matches[0].formattedAddress } : null;
  }
  if (!stop) {
    await setBookingStage(deps.redisClient, user.id, 'adding_stop');
    await replyAndLog(deps, phone, incomingMessage, `${geocodeMissLine(typed)}\n\nTry the stop again with the area or a landmark, share a pin, or reply *back*.`);
    return;
  }

  // A stop in another city is a wrong match, not a plan.
  const awayKm = Math.round(kmBetween(pickup, stop));
  if (awayKm > SAME_CITY_KM) {
    await setBookingStage(deps.redisClient, user.id, 'adding_stop');
    await replyAndLog(deps, phone, incomingMessage, `I found *${stop.address}* — but that is about ${awayKm.toLocaleString()} km from your pickup, in another city.\n\nSend the stop again with the area — e.g. *"Shoprite, Ikeja"* — or reply *back*.`);
    return;
  }
  const samePlace = [
    { label: 'your pickup', lat: trip.pickupLat, lng: trip.pickupLng },
    { label: 'your destination', lat: trip.destLat, lng: trip.destLng },
    ...stops.map((existing, index) => ({ label: `stop ${index + 1}`, lat: existing.lat, lng: existing.lng })),
  ].find((place) => kmBetween(place, stop!) < SAME_PLACE_KM);
  if (samePlace) {
    await setBookingStage(deps.redisClient, user.id, 'adding_stop');
    await replyAndLog(deps, phone, incomingMessage, `*${stop.address}* is the same place as ${samePlace.label}. Send a different stop, or reply *back*.`);
    return;
  }

  await replanWithStops(deps, user, phone, incomingMessage, trip, [...stops, stop], `*Stop added*`);
}

export async function removeStopFromTrip(
  deps: MetaWhatsappRouteDeps,
  user: { id: string },
  phone: string,
  incomingMessage: string,
  trip: PendingRouteData,
  /** 1-based. Omitted with one stop on the trip = that one. */
  position?: number,
): Promise<void> {
  const stops = trip.stops ?? [];
  if (stops.length === 0) {
    const said = await sendTripConfirmation(deps, user, phone, trip, 'Your trip has no stops');
    await appendWhatsappConversation(deps.redisClient, phone, [{ role: 'user', content: incomingMessage }, { role: 'assistant', content: said }]);
    return;
  }
  const index = (position ?? (stops.length === 1 ? 1 : 0)) - 1;
  if (!stops[index]) {
    const said = await sendTripEditMenu(deps, phone, trip);      // more than one stop and they did not say which
    await appendWhatsappConversation(deps.redisClient, phone, [{ role: 'user', content: incomingMessage }, { role: 'assistant', content: said }]);
    return;
  }
  await replanWithStops(deps, user, phone, incomingMessage, trip, stops.filter((_, at) => at !== index), `*Stop removed*`);
}

/** Ask for the new pickup / destination; the existing editing steps take it from there (Places + the picker). */
export async function askForNewEnd(deps: MetaWhatsappRouteDeps, user: { id: string }, phone: string, incomingMessage: string, trip: PendingRouteData, field: 'pickup' | 'destination'): Promise<void> {
  await setBookingStage(deps.redisClient, user.id, field === 'pickup' ? 'editing_pickup' : 'editing_destination');
  await replyAndLog(deps, phone, incomingMessage,
    `Current ${field}: *${field === 'pickup' ? trip.pickupAddress : trip.destAddress}*\n\nType the new ${field} — a name is enough, I'll show you the matches — or share a location pin`);
}

/**
 * A tap on the trip card or the Edit sheet. Handled by what was tapped, not by
 * the step the chat thinks it is on: those messages stay tappable, and a rider
 * who confirmed and THEN taps "Edit trip" on the card above means it.
 */
export async function handleTripTap(
  deps: MetaWhatsappRouteDeps,
  user: { id: string },
  phone: string,
  incomingMessage: string,
  replyId: string,
  hasActiveRide: boolean,
): Promise<void> {
  if (hasActiveRide) {
    await replyAndLog(deps, phone, incomingMessage, 'Drivers are already looking at this trip. To change it, reply *cancel* and send the new trip.');
    return;
  }
  const trip = await getPendingRoute(deps.redisClient, user.id);
  if (!trip) {
    await clearBookingStage(deps.redisClient, user.id);
    await replyAndLog(deps, phone, incomingMessage, `That trip has expired.\n\n${BOOKING_START_PROMPT}`);
    return;
  }
  await clearPendingGeoChoices(deps.redisClient, user.id).catch(() => undefined);

  if (replyId === TRIP_CONFIRM_ID) return confirmTripAndQuote(deps, user, phone, incomingMessage, trip);

  // Edit / Add a stop: the form when there is one — every change in one place, one message back.
  if ((replyId === TRIP_EDIT_ID || replyId === TRIP_ADD_STOP_ID) && await sendEditTripForm(deps, user.id, phone, replyId === TRIP_ADD_STOP_ID)) {
    await setBookingStage(deps.redisClient, user.id, 'awaiting_trip_confirm');     // typing still works while the form is open
    await appendWhatsappConversation(deps.redisClient, phone, [
      { role: 'user', content: incomingMessage },
      { role: 'assistant', content: '[sent the Edit trip form]' },
    ]);
    return;
  }
  if (replyId === TRIP_ADD_STOP_ID) return askForStop(deps, user, phone, incomingMessage, trip);
  if (replyId === TRIP_EDIT_PICKUP_ID) return askForNewEnd(deps, user, phone, incomingMessage, trip, 'pickup');
  if (replyId === TRIP_EDIT_DESTINATION_ID) return askForNewEnd(deps, user, phone, incomingMessage, trip, 'destination');
  if (replyId === TRIP_DRAFT_PICKUP_ID || replyId === TRIP_DRAFT_DESTINATION_ID || replyId === TRIP_DRAFT_STOP_ID) {
    const raw = await deps.redisClient.get(endDraftKey(user.id)).catch(() => null);
    await deps.redisClient.del(endDraftKey(user.id)).catch(() => undefined);
    let draft: { address: string } | null = null;
    try { draft = raw ? (JSON.parse(raw) as { address: string }) : null; } catch { draft = null; }
    if (!draft?.address) {
      const said = await sendTripConfirmation(deps, user, phone, trip, 'That place has expired — this is the trip I have for you');
      await appendWhatsappConversation(deps.redisClient, phone, [{ role: 'user', content: incomingMessage }, { role: 'assistant', content: said }]);
      return;
    }
    if (replyId === TRIP_DRAFT_STOP_ID) return addStopToTrip(deps, user, phone, incomingMessage, trip, draft.address);
    return replanPendingRoute(deps, user, phone, incomingMessage, trip, replyId === TRIP_DRAFT_PICKUP_ID ? 'pickup' : 'destination', draft.address);
  }
  if (replyId === TRIP_CANCEL_ID) {
    await setBookingStage(deps.redisClient, user.id, 'awaiting_cancel_reason');
    return replyAndLog(deps, phone, incomingMessage, CANCELLATION_REASON_PROMPT);
  }
  const remove = TRIP_REMOVE_STOP.exec(replyId);
  if (remove) return removeStopFromTrip(deps, user, phone, incomingMessage, trip, Number(remove[1]));

  // TRIP_EDIT_ID, or a row from a newer version of the sheet.
  await setBookingStage(deps.redisClient, user.id, 'awaiting_trip_confirm');
  const said = await sendTripEditMenu(deps, phone, trip);
  await appendWhatsappConversation(deps.redisClient, phone, [{ role: 'user', content: incomingMessage }, { role: 'assistant', content: said }]);
}

/** replyAndLog for a fare quote: same record, plus the "Set your price" button. */
export async function quoteAndLog(
  deps: MetaWhatsappRouteDeps,
  user: { id: string },
  phone: string,
  userMessage: string,
  quote: string,
): Promise<void> {
  // Logged AFTER sending: an unconfirmed trip goes out as the confirmation card, not this quote.
  const said = await sendQuoteWithPriceButton(deps, user, phone, quote);
  await appendWhatsappConversation(deps.redisClient, phone, [
    { role: 'user', content: userMessage },
    { role: 'assistant', content: said },
  ]);
}

