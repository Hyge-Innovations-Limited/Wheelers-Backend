import { clearBookingStage, clearPendingFarPlace, getPendingFarPlace, getPendingRoute, setBookingStage, storePendingRoute } from '../../whatsapp-flows/bid-state';
import { replyAndLog } from '../../whatsapp/send';
import { BOOKING_START_PROMPT, addStopToTrip, askForNewEnd, askForStop, changeEndOrAsk, confirmTripAndQuote, removeStopFromTrip, replanPendingRoute, sendEditTripForm, sendTripConfirmation, sendTripEditMenu, startBookingOver } from '../../whatsapp/trip';
import { CANCELLATION_REASON_PROMPT, extractEditAddress, isAffirmativeReply, isCancelCommand, isEditDestinationCommand, isEditPickupCommand, parseCounterOffer } from '../../whatsapp/parse';
import { bookingIntentGroq, takePickedPlace } from '../../whatsapp/places';
import { appendWhatsappConversation, getWhatsappConversation } from '../../LLM/conversation-store';
import { classifyBookingIntent } from '../../LLM/booking-intent';
import type { StageContext } from '../stage-context';

/** The awaitingTripConfirm stage of the chat, carved out of handleIncomingMetaMessage. Returns true when it answered the message. */
export async function awaitingTripConfirm(ctx: StageContext): Promise<boolean> {
  const { deps, incomingMessage, msgInfo, phone, user } = ctx;

    const trip = await getPendingRoute(deps.redisClient, user.id);
    if (!trip) {
      await clearBookingStage(deps.redisClient, user.id);
      await replyAndLog(deps, phone, incomingMessage, `That trip has expired.\n\n${BOOKING_START_PROMPT}`);
      return true;
    }

    if (isCancelCommand(incomingMessage)) {
      await setBookingStage(deps.redisClient, user.id, 'awaiting_cancel_reason');
      await replyAndLog(deps, phone, incomingMessage, CANCELLATION_REASON_PROMPT);
      return true;
    }

    // A tap on "which one did you mean?" after a typed change.
    const picked = await takePickedPlace(deps, user.id, incomingMessage, ['edit_pickup', 'edit_destination', 'stop']);
    if (picked) {
      if (picked.context === 'stop') await addStopToTrip(deps, user, phone, incomingMessage, trip, picked.address, picked);
      else await replanPendingRoute(deps, user, phone, incomingMessage, trip, picked.context === 'edit_pickup' ? 'pickup' : 'destination', picked.address, picked);
      return true;
    }

    // A place in another city is waiting on a yes/no.
    const farPlace = await getPendingFarPlace(deps.redisClient, user.id);
    if (farPlace) {
      await clearPendingFarPlace(deps.redisClient, user.id);
      if (isAffirmativeReply(incomingMessage)) {
        await replanPendingRoute(deps, user, phone, incomingMessage, trip, farPlace.field, farPlace.address, { ...farPlace, farConfirmed: true });
        return true;
      }
    }

    if (isEditPickupCommand(incomingMessage) || isEditDestinationCommand(incomingMessage)) {
      const field = isEditPickupCommand(incomingMessage) ? 'pickup' : 'destination';
      const inlineAddress = extractEditAddress(incomingMessage);
      if (inlineAddress) await replanPendingRoute(deps, user, phone, incomingMessage, trip, field, inlineAddress);
      else await askForNewEnd(deps, user, phone, incomingMessage, trip, field);
      return true;
    }
    if (/^edit(\s+(my\s+)?trip)?[\s!.]*$/i.test(incomingMessage.trim())) {
      if (await sendEditTripForm(deps, user.id, phone, false)) {
        await appendWhatsappConversation(deps.redisClient, phone, [{ role: 'user', content: incomingMessage }, { role: 'assistant', content: '[sent the Edit trip form]' }]);
        return true;
      }
      const said = await sendTripEditMenu(deps, phone, trip);
      await appendWhatsappConversation(deps.redisClient, phone, [{ role: 'user', content: incomingMessage }, { role: 'assistant', content: said }]);
      return true;
    }
    const removeTyped = /^remove\s+stop\s*(\d)?[\s!.]*$/i.exec(incomingMessage.trim());
    if (removeTyped) {
      await removeStopFromTrip(deps, user, phone, incomingMessage, trip, removeTyped[1] ? Number(removeTyped[1]) : undefined);
      return true;
    }

    // They skipped ahead and named a price: the trip on screen is the trip
    // they are pricing. Confirm it and let the price step read the number.
    if (parseCounterOffer(incomingMessage) !== null) {
      await storePendingRoute(deps.redisClient, user.id, { ...trip, confirmed: true });
      await setBookingStage(deps.redisClient, user.id, 'awaiting_price');
      await ctx.replay({ ...msgInfo, messageId: '', replyId: undefined });
      return true;
    }
    if (isAffirmativeReply(incomingMessage)) {
      await confirmTripAndQuote(deps, user, phone, incomingMessage, trip);
      return true;
    }

    const wanted = await classifyBookingIntent(bookingIntentGroq(deps), {
      step: 'confirm',
      message: incomingMessage,
      context: { pickupAddress: trip.pickupAddress, destinationAddress: trip.destAddress, stopAddresses: (trip.stops ?? []).map((stop) => stop.address) },
      recentMessages: await getWhatsappConversation(deps.redisClient, phone),
    });

    if (wanted.intent === 'confirm') {
      await confirmTripAndQuote(deps, user, phone, incomingMessage, trip);
      return true;
    }
    if (wanted.intent === 'change_pickup' || wanted.intent === 'change_destination') {
      const field = wanted.intent === 'change_pickup' ? 'pickup' : 'destination';
      if (wanted.address) await changeEndOrAsk(deps, user, phone, incomingMessage, trip, field, wanted.address);
      else await askForNewEnd(deps, user, phone, incomingMessage, trip, field);
      return true;
    }
    if (wanted.intent === 'add_stop') {
      // They named it → add it right here. They did not → the form is the shortest way to say where.
      if (wanted.address) await addStopToTrip(deps, user, phone, incomingMessage, trip, wanted.address);
      else if (await sendEditTripForm(deps, user.id, phone, true)) {
        await appendWhatsappConversation(deps.redisClient, phone, [{ role: 'user', content: incomingMessage }, { role: 'assistant', content: '[sent the Edit trip form]' }]);
      } else await askForStop(deps, user, phone, incomingMessage, trip);
      return true;
    }
    if (wanted.intent === 'remove_stop') {
      await removeStopFromTrip(deps, user, phone, incomingMessage, trip);
      return true;
    }
    if (wanted.intent === 'cancel') {
      await setBookingStage(deps.redisClient, user.id, 'awaiting_cancel_reason');
      await replyAndLog(deps, phone, incomingMessage, CANCELLATION_REASON_PROMPT);
      return true;
    }
    if (wanted.intent === 'restart') {
      await startBookingOver(deps, user, phone, incomingMessage);
      return true;
    }

    // Anything else: the trip again, with the three things they can do.
    const said = await sendTripConfirmation(deps, user, phone, trip,
      wanted.intent === 'help' ? 'No wahala — this is the trip I have for you' : 'I did not catch that — this is the trip I have for you');
    await appendWhatsappConversation(deps.redisClient, phone, [{ role: 'user', content: incomingMessage }, { role: 'assistant', content: said }]);
    return true;
    return false;
}
