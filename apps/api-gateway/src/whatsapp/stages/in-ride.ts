import { cleanupRideKeys, clearAcceptedSeats, clearActiveRide, clearPendingAccept, getAcceptedBid, getGroupSeat, getGroupSeatMembers, getLastBatch, getPendingAccept, getRideMeta, getRideState, recordAcceptedSeat, setActiveRide, setBookingStage, storePendingRoute } from '../../whatsapp-flows/bid-state';
import { CANCELLATION_REASON_PROMPT, extractEditAddress, isCancelCommand, isEditDestinationCommand, isEditPickupCommand, isMoreCommand, parseAcceptCommand, parseCounterOffer } from '../../whatsapp/parse';
import { replyAndLog, sendMetaLinkButton, sendMetaReply } from '../../whatsapp/send';
import { sendQuickActions } from '../../whatsapp/menu';
import { acceptOfferInChat, sendCurrentOffers, sendRideTopupButton } from '../../whatsapp/ride-card';
import { CHANGE_PRICE_REPLY_ID } from '../../whatsapp-flows/whatsapp-notifier';
import { ROUTE_PLAN_FAILED_REPLY, planRouteSafe, ridePageUrl, sendQuoteWithPriceButton } from '../../whatsapp/trip';
import { appendWhatsappConversation } from '../../LLM/conversation-store';
import { geocodeAddress, geocodeMissLine } from '../../LLM/geocoding';
import { rideClient, walletClient } from '@wheleers/db';
import { RideCancelledEvent, RideOfferAcceptedEvent } from '@wheleers/kafka-schemas';
import { offerKey } from '../../rides/whatsapp-ride.service';
import { depositNeededFor, validateRiderOffer } from '@wheleers/config';
import type { StageContext } from '../stage-context';

/** The inRide stage of the chat, carved out of handleIncomingMetaMessage. Returns true when it answered the message. */
export async function inRide(ctx: StageContext): Promise<boolean> {
  const { deps, incomingMessage, msgInfo, phone, tappedOffer, user } = ctx;
  // The route only reaches this stage with an active ride; the guard lives there.
  const activeRideId = ctx.activeRideId;
  if (!activeRideId) return false;

    // ── Ride already confirmed/in progress — only allow cancel ──
    const rideState = await getRideState(deps.redisClient, activeRideId).catch(() => null);
    const confirmedStates = ['confirmed', 'in_progress', 'driver_assigned'];
    if (rideState && confirmedStates.includes(rideState)) {
      if (isCancelCommand(incomingMessage)) {
        await setBookingStage(deps.redisClient, user.id, 'awaiting_cancel_reason');
        await sendMetaReply(deps, phone, CANCELLATION_REASON_PROMPT);
        return true;
      }
      // Quiet mode. From confirmed to complete, whatever they type gets the same short
      // answer and a menu of two (Your current trip, Add money) — no model, no booking
      // parser, no wallet chat. "cancel" above and SOS on the card still work.
      const accepted = await getAcceptedBid(deps.redisClient, activeRideId).catch(() => null);
      const driverName = accepted?.driverName ?? 'Your driver';
      const reply = rideState === 'in_progress'
        ? `*${driverName}* is driving you now.\n\nYour ride card is above — tap *Track live trip* on it. Reply *cancel* if you need to.`
        : `*${driverName}* is on the way.\n\nYour ride card is above — tap *Track live trip* on it. Reply *cancel* if you need to.`;
      await sendQuickActions(deps, user, phone, activeRideId, incomingMessage, false, reply);
      return true;
    }

    // ── Tapped an offer: that is the whole decision ──
    if (tappedOffer) {
      await acceptOfferInChat(deps, user, phone, incomingMessage, activeRideId, tappedOffer.key, tappedOffer.shownPriceNgn);
      return true;
    }
    if (msgInfo.replyId === CHANGE_PRICE_REPLY_ID) {
      const url = ridePageUrl(deps, user.id);
      const meta = await getRideMeta(deps.redisClient, activeRideId);
      const reply = `Your price is ₦${(meta?.offerNgn ?? 0).toLocaleString()}. Type a new one here (e.g. *${(Math.ceil(((meta?.offerNgn ?? 0) * 1.1) / 100) * 100).toLocaleString()}*)${url ? ' — or tap below to set it' : ''}. Every driver looking at your request sees it.`;
      await appendWhatsappConversation(deps.redisClient, phone, [
        { role: 'user', content: incomingMessage },
        { role: 'assistant', content: reply },
      ]);
      if (url) await sendMetaLinkButton(deps, phone, reply, 'Change my price', url);
      else await sendMetaReply(deps, phone, reply);
      return true;
    }

    // ── Edit pickup / destination during active ride ──
    if (isEditPickupCommand(incomingMessage) || isEditDestinationCommand(incomingMessage)) {
      const isPickup = isEditPickupCommand(incomingMessage);
      const rideMeta = await getRideMeta(deps.redisClient, activeRideId);

      if (rideMeta && rideMeta.pickupLat && rideMeta.pickupLng && rideMeta.destinationLat && rideMeta.destinationLng) {
        const inlineAddress = extractEditAddress(incomingMessage);

        if (inlineAddress) {
          // Geocode FIRST — don't cancel the ride until we know the address is valid
          const geo = await geocodeAddress(deps.googleMapsApiKey, inlineAddress);
          if (!geo) {
            const label = isPickup ? 'pickup' : 'destination';
            const reply = `${geocodeMissLine(inlineAddress)} Your ride is still active.\n\nTry a more specific ${label} address or share a location pin`;
            await appendWhatsappConversation(deps.redisClient, phone, [
              { role: 'user', content: incomingMessage },
              { role: 'assistant', content: reply },
            ]);
            await sendMetaReply(deps, phone, reply);
            return true;
          }

          const pickup = isPickup
            ? { lat: geo.lat, lng: geo.lng, address: geo.formattedAddress }
            : { lat: rideMeta.pickupLat, lng: rideMeta.pickupLng, address: rideMeta.pickupAddress };
          const destination = !isPickup
            ? { lat: geo.lat, lng: geo.lng, address: geo.formattedAddress }
            : { lat: rideMeta.destinationLat, lng: rideMeta.destinationLng, address: rideMeta.destinationAddress };

          // Plan the new route FIRST — don't cancel the ride until we know
          // the new route is drivable
          const plannedRoute = await planRouteSafe(deps, pickup, destination);
          if (!plannedRoute) {
            const reply = `${ROUTE_PLAN_FAILED_REPLY}\n\nYour ride is still active.`;
            await appendWhatsappConversation(deps.redisClient, phone, [
              { role: 'user', content: incomingMessage },
              { role: 'assistant', content: reply },
            ]);
            await sendMetaReply(deps, phone, reply);
            return true;
          }

          // Route planned — now cancel the old ride
          const editCancelledRide = await rideClient.findById(activeRideId).catch(() => null);
          const cancelEvent = RideCancelledEvent.parse({
            eventType: 'RIDE_CANCELLED',
            rideId: activeRideId,
            riderId: user.id,
            driverId: editCancelledRide?.driverId ?? undefined,
            cancelledBy: 'rider',
            reason: 'rider_editing_route',
            timestamp: new Date().toISOString(),
          });
          await deps.publisher.publishRideEvent(cancelEvent);
          await clearActiveRide(deps.redisClient, user.id);
          await cleanupRideKeys(deps.redisClient, activeRideId);
          await clearPendingAccept(deps.redisClient, user.id);
          const distanceKm = plannedRoute.distanceKm;
          const durationMin = Math.ceil(plannedRoute.durationSeconds / 60);
          const suggestedFare = plannedRoute.suggestedFareNgn;
          const minFare = plannedRoute.minOfferNgn;

          await storePendingRoute(deps.redisClient, user.id, {
            pickupLat: pickup.lat, pickupLng: pickup.lng, pickupAddress: pickup.address,
            destLat: destination.lat, destLng: destination.lng, destAddress: destination.address,
            distanceKm, durationSeconds: plannedRoute.durationSeconds,
            suggestedFareNgn: suggestedFare, minOfferNgn: minFare,
            ratePerKmNgn: plannedRoute.ratePerKmNgn, route: plannedRoute.geometry,
          });
          await setBookingStage(deps.redisClient, user.id, 'awaiting_price');

          const editedLabel = isPickup ? 'Pickup updated!' : 'Destination updated!';
          const reply = [
            `*${editedLabel}*`,
            ``,
            `Pickup: *${pickup.address}*`,
            ``,
            `Destination: *${destination.address}*`,
            ``,
            `${distanceKm.toFixed(1)} km · ~${durationMin} min`,
            `Minimum fare: ₦${minFare.toLocaleString()}`,
            `Suggested fare: ₦${suggestedFare.toLocaleString()}`,
            ``,
            `Send your offer (e.g. *${suggestedFare.toLocaleString()}* or *${Math.round(suggestedFare * 0.85).toLocaleString()}*)`,
          ].join('\n');

          await appendWhatsappConversation(deps.redisClient, phone, [
            { role: 'user', content: incomingMessage },
            { role: 'assistant', content: reply },
          ]);
          await sendQuoteWithPriceButton(deps, user, phone, reply);
          return true;
        }

        // No inline address — don't cancel yet, just switch to editing stage
        // Store route from current ride meta so editing handlers can replan
        await storePendingRoute(deps.redisClient, user.id, {
          pickupLat: rideMeta.pickupLat, pickupLng: rideMeta.pickupLng, pickupAddress: rideMeta.pickupAddress,
          destLat: rideMeta.destinationLat, destLng: rideMeta.destinationLng, destAddress: rideMeta.destinationAddress,
          distanceKm: rideMeta.distanceKm ?? 0, durationSeconds: rideMeta.durationSeconds ?? 0,
          suggestedFareNgn: rideMeta.suggestedFareNgn, minOfferNgn: 0, ratePerKmNgn: 0, route: null,
        });

        const label = isPickup ? 'pickup' : 'destination';
        const current = isPickup ? rideMeta.pickupAddress : rideMeta.destinationAddress;
        await setBookingStage(deps.redisClient, user.id, isPickup ? 'editing_pickup' : 'editing_destination');

        const reply = `Current ${label}: *${current}*\n\nSend a new ${label} location pin or type the address.`;
        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: incomingMessage },
          { role: 'assistant', content: reply },
        ]);
        await sendMetaReply(deps, phone, reply);
        return true;
      }
    }

    // ── Cancel command ──
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

    // ── Pay — rider pays to confirm the selected driver ──
    let pendingAccept = await getPendingAccept(deps.redisClient, user.id);
    if (pendingAccept && pendingAccept.rideId !== activeRideId) {
      // Left over from a ride that timed out or was cancelled. Acting on it
      // used to wipe the CURRENT ride's pointer on a stray "yes".
      await clearPendingAccept(deps.redisClient, user.id);
      pendingAccept = null;
    }
    if (pendingAccept && /^(yes|confirm|accept|go|proceed|pay)$/i.test(incomingMessage.trim())) {
      // Same path as a tap: wallet first, driver still there, hold, then confirm.
      await acceptOfferInChat(deps, user, phone, incomingMessage, pendingAccept.rideId,
        pendingAccept.bidId ?? `driver:${pendingAccept.driverId}`, pendingAccept.fareNgn);
      return true;
    }

    // ── Accept a driver: "accept 1", "accept 3" (can override pending accept) ──
    const acceptNum = parseAcceptCommand(incomingMessage);
    if (acceptNum !== null) {
      const lastBatch = await getLastBatch(deps.redisClient, activeRideId);

      if (lastBatch.length === 0) {
        const reply = 'No drivers have bid yet. Hold tight — we\'ll notify you when drivers respond!';
        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: incomingMessage },
          { role: 'assistant', content: reply },
        ]);
        await sendMetaReply(deps, phone, reply);
        return true;
      }

      // A bare "accept" with a single bid on the table is unambiguous — take
      // it rather than making the rider retype it as "accept 1". With several
      // bids there is a real choice to make, so ask instead of guessing;
      // picking for them would commit their money to a fare they didn't choose.
      if (acceptNum.kind === 'unspecified' && lastBatch.length > 1) {
        const options = lastBatch
          .map(
            (bid, index) =>
              `${index + 1}. ${bid.driverName} — ₦${bid.counterOfferNgn} (${Math.ceil(
                bid.etaSeconds / 60,
              )} min away)`,
          )
          .join('\n');
        const reply = `You have ${lastBatch.length} drivers to choose from:\n\n${options}\n\nJust reply with the number — 1 to ${lastBatch.length}.`;
        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: incomingMessage },
          { role: 'assistant', content: reply },
        ]);
        await sendMetaReply(deps, phone, reply);
        return true;
      }

      const bidIndex = acceptNum.kind === 'numbered' ? acceptNum.driverNumber - 1 : 0;
      const selectedBid = lastBatch[bidIndex];

      if (!selectedBid) {
        const reply = `Invalid driver number. Reply with a number from 1 to ${lastBatch.length}.`;
        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: incomingMessage },
          { role: 'assistant', content: reply },
        ]);
        await sendMetaReply(deps, phone, reply);
        return true;
      }

      // ── Group seat: this accept books ONE seat, not the whole car ──
      const seatInfo = await getGroupSeat(deps.redisClient, activeRideId);
      if (seatInfo) {
        const seats = await recordAcceptedSeat(deps.redisClient, seatInfo.anchorRideId, {
          memberRideId: activeRideId,
          riderId: user.id,
          driverId: selectedBid.driverId,
          driverUserId: selectedBid.driverUserId,
          driverName: selectedBid.driverName,
          amountNgn: selectedBid.counterOfferNgn,
          etaSeconds: selectedBid.etaSeconds,
        });

        const sameDriverSeats = seats.filter((s) => s.driverId === selectedBid.driverId);
        const allAgreed = sameDriverSeats.length >= seatInfo.memberCount;
        const members = await getGroupSeatMembers(deps.redisClient, seatInfo.anchorRideId);

        if (allAgreed) {
          const totalNgn = sameDriverSeats.reduce((sum, s) => sum + s.amountNgn, 0);
          // CASH, deliberately: a WALLET acceptance makes wallet-service
          // escrow the ENTIRE group total from whichever member accepted
          // last. Until per-seat wallet settlement exists, each rider pays
          // the driver their own seat price directly.
          await deps.publisher.publishRideEvent(RideOfferAcceptedEvent.parse({
            eventType: 'RIDE_OFFER_ACCEPTED',
            rideId: seatInfo.anchorRideId,
            riderId: user.id,
            driverId: selectedBid.driverId,
            driverUserId: selectedBid.driverUserId,
            agreedFareNgn: totalNgn,
            paymentMethod: 'CASH',
            timestamp: new Date().toISOString(),
          }));
          await clearAcceptedSeats(deps.redisClient, seatInfo.anchorRideId);

          // Every member's active ride moves onto the trip itself so trip
          // updates (started, GPS, completed) reach them all.
          for (const member of members) {
            await setActiveRide(deps.redisClient, member.riderId, seatInfo.anchorRideId).catch(() => {});
          }

          await replyAndLog(deps, phone, incomingMessage,
            `Seat booked with *${selectedBid.driverName}* at ₦${selectedBid.counterOfferNgn.toLocaleString()}.\n\nThat was the last seat — your group is confirmed! Driver details coming right up.`);
          return true;
        }

        const remaining = seatInfo.memberCount - sameDriverSeats.length;
        await replyAndLog(deps, phone, incomingMessage,
          `Seat booked with *${selectedBid.driverName}* at ₦${selectedBid.counterOfferNgn.toLocaleString()}.\n\n${sameDriverSeats.length}/${seatInfo.memberCount} seats booked with ${selectedBid.driverName} — waiting for ${remaining} co-rider${remaining === 1 ? '' : 's'}.`);

        // Nudge members who haven't booked with THIS driver yet.
        const bookedRiderIds = new Set(sameDriverSeats.map((s) => s.riderId));
        for (const member of members) {
          if (bookedRiderIds.has(member.riderId) || !member.phone) continue;
          await sendMetaReply(deps, member.phone,
            `A co-rider booked their seat with *${selectedBid.driverName}*. If ${selectedBid.driverName} has an offer in your list, reply its number to complete the group — the car moves when every seat is booked with the same driver.`).catch(() => {});
        }
        return true;
      }

      // A typed number is a tap by other means: take the offer now.
      await acceptOfferInChat(deps, user, phone, incomingMessage, activeRideId, offerKey(selectedBid), selectedBid.counterOfferNgn);
      return true;
    }

    // ── "more" command — show latest bids ──
    if (isMoreCommand(incomingMessage)) {
      const reply = await sendCurrentOffers(deps, phone, activeRideId);
      await appendWhatsappConversation(deps.redisClient, phone, [
        { role: 'user', content: incomingMessage },
        { role: 'assistant', content: reply },
      ]);
      return true;
    }

    // ── Counter-offer with a price: "1500", "₦2000", "2k" ──
    const counterOffer = parseCounterOffer(incomingMessage);
    if (counterOffer !== null) {
      const meta = await getRideMeta(deps.redisClient, activeRideId);
      if (meta) {
        // The initial offer was validated against the minimum fare; a
        // counter-offer has to clear the same bar or the floor is bypassed
        // by simply typing a lower number once bidding has started.
        const validation = validateRiderOffer(counterOffer, meta.suggestedFareNgn);
        if (!validation.valid) {
          console.warn('[api-gateway][whatsapp] counter-offer rejected below minimum', {
            rideId: activeRideId,
            riderId: user.id,
            offerNgn: counterOffer,
            minOfferNgn: validation.minOfferNgn,
            suggestedFareNgn: meta.suggestedFareNgn,
          });
          const reply = `Your offer ₦${counterOffer.toLocaleString()} is below the minimum fare of ₦${validation.minOfferNgn.toLocaleString()}.\n\nPlease send a higher amount.`;
          await appendWhatsappConversation(deps.redisClient, phone, [
            { role: 'user', content: incomingMessage },
            { role: 'assistant', content: reply },
          ]);
          await sendMetaReply(deps, phone, reply);
          return true;
        }

        // Update the rider's offer in Redis
        meta.offerNgn = counterOffer;
        await deps.redisClient.set(
          `whatsapp:ride:${activeRideId}:meta`,
          JSON.stringify(meta),
          900,
        );

        // Publish counter-offer to ride-service so all drivers see the updated price
        await deps.publisher.publishRideEvent({
          eventType: 'RIDE_RIDER_COUNTER_OFFER',
          rideId: activeRideId,
          riderId: meta.riderId,
          counterOfferNgn: counterOffer,
          timestamp: new Date().toISOString(),
        });

        const reply = `Bid updated to ₦${counterOffer.toLocaleString()}. Drivers will see your new offer.`;
        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: incomingMessage },
          { role: 'assistant', content: reply },
        ]);
        await sendMetaReply(deps, phone, reply);
        return true;
      }
    }

    // ── Chose a driver, still adding money — point back at the one button ──
    if (pendingAccept) {
      const wallet = await walletClient.findByUserId(user.id);
      const balanceNgn = wallet ? Number(wallet.balanceNgn) : 0;
      if (balanceNgn < pendingAccept.fareNgn) {
        const shortNgn = Math.ceil(pendingAccept.fareNgn - balanceNgn);
        const reply = await sendRideTopupButton(deps, user.id, phone, {
          driverName: pendingAccept.driverName, fareNgn: pendingAccept.fareNgn, balanceNgn, shortNgn, sendNgn: depositNeededFor(shortNgn),
        });
        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: incomingMessage },
          { role: 'assistant', content: reply },
        ]);
        return true;
      }
    }

    // ── Anything else while searching — show what is on the table, to tap ──
    const reply = await sendCurrentOffers(deps, phone, activeRideId);
    await appendWhatsappConversation(deps.redisClient, phone, [
      { role: 'user', content: incomingMessage },
      { role: 'assistant', content: reply },
    ]);
    return true;
    return false;
}
