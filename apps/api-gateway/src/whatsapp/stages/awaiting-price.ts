import { clearBookingMisses, clearBookingStage, clearPendingFarPlace, clearPendingRoute, getPendingFarPlace, getPendingRoute, setBookingStage } from '../../whatsapp-flows/bid-state';
import { startGroupRideFlow } from '../../whatsapp/group';
import { CANCELLATION_REASON_PROMPT, extractEditAddress, isAffirmativeReply, isCancelCommand, isEditDestinationCommand, isEditPickupCommand, parseCounterOffer } from '../../whatsapp/parse';
import { addStopToTrip, askForStop, changeEndOrAsk, removeStopFromTrip, replanPendingRoute, sendSearchStarted, startBookingOver } from '../../whatsapp/trip';
import { appendWhatsappConversation, getWhatsappConversation } from '../../LLM/conversation-store';
import { replyAndLog, sendFloorNudge, sendMetaReply } from '../../whatsapp/send';
import { bookingIntentGroq, replyWithWayOut, takePickedPlace } from '../../whatsapp/places';
import { classifyBookingIntent } from '../../LLM/booking-intent';
import { publishWhatsappRide } from '../../rides/whatsapp-ride.service';
import type { StageContext } from '../stage-context';

/** The awaitingPrice stage of the chat, carved out of handleIncomingMetaMessage. Returns true when it answered the message. */
export async function awaitingPrice(ctx: StageContext): Promise<boolean> {
  const { deps, incomingMessage, phone, user } = ctx;

    const pendingRoute = await getPendingRoute(deps.redisClient, user.id);
    if (pendingRoute) {
      // ── "group" — switch this quote into the group-ride flow ──
      if (/^group(\s*ride)?$/i.test(incomingMessage.trim())) {
        await clearPendingRoute(deps.redisClient, user.id);
        await startGroupRideFlow(deps, user, phone, incomingMessage, {
          pickup: {
            lat: pendingRoute.pickupLat,
            lng: pendingRoute.pickupLng,
            address: pendingRoute.pickupAddress,
          },
          destination: {
            lat: pendingRoute.destLat,
            lng: pendingRoute.destLng,
            address: pendingRoute.destAddress,
          },
        });
        return true;
      }

      // ── Direct edit commands: "edit pickup" / "edit destination" ──
      if (isEditPickupCommand(incomingMessage) || isEditDestinationCommand(incomingMessage)) {
        const isPickup = isEditPickupCommand(incomingMessage);
        const inlineAddress = extractEditAddress(incomingMessage);

        if (inlineAddress) {
          await replanPendingRoute(deps, user, phone, incomingMessage, pendingRoute, isPickup ? 'pickup' : 'destination', inlineAddress);
          return true;
        }

        // No inline address — ask for it
        const label = isPickup ? 'pickup' : 'destination';
        const current = isPickup ? pendingRoute.pickupAddress : pendingRoute.destAddress;
        await setBookingStage(deps.redisClient, user.id, isPickup ? 'editing_pickup' : 'editing_destination');
        const reply = `Current ${label}: *${current}*\n\nSend a new ${label} location pin or type the address.`;
        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: incomingMessage },
          { role: 'assistant', content: reply },
        ]);
        await sendMetaReply(deps, phone, reply);
        return true;
      }

      // ── Cancel during awaiting_price ──
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

      // A tap on "which one did you mean?" for a corrected address.
      const pickedEdit = await takePickedPlace(deps, user.id, incomingMessage, ['edit_pickup', 'edit_destination']);
      if (pickedEdit) {
        await replanPendingRoute(deps, user, phone, incomingMessage, pendingRoute,
          pickedEdit.context === 'edit_pickup' ? 'pickup' : 'destination', pickedEdit.address, pickedEdit);
        return true;
      }

      // A place in another city is waiting on a yes/no.
      const farPlace = await getPendingFarPlace(deps.redisClient, user.id);
      if (farPlace) {
        await clearPendingFarPlace(deps.redisClient, user.id);
        if (isAffirmativeReply(incomingMessage)) {
          await replanPendingRoute(deps, user, phone, incomingMessage, pendingRoute, farPlace.field, farPlace.address, { ...farPlace, farConfirmed: true });
          return true;
        }
        // Anything else is read normally below — usually the corrected address.
      }

      const offerNgn = parseCounterOffer(incomingMessage);

      if (offerNgn === null) {
        // Not a price. Rather than insist on one, find out what they DO want.
        const wanted = await classifyBookingIntent(bookingIntentGroq(deps), {
          step: 'price',
          message: incomingMessage,
          context: { pickupAddress: pendingRoute.pickupAddress, destinationAddress: pendingRoute.destAddress },
          recentMessages: await getWhatsappConversation(deps.redisClient, phone),
        });

        if (wanted.intent === 'change_pickup' || wanted.intent === 'change_destination') {
          const field = wanted.intent === 'change_pickup' ? 'pickup' : 'destination';
          await clearBookingMisses(deps.redisClient, user.id);
          if (wanted.address) {
            await changeEndOrAsk(deps, user, phone, incomingMessage, pendingRoute, field, wanted.address);
            return true;
          }
          const current = field === 'pickup' ? pendingRoute.pickupAddress : pendingRoute.destAddress;
          await setBookingStage(deps.redisClient, user.id, field === 'pickup' ? 'editing_pickup' : 'editing_destination');
          await replyAndLog(deps, phone, incomingMessage,
            `Current ${field}: *${current}*\n\nSend the new ${field} — type the address or share a location pin`);
          return true;
        }

        if (wanted.intent === 'add_stop') {
          await clearBookingMisses(deps.redisClient, user.id);
          if (wanted.address) await addStopToTrip(deps, user, phone, incomingMessage, pendingRoute, wanted.address);
          else await askForStop(deps, user, phone, incomingMessage, pendingRoute);
          return true;
        }
        if (wanted.intent === 'remove_stop') {
          await clearBookingMisses(deps.redisClient, user.id);
          await removeStopFromTrip(deps, user, phone, incomingMessage, pendingRoute);
          return true;
        }

        if (wanted.intent === 'cancel') {
          await clearBookingMisses(deps.redisClient, user.id);
          await setBookingStage(deps.redisClient, user.id, 'awaiting_cancel_reason');
          await replyAndLog(deps, phone, incomingMessage, CANCELLATION_REASON_PROMPT);
          return true;
        }

        if (wanted.intent === 'restart') {
          await startBookingOver(deps, user, phone, incomingMessage);
          return true;
        }

        const pricePrompt = `Minimum: ₦${pendingRoute.minOfferNgn.toLocaleString()}\nSuggested: ₦${pendingRoute.suggestedFareNgn.toLocaleString()}`;

        if (wanted.intent === 'confirm') {
          // Never turn a bare "ok" into a fare — they name the number.
          await replyAndLog(deps, phone, incomingMessage,
            `Almost there — just tell me your price.\n\n${pricePrompt}\n\nSend *${pendingRoute.suggestedFareNgn.toLocaleString()}* to go with the suggested fare, or name your own.`);
          return true;
        }

        if (wanted.intent === 'answer') {
          // The model heard a price we could not read as a number ("two
          // thousand five hundred"). We do not guess amounts.
          await replyAndLog(deps, phone, incomingMessage,
            `I couldn't read that as an amount — please send it in figures, like *${pendingRoute.suggestedFareNgn.toLocaleString()}*.\n\n${pricePrompt}`);
          return true;
        }

        await replyWithWayOut(deps, user, phone, incomingMessage, {
          wantsHelp: wanted.intent === 'help',
          prompt: `Please send a price for your ride.\n\n${pricePrompt}\n\nExample: *${pendingRoute.suggestedFareNgn.toLocaleString()}*`,
          hint: 'Or reply *change pickup*, *change destination* or *cancel*.',
          buttons: ['Change pickup', 'Change destination', 'Cancel ride'],
        });
        return true;
      }

      await clearBookingMisses(deps.redisClient, user.id);

      if (offerNgn < pendingRoute.minOfferNgn) {
        await sendFloorNudge(deps, phone, incomingMessage, offerNgn, pendingRoute.minOfferNgn);
        return true;
      }

      // Publish ride — payment happens when rider accepts a driver. The same
      // step the bidding page takes when they name the price there.
      const published = await publishWhatsappRide(deps, { id: user.id, phone }, pendingRoute, offerNgn);
      if (!published.ok) {
        if (published.code === 'ALREADY_PUBLISHING') return true;
        const reply = published.code === 'BELOW_MINIMUM'
          ? `The lowest price for this trip is ₦${published.minOfferNgn.toLocaleString()}. Send that, or a higher amount.`
          : 'Could not start the search just now. Send your price again to retry.';
        await replyAndLog(deps, phone, incomingMessage, reply);
        return true;
      }

      const searchText = await sendSearchStarted(deps, user, phone, {
        pickupAddress: pendingRoute.pickupAddress,
        destAddress: pendingRoute.destAddress,
        stopAddresses: (pendingRoute.stops ?? []).map((stop) => stop.address),
        offerNgn,
      });
      await appendWhatsappConversation(deps.redisClient, phone, [
        { role: 'user', content: incomingMessage },
        { role: 'assistant', content: searchText },
      ]);
      return true;
    } else {
      // The quote expired (10 minutes) but the stage lingered — the price
      // used to fall through to the chatbot, which answered "3000" as chat.
      await clearBookingStage(deps.redisClient, user.id);
      const reply = 'That quote expired — send your pickup and destination again and we\'ll re-check the price.';
      await appendWhatsappConversation(deps.redisClient, phone, [
        { role: 'user', content: incomingMessage },
        { role: 'assistant', content: reply },
      ]);
      await sendMetaReply(deps, phone, reply);
      return true;
    }
    return false;
}
