import { CANCELLATION_REASON_PROMPT, isAffirmativeReply, isCancelCommand, looksLikeConversation, stripDirectionPrefix } from '../../whatsapp/parse';
import { clearBookingMisses, clearBookingStage, clearPendingAreaHint, clearPendingFarPlace, clearPendingGeoChoices, clearPendingLocation, getPendingAreaHint, getPendingFarPlace, getPendingGeoChoices, getPendingLocation, setBookingStage, storePendingRoute } from '../../whatsapp-flows/bid-state';
import { appendWhatsappConversation, getWhatsappConversation } from '../../LLM/conversation-store';
import { replyAndLog, sendMetaReply } from '../../whatsapp/send';
import { BookingIntentResult, classifyBookingIntent, mightNotBeAnAddress } from '../../LLM/booking-intent';
import { askIfFarPlaceIsMeant, bookingIntentGroq, replyWithWayOut, sendPlaceChoices } from '../../whatsapp/places';
import { ROUTE_PLAN_FAILED_REPLY, buildGroupSuggestionLine, planRouteSafe, sendQuoteWithPriceButton, startBookingOver } from '../../whatsapp/trip';
import { findPlaceOptions, geocodeMissLine } from '../../LLM/geocoding';
import type { StageContext } from '../stage-context';

/** The awaitingDestination stage of the chat, carved out of handleIncomingMetaMessage. Returns true when it answered the message. */
export async function awaitingDestination(ctx: StageContext): Promise<boolean> {
  const { deps, incomingMessage, msgInfo, phone, user } = ctx;

    if (isCancelCommand(incomingMessage)) {
      await setBookingStage(deps.redisClient, user.id, 'awaiting_cancel_reason');
      const reply = CANCELLATION_REASON_PROMPT;
      await appendWhatsappConversation(deps.redisClient, phone, [
        { role: 'user', content: incomingMessage },
        { role: 'assistant', content: reply },
      ]);
      await sendMetaReply(deps, phone, reply);
      return true;
    }

    // Not every reply here is a destination. Anything that might be more
    // than a place is read for meaning first; a plain place skips the model.
    let destinationStepIntent: BookingIntentResult = { intent: 'answer' };
    if (mightNotBeAnAddress(incomingMessage) && !isAffirmativeReply(incomingMessage)) {
      const soFar = await getPendingLocation(deps.redisClient, user.id);
      destinationStepIntent = await classifyBookingIntent(bookingIntentGroq(deps), {
        step: 'destination',
        message: incomingMessage,
        context: { pickupAddress: soFar?.address },
        recentMessages: await getWhatsappConversation(deps.redisClient, phone),
      });
    }
    if (destinationStepIntent.intent === 'cancel') {
      await setBookingStage(deps.redisClient, user.id, 'awaiting_cancel_reason');
      await replyAndLog(deps, phone, incomingMessage, CANCELLATION_REASON_PROMPT);
      return true;
    }
    if (destinationStepIntent.intent === 'restart') {
      await startBookingOver(deps, user, phone, incomingMessage);
      return true;
    }
    if (destinationStepIntent.intent === 'change_pickup') {
      await clearPendingLocation(deps.redisClient, user.id);
      await clearPendingFarPlace(deps.redisClient, user.id).catch(() => undefined);
      await setBookingStage(deps.redisClient, user.id, 'awaiting_pickup');
      if (!destinationStepIntent.address) {
        await replyAndLog(deps, phone, incomingMessage, 'Sure — where should we pick you up instead? Type the address or share a location pin');
        return true;
      }
      // They named the new pickup in the same breath: answer the pickup step with it.
      // No message id: this is the same WhatsApp message, already de-duplicated once.
      await ctx.replay({ ...msgInfo, messageId: '', messageBody: destinationStepIntent.address });
      return true;
    }
    // 'other' (a question, chatter) carries on below, where small talk is
    // handed to the chatbot as before.
    if (destinationStepIntent.intent === 'help' || destinationStepIntent.intent === 'confirm') {
      await replyWithWayOut(deps, user, phone, incomingMessage, {
        wantsHelp: destinationStepIntent.intent === 'help',
        prompt: 'Where are you going? Type the destination or share a location pin',
        hint: 'Or reply *change pickup*, *start again* or *cancel*.',
        buttons: ['Change pickup', 'Start again', 'Cancel ride'],
      });
      return true;
    }

    const pendingPickup = await getPendingLocation(deps.redisClient, user.id);
    if (!pendingPickup) {
      await clearBookingStage(deps.redisClient, user.id);
      const reply = 'Session expired. Type your pickup and destination like:\n\n*"From [pickup] to [destination]"*\n\nOr share a location pin';
      await appendWhatsappConversation(deps.redisClient, phone, [
        { role: 'user', content: incomingMessage },
        { role: 'assistant', content: reply },
      ]);
      await sendMetaReply(deps, phone, reply);
      return true;
    }

    // We asked them to type "yes" to confirm the destination they named in
    // their first message. Checked before the small-talk filter because
    // "ok" counts as small talk there, and before geocoding because "Yes"
    // is not a place.
    const isAffirmative = /^(yes|yeah|yea|yep|yup|ok|okay|confirm|correct|sure|y)\b/i.test(incomingMessage.trim());

    // "yes" to "that is 311 km away, in another city — really?"
    const heldFarPlace = await getPendingFarPlace(deps.redisClient, user.id);
    if (heldFarPlace) await clearPendingFarPlace(deps.redisClient, user.id);
    const confirmedFarPlace = isAffirmative && heldFarPlace?.field === 'destination' ? heldFarPlace : null;

    const confirmedDestination = isAffirmative && !confirmedFarPlace ? pendingPickup.suggestedDestination?.trim() : undefined;

    if (isAffirmative && !confirmedDestination && !confirmedFarPlace) {
      const reply = `Where are you going? Type the destination or share a pin`;
      await appendWhatsappConversation(deps.redisClient, phone, [
        { role: 'user', content: incomingMessage },
        { role: 'assistant', content: reply },
      ]);
      await sendMetaReply(deps, phone, reply);
      return true;
    }

    // Small talk is not a destination. This stage lives for ten minutes, so
    // a rider returning to an abandoned booking with "Hey wassup" had their
    // greeting geocoded. Leave it to the intent parser and the chatbot, and
    // keep the stage so their next real answer still lands here.
    // "going to X" is an answer, not chat, however the sentence starts.
    const strippedDestination = stripDirectionPrefix(incomingMessage);
    const isDirectionAnswer = strippedDestination !== incomingMessage.trim();
    if (!confirmedDestination && !isDirectionAnswer && looksLikeConversation(incomingMessage)) {
      // deliberately no reply and no return — falls through to intent parsing
    } else {

    // Try to geocode the typed destination
    const typedDestination = confirmedDestination ?? strippedDestination;

    // A bare number answers a pending "which one did you mean?" list.
    let destGeo: { lat: number; lng: number; formattedAddress: string } | null = confirmedFarPlace
      ? { lat: confirmedFarPlace.lat, lng: confirmedFarPlace.lng, formattedAddress: confirmedFarPlace.address }
      : null;
    const pickupPoint = { lat: pendingPickup.lat, lng: pendingPickup.lng };
    if (!destGeo && /^[1-9]$/.test(typedDestination)) {
      const choices = await getPendingGeoChoices(deps.redisClient, user.id);
      const pick = choices?.context === 'destination'
        ? choices.options[Number(typedDestination) - 1]
        : undefined;
      if (pick) {
        await clearPendingGeoChoices(deps.redisClient, user.id);
        destGeo = { lat: pick.lat, lng: pick.lng, formattedAddress: pick.address };
      }
    }

    if (!destGeo) {
      // "Whereabouts in Lekki?" → "the mall": search inside the area first.
      const destHint = await getPendingAreaHint(deps.redisClient, user.id).catch(() => null);
      const areaHint = destHint?.kind === 'destination' ? destHint.area?.trim() : undefined;
      const narrowed = areaHint && !typedDestination.toLowerCase().includes(areaHint.toLowerCase())
        ? `${typedDestination}, ${areaHint}`
        : typedDestination;
      // Lean the search towards the pickup: "7 Osaro Isokpan" from Akoka is
      // the one in Lagos, not the better-known street of that name in Benin.
      let candidates = await findPlaceOptions(deps.googleMapsApiKey, narrowed, { near: pickupPoint, spokenText: incomingMessage });
      if (candidates.length === 0 && narrowed !== typedDestination) {
        candidates = await findPlaceOptions(deps.googleMapsApiKey, typedDestination, { near: pickupPoint, spokenText: incomingMessage });
      }

      // Ambiguous place ("Aiyetoro" is in Surulere AND Akoka) — ask, don't
      // assume. A query that pins the area returns a single candidate.
      if (candidates.length > 1) {
        await sendPlaceChoices(deps, user, phone, incomingMessage, {
          context: 'destination',
          field: 'destination',
          typed: typedDestination,
          candidates,
        });
        return true;
      }

      destGeo = candidates[0] ?? null;
    }

    if (!destGeo) {
      await replyWithWayOut(deps, user, phone, incomingMessage, {
        prompt: `${geocodeMissLine(typedDestination)}\n\nPlease type a more specific destination — add the area or a landmark — or share a location pin`,
        hint: 'Or reply *change pickup*, *start again* or *cancel*.',
        buttons: ['Change pickup', 'Start again', 'Cancel ride'],
      });
      return true;
    }

    // Destination geocoded — plan route
    const pickup = { lat: pendingPickup.lat, lng: pendingPickup.lng, address: pendingPickup.address };
    const destination = { lat: destGeo.lat, lng: destGeo.lng, address: destGeo.formattedAddress };

    // Still in another city after leaning towards the pickup? Ask before quoting.
    if (!confirmedFarPlace && await askIfFarPlaceIsMeant(deps, user, phone, incomingMessage, 'destination', destination, pickupPoint)) {
      return true;
    }
    await clearBookingMisses(deps.redisClient, user.id).catch(() => undefined);

    const plannedRoute = await planRouteSafe(deps, pickup, destination);
    if (!plannedRoute) {
      // Keep the stage and pending pickup so their next answer still lands here
      const reply = ROUTE_PLAN_FAILED_REPLY;
      await appendWhatsappConversation(deps.redisClient, phone, [
        { role: 'user', content: incomingMessage },
        { role: 'assistant', content: reply },
      ]);
      await sendMetaReply(deps, phone, reply);
      return true;
    }

    await clearPendingLocation(deps.redisClient, user.id);
    await clearPendingAreaHint(deps.redisClient, user.id).catch(() => {});
    await clearPendingGeoChoices(deps.redisClient, user.id).catch(() => {});
    await clearBookingStage(deps.redisClient, user.id);
    const distanceKm = plannedRoute.distanceKm;
    const durationMin = Math.ceil(plannedRoute.durationSeconds / 60);
    const suggestedFare = plannedRoute.suggestedFareNgn;
    const minFare = plannedRoute.minOfferNgn;

    await storePendingRoute(deps.redisClient, user.id, {
      pickupLat: pickup.lat,
      pickupLng: pickup.lng,
      pickupAddress: pickup.address,
      destLat: destination.lat,
      destLng: destination.lng,
      destAddress: destination.address,
      distanceKm,
      durationSeconds: plannedRoute.durationSeconds,
      suggestedFareNgn: suggestedFare,
      minOfferNgn: minFare,
      ratePerKmNgn: plannedRoute.ratePerKmNgn,
      route: plannedRoute.geometry,
    });
    await setBookingStage(deps.redisClient, user.id, 'awaiting_price');

    const groupSuggestion = await buildGroupSuggestionLine(user.id, pickup, destination);
    const reply = [
      `Pickup: *${pickup.address}*`,
      ``,
      `Destination: *${destination.address}*`,
      ``,
      `${distanceKm.toFixed(1)} km · ~${durationMin} min`,
      `Minimum fare: ₦${minFare.toLocaleString()}`,
      `Suggested fare: ₦${suggestedFare.toLocaleString()}`,
      ``,
      `Negotiate your price and we'll find you a driver!`,
      `Send your offer (e.g. *${suggestedFare.toLocaleString()}* or *${Math.round(suggestedFare * 0.85).toLocaleString()}*)`,
    ].join('\n') + groupSuggestion;

    await appendWhatsappConversation(deps.redisClient, phone, [
      { role: 'user', content: incomingMessage },
      { role: 'assistant', content: reply },
    ]);
    await sendQuoteWithPriceButton(deps, user, phone, reply);
    return true;
    }
    return false;
}
