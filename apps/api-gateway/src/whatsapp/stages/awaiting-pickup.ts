import { isCancelCommand, looksLikeConversation } from '../../whatsapp/parse';
import { clearBookingMisses, clearBookingStage, clearPendingAreaHint, clearPendingGeoChoices, getPendingAreaHint, getPendingGeoChoices, setBookingStage, setPendingLocation } from '../../whatsapp-flows/bid-state';
import { appendWhatsappConversation, getWhatsappConversation } from '../../LLM/conversation-store';
import { replyAndLog, sendMetaReply } from '../../whatsapp/send';
import { classifyBookingIntent, mightNotBeAnAddress } from '../../LLM/booking-intent';
import { bookingIntentGroq, replyWithWayOut, sendPlaceChoices } from '../../whatsapp/places';
import { startBookingOver } from '../../whatsapp/trip';
import { findPlaceOptions, geocodeAddress, geocodeMissLine, HOME_AREA, outsideServiceAreaMatch } from '../../LLM/geocoding';
import type { StageContext } from '../stage-context';

/** The awaitingPickup stage of the chat, carved out of handleIncomingMetaMessage. Returns true when it answered the message. */
export async function awaitingPickup(ctx: StageContext): Promise<boolean> {
  const { deps, incomingMessage, msgInfo, phone, user } = ctx;

    if (isCancelCommand(incomingMessage)) {
      await clearPendingAreaHint(deps.redisClient, user.id);
      await clearBookingStage(deps.redisClient, user.id);
      const reply = 'Okay, nothing booked. Message me whenever you need a ride.';
      await appendWhatsappConversation(deps.redisClient, phone, [
        { role: 'user', content: incomingMessage },
        { role: 'assistant', content: reply },
      ]);
      await sendMetaReply(deps, phone, reply);
      return true;
    }

    if (mightNotBeAnAddress(incomingMessage)) {
      const pickupStepIntent = await classifyBookingIntent(bookingIntentGroq(deps), {
        step: 'pickup',
        message: incomingMessage,
        context: {},
        recentMessages: await getWhatsappConversation(deps.redisClient, phone),
      });
      if (pickupStepIntent.intent === 'cancel') {
        await clearPendingAreaHint(deps.redisClient, user.id);
        await clearBookingStage(deps.redisClient, user.id);
        await clearBookingMisses(deps.redisClient, user.id).catch(() => undefined);
        await replyAndLog(deps, phone, incomingMessage, 'Okay, nothing booked. Message me whenever you need a ride.');
        return true;
      }
      if (pickupStepIntent.intent === 'restart') {
        await startBookingOver(deps, user, phone, incomingMessage);
        return true;
      }
      if (pickupStepIntent.intent === 'help') {
        await replyWithWayOut(deps, user, phone, incomingMessage, {
          wantsHelp: true,
          prompt: 'Where should your driver pick you up? Type the address or a landmark, or share your location.',
        });
        return true;
      }
    }

    const hint = await getPendingAreaHint(deps.redisClient, user.id);
    const answer = incomingMessage.trim();

    // A tap on the picker (or a typed number) answers "which pickup did you mean?".
    let pickedPickup: { lat: number; lng: number; formattedAddress: string } | null = null;
    if (/^[1-9]$/.test(answer)) {
      const choices = await getPendingGeoChoices(deps.redisClient, user.id);
      const pick = choices?.context === 'pickup' ? choices.options[Number(answer) - 1] : undefined;
      if (pick) {
        await clearPendingGeoChoices(deps.redisClient, user.id);
        pickedPickup = { lat: pick.lat, lng: pick.lng, formattedAddress: pick.address };
      }
    }

    // The question was "whereabouts in X?", so the expected answer is a
    // landmark. Riders often restate the whole trip instead ("I wanna go
    // from Allen"), and geocoding that verbatim asks Google to find a
    // sentence — which it answers with the country. Hand anything that
    // reads like a fresh request back to the intent parser by falling
    // through, rather than treating it as an address.
    if (looksLikeConversation(answer)) {
      await clearPendingAreaHint(deps.redisClient, user.id);
      await clearBookingStage(deps.redisClient, user.id);
      // Deliberately no `return` — execution continues to intent parsing
      // below, which understands this sentence properly.
    } else {

    // "roundabout" on its own geocodes to nothing — it only means something
    // combined with the area they already named. Word order matters more
    // than it looks: measured against Google, "Allen roundabout" resolves to
    // the actual roundabout while "roundabout, Allen" returns ZERO_RESULTS.
    // Area first, then looser fallbacks, then the bare answer in case they
    // typed a full address instead of a landmark.
    const candidates = hint?.area
      ? [`${hint.area} ${answer}`, `${answer}, ${hint.area}`, answer]
      : [answer];

    // A name that exists in several places ("Admiralty" Way AND Road, "Aiyetoro"
    // in Surulere AND Akoka): ask, never assume. Only for a plain answer — when
    // they are answering "whereabouts in Lekki?", the area already narrows it.
    if (!pickedPickup && !hint?.area && !looksLikeConversation(answer)) {
      // Nothing to measure the pickup against yet, so it is searched around
      // the city Wheelers runs in: a street name with namesakes across Nigeria
      // means the one in Lagos. The distance is from the city centre, which
      // means nothing to the rider, so it is not shown.
      const matches = (await findPlaceOptions(deps.googleMapsApiKey, answer, { spokenText: incomingMessage, near: HOME_AREA }))
        .map(({ distanceKm: _fromCentre, ...match }) => match);
      if (matches.length > 1) {
        await sendPlaceChoices(deps, user, phone, incomingMessage, { context: 'pickup', field: 'pickup', typed: answer, candidates: matches });
        return true;
      }
      if (matches.length === 1) pickedPickup = matches[0]!;
    }

    let pickupGeo = pickedPickup;
    for (const candidate of pickedPickup ? [] : candidates) {
      pickupGeo = await geocodeAddress(deps.googleMapsApiKey, candidate, { near: HOME_AREA });
      if (pickupGeo) break;
    }

    if (!pickupGeo) {
      const missLine = outsideServiceAreaMatch(answer)
        ? geocodeMissLine(answer)
        : `I couldn't find "${answer}"${hint?.area ? ` in ${hint.area}` : ''} on the map.`;
      await replyWithWayOut(deps, user, phone, incomingMessage, {
        prompt: `${missLine} Try a nearby landmark or street, or share your location.`,
      });
      return true;
    }

    await setPendingLocation(deps.redisClient, user.id, {
      lat: pickupGeo.lat,
      lng: pickupGeo.lng,
      address: pickupGeo.formattedAddress,
      savedAt: new Date().toISOString(),
      // The hint is cleared below, so the destination they already gave has
      // to travel with the pickup for "yes" to mean anything next turn.
      suggestedDestination: hint?.counterpartAddress || undefined,
    });
    await clearPendingAreaHint(deps.redisClient, user.id);
    await setBookingStage(deps.redisClient, user.id, 'awaiting_destination');

    // They picked the pickup from a list, and told us the destination in the
    // same breath as the trip. Asking them to type "yes" is one message too
    // many: answer the destination step with what they already said.
    if (pickedPickup && hint?.counterpartAddress) {
      await appendWhatsappConversation(deps.redisClient, phone, [
        { role: 'user', content: incomingMessage },
        { role: 'assistant', content: `Pickup: ${pickupGeo.formattedAddress}` },
      ]);
      await ctx.replay({ ...msgInfo, messageId: '', messageBody: hint.counterpartAddress });
      return true;
    }

    // If they already told us where they were going, don't ask again.
    const reply = hint?.counterpartAddress
      ? `Pickup: *${pickupGeo.formattedAddress}*\n\nStill going to *${hint.counterpartAddress}*? Reply *yes*, or send a different destination.`
      : `Pickup: *${pickupGeo.formattedAddress}*\n\nWhere are you going?`;
    await appendWhatsappConversation(deps.redisClient, phone, [
      { role: 'user', content: incomingMessage },
      { role: 'assistant', content: reply },
    ]);
    await sendMetaReply(deps, phone, reply);
    return true;
    }
    return false;
}
