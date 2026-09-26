import { clearBookingStage, clearPendingRoute, getPendingRoute, setActiveRide, setBookingStage, storeLastRoute, storePendingRoute, storeWhatsappRide } from '../../whatsapp-flows/bid-state';
import { isCancelCommand, isEditDestinationCommand, isEditPickupCommand, parseCounterOffer } from '../../whatsapp/parse';
import { appendWhatsappConversation } from '../../LLM/conversation-store';
import { sendMetaReply } from '../../whatsapp/send';
import { geocodeAddress } from '../../LLM/geocoding';
import { planRouteSafe } from '../../whatsapp/trip';
import { randomUUID } from 'crypto';
import { RideRequestedEvent } from '@wheleers/kafka-schemas';
import type { StageContext } from '../stage-context';

/** The awaitingRouteConfirmation stage of the chat, carved out of handleIncomingMetaMessage. Returns true when it answered the message. */
export async function awaitingRouteConfirmation(ctx: StageContext): Promise<boolean> {
  const { deps, incomingMessage, phone, user } = ctx;

    const pendingRoute = await getPendingRoute(deps.redisClient, user.id);
    const answer = incomingMessage.trim();

    if (isCancelCommand(answer)) {
      await clearPendingRoute(deps.redisClient, user.id);
      await clearBookingStage(deps.redisClient, user.id);
      const reply = 'No problem — nothing booked. Message me when you need a ride.';
      await appendWhatsappConversation(deps.redisClient, phone, [
        { role: 'user', content: incomingMessage },
        { role: 'assistant', content: reply },
      ]);
      await sendMetaReply(deps, phone, reply);
      return true;
    }

    if (!pendingRoute || pendingRoute.offerNgn === undefined) {
      await clearBookingStage(deps.redisClient, user.id);
      const reply = 'That took too long — send your pickup and destination again and we\'ll re-check the price.';
      await appendWhatsappConversation(deps.redisClient, phone, [
        { role: 'user', content: incomingMessage },
        { role: 'assistant', content: reply },
      ]);
      await sendMetaReply(deps, phone, reply);
      return true;
    }

    const confirmed = /^(?:y|ya|yes|yeah|yep|ok|okay|correct|right|sure|go|confirm(?:ed)?|book(?:\s+it)?)(?:\s+(?:please|book(?:\s+it)?|go|proceed|confirm|now|abeg))?[\s!.]*$/i.test(answer);

    if (!confirmed) {
      // A new price is the correction we invited — apply it and re-confirm.
      const newOffer = parseCounterOffer(answer);
      if (newOffer !== null) {
        if (newOffer < pendingRoute.minOfferNgn) {
          const reply = `₦${newOffer.toLocaleString()} is below the minimum fare of ₦${pendingRoute.minOfferNgn.toLocaleString()} for this trip. Send a higher amount, or *yes* to book at ₦${pendingRoute.offerNgn.toLocaleString()}.`;
          await appendWhatsappConversation(deps.redisClient, phone, [
            { role: 'user', content: incomingMessage },
            { role: 'assistant', content: reply },
          ]);
          await sendMetaReply(deps, phone, reply);
          return true;
        }
        await storePendingRoute(deps.redisClient, user.id, { ...pendingRoute, offerNgn: newOffer });
        await setBookingStage(deps.redisClient, user.id, 'awaiting_route_confirmation');
        const reply = [
          `Offer updated to ₦${newOffer.toLocaleString()}`,
          ``,
          `Pickup: *${pendingRoute.pickupAddress}*`,
          `Destination: *${pendingRoute.destAddress}*`,
          ``,
          `Reply *yes* to find drivers, or *edit pickup <address>* / *edit destination <address>* to fix the route.`,
        ].join('\n');
        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: incomingMessage },
          { role: 'assistant', content: reply },
        ]);
        await sendMetaReply(deps, phone, reply);
        return true;
      }

      // Anything else is an address correction. The price handler knows
      // "edit pickup <address>" / "edit destination <address>"; a bare
      // address is applied as the destination directly.
      await setBookingStage(deps.redisClient, user.id, 'awaiting_price');
      if (!isEditPickupCommand(answer) && !isEditDestinationCommand(answer) && answer.length >= 3) {
        const geo = await geocodeAddress(deps.googleMapsApiKey, answer);
        if (geo) {
          const pickup = { lat: pendingRoute.pickupLat, lng: pendingRoute.pickupLng, address: pendingRoute.pickupAddress };
          const destination = { lat: geo.lat, lng: geo.lng, address: geo.formattedAddress };
          const replanned = await planRouteSafe(deps, pickup, destination);
          if (replanned) {
            await storePendingRoute(deps.redisClient, user.id, {
              pickupLat: pickup.lat,
              pickupLng: pickup.lng,
              pickupAddress: pickup.address,
              destLat: destination.lat,
              destLng: destination.lng,
              destAddress: destination.address,
              distanceKm: replanned.distanceKm,
              durationSeconds: replanned.durationSeconds,
              suggestedFareNgn: replanned.suggestedFareNgn,
              minOfferNgn: replanned.minOfferNgn,
              ratePerKmNgn: replanned.ratePerKmNgn,
              route: replanned.geometry,
            });
            const reply = [
              `Destination updated`,
              ``,
              `Pickup: *${pickup.address}*`,
              `Destination: *${destination.address}*`,
              `${replanned.distanceKm.toFixed(1)} km · ~${Math.ceil(replanned.durationSeconds / 60)} min`,
              `Minimum fare: ₦${replanned.minOfferNgn.toLocaleString()}`,
              `Suggested fare: ₦${replanned.suggestedFareNgn.toLocaleString()}`,
              ``,
              `Send your offer, or *edit pickup <address>* if the pickup is wrong.`,
            ].join('\n');
            await appendWhatsappConversation(deps.redisClient, phone, [
              { role: 'user', content: incomingMessage },
              { role: 'assistant', content: reply },
            ]);
            await sendMetaReply(deps, phone, reply);
            return true;
          }
        }
      }
      const reply = [
        `Got it — nothing booked yet.`,
        ``,
        `Send a *price* to search with, or "edit pickup <address>" / "edit destination <address>" to fix the route.`,
      ].join('\n');
      await appendWhatsappConversation(deps.redisClient, phone, [
        { role: 'user', content: incomingMessage },
        { role: 'assistant', content: reply },
      ]);
      await sendMetaReply(deps, phone, reply);
      return true;
    }

    const pickup = {
      lat: pendingRoute.pickupLat,
      lng: pendingRoute.pickupLng,
      address: pendingRoute.pickupAddress,
    };
    const destination = {
      lat: pendingRoute.destLat,
      lng: pendingRoute.destLng,
      address: pendingRoute.destAddress,
    };
    const offerNgn = pendingRoute.offerNgn;

    // Two quick "yes"es (different wamids) must not book twice.
    const publishClaim = await deps.redisClient.setIfNotExists(`whatsapp:user:${user.id}:publishing`, '1', 30).catch(() => true);
    if (!publishClaim) return true;

    const rideId = randomUUID();
    const event = RideRequestedEvent.parse({
      eventType: 'RIDE_REQUESTED',
      rideId,
      riderId: user.id,
      pickup,
      destination,
      stops: pendingRoute.stops ?? [],
      plannedDistanceKm: pendingRoute.distanceKm,
      plannedDurationSeconds: pendingRoute.durationSeconds,
      fareEstimateNgn: pendingRoute.suggestedFareNgn,
      paymentMethod: 'WALLET',
      riderOfferNgn: offerNgn,
      suggestedFareNgn: pendingRoute.suggestedFareNgn,
      minOfferNgn: pendingRoute.minOfferNgn,
      ratePerKmNgn: pendingRoute.ratePerKmNgn,
      route: pendingRoute.route,
      timestamp: new Date().toISOString(),
    });

    try {
      await deps.publisher.publishRideEvent(event);
    } catch (publishError) {
      console.error('[api-gateway][whatsapp] ride publish FAILED — quote kept', {
        rideId,
        riderId: user.id,
        error: publishError instanceof Error ? publishError.message : String(publishError),
      });
      await deps.redisClient.del(`whatsapp:user:${user.id}:publishing`).catch(() => {});
      const reply = 'Could not start the search just now. Reply *yes* to try again.';
      await appendWhatsappConversation(deps.redisClient, phone, [
        { role: 'user', content: incomingMessage },
        { role: 'assistant', content: reply },
      ]);
      await sendMetaReply(deps, phone, reply);
      return true;
    }
    await clearPendingRoute(deps.redisClient, user.id);

    await storeWhatsappRide(deps.redisClient, rideId, {
      riderId: user.id,
      phone,
      pickupAddress: pickup.address,
      pickupLat: pickup.lat,
      pickupLng: pickup.lng,
      destinationAddress: destination.address,
      destinationLat: destination.lat,
      destinationLng: destination.lng,
      distanceKm: pendingRoute.distanceKm,
      durationSeconds: pendingRoute.durationSeconds,
      offerNgn,
      suggestedFareNgn: pendingRoute.suggestedFareNgn,
      paymentMethod: 'WALLET',
      createdAt: new Date().toISOString(),
    });
    await setActiveRide(deps.redisClient, user.id, rideId);
    await setBookingStage(deps.redisClient, user.id, 'searching');
    await storeLastRoute(deps.redisClient, user.id, {
      pickupLat: pendingRoute.pickupLat,
      pickupLng: pendingRoute.pickupLng,
      pickupAddress: pendingRoute.pickupAddress,
      destLat: pendingRoute.destLat,
      destLng: pendingRoute.destLng,
      destAddress: pendingRoute.destAddress,
      distanceKm: pendingRoute.distanceKm,
      durationSeconds: pendingRoute.durationSeconds,
      suggestedFareNgn: pendingRoute.suggestedFareNgn,
      minOfferNgn: pendingRoute.minOfferNgn,
      ratePerKmNgn: pendingRoute.ratePerKmNgn,
      route: pendingRoute.route,
      offerNgn,
    });

    const reply = [
      `*Finding you a driver!*`,
      ``,
      `Pickup: *${pickup.address}*`,
      `Destination: *${destination.address}*`,
      `${pendingRoute.distanceKm.toFixed(1)} km · ~${Math.ceil(pendingRoute.durationSeconds / 60)} min`,
      `Your offer: ₦${offerNgn.toLocaleString()}`,
      ``,
      `We'll send you all available drivers!`,
    ].join('\n');

    await appendWhatsappConversation(deps.redisClient, phone, [
      { role: 'user', content: incomingMessage },
      { role: 'assistant', content: reply },
    ]);
    await sendMetaReply(deps, phone, reply);
    return true;
    return false;
}
