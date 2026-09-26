import { appendWhatsappConversation } from '../../LLM/conversation-store';
import { sendMetaReply } from '../../whatsapp/send';
import { OUTSIDE_SERVICE_AREA_LINE, isPinInsideServiceArea, reverseGeocode } from '../../LLM/geocoding';
import { applyGroupLocation } from '../../whatsapp/group';
import { cleanupRideKeys, clearActiveRide, clearBookingStage, clearPendingAccept, clearPendingAreaHint, clearPendingLocation, getPendingAreaHint, getPendingLocation, getPendingRoute, setBookingStage, setPendingLocation, storePendingRoute } from '../../whatsapp-flows/bid-state';
import { ROUTE_PLAN_FAILED_REPLY, addStopToTrip, buildGroupSuggestionLine, planRouteSafe, sendQuoteWithPriceButton } from '../../whatsapp/trip';
import { rideClient } from '@wheleers/db';
import { RideCancelledEvent } from '@wheleers/kafka-schemas';
import type { StageContext } from '../stage-context';

/** The locationPin stage of the chat, carved out of handleIncomingMetaMessage. Returns true when it answered the message. */
export async function locationPin(ctx: StageContext): Promise<boolean> {
  const { activeRideId, bookingStage, deps, msgInfo, phone, user } = ctx;
  // The route only reaches this stage for a real pin; the guard lives there.
  const { locationLat, locationLng } = ctx;
  if (locationLat === undefined || locationLng === undefined) return false;

    // Block location pins during active ride (unless editing)
    if (activeRideId && bookingStage !== 'editing_pickup' && bookingStage !== 'editing_destination') {
      const reply = 'You have an active ride. Reply *edit from* or *edit to* to change your route, or *cancel* to start fresh.';
      await appendWhatsappConversation(deps.redisClient, phone, [
        { role: 'user', content: '[Shared location pin]' },
        { role: 'assistant', content: reply },
      ]);
      await sendMetaReply(deps, phone, reply);
      return true;
    }

    const reverseGeo = await reverseGeocode(deps.googleMapsApiKey, locationLat, locationLng);
    const address = reverseGeo?.formattedAddress ?? `${locationLat.toFixed(4)}, ${locationLng.toFixed(4)}`;

    if (!isPinInsideServiceArea(locationLat, locationLng, reverseGeo)) {
      const reply = `That pin is outside Nigeria (${address}). ${OUTSIDE_SERVICE_AREA_LINE}`;
      await appendWhatsappConversation(deps.redisClient, phone, [
        { role: 'user', content: '[Shared location pin]' },
        { role: 'assistant', content: reply },
      ]);
      await sendMetaReply(deps, phone, reply);
      return true;
    }

    // ── Group ride pickup/destination pins ──
    if (bookingStage === 'group_awaiting_pickup' || bookingStage === 'group_awaiting_destination') {
      await applyGroupLocation(
        deps, user, phone,
        `[Shared location: ${address}]`,
        bookingStage,
        { lat: locationLat, lng: locationLng, address },
      );
      return true;
    }

    // ── Adding a stop via location pin ──
    if (bookingStage === 'adding_stop') {
      const trip = await getPendingRoute(deps.redisClient, user.id);
      if (trip) {
        await addStopToTrip(deps, user, phone, `[Shared location: ${address}]`, trip, address, { lat: locationLat, lng: locationLng, address });
        return true;
      }
    }

    // ── Editing pickup/destination via location pin ──
    if (bookingStage === 'editing_pickup' || bookingStage === 'editing_destination') {
      const pendingRoute = await getPendingRoute(deps.redisClient, user.id);
      if (!pendingRoute) {
        await clearBookingStage(deps.redisClient, user.id);
        const label = bookingStage === 'editing_pickup' ? 'edit from' : 'edit to';
        const reply = `That edit timed out. Reply *${label}* again and then share the pin.`;
        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: `[Shared location: ${address}]` },
          { role: 'assistant', content: reply },
        ]);
        await sendMetaReply(deps, phone, reply);
        return true;
      }
      if (pendingRoute) {
        const pickup = bookingStage === 'editing_pickup'
          ? { lat: locationLat, lng: locationLng, address }
          : { lat: pendingRoute.pickupLat, lng: pendingRoute.pickupLng, address: pendingRoute.pickupAddress };
        const destination = bookingStage === 'editing_destination'
          ? { lat: locationLat, lng: locationLng, address }
          : { lat: pendingRoute.destLat, lng: pendingRoute.destLng, address: pendingRoute.destAddress };

        const plannedRoute = await planRouteSafe(deps, pickup, destination);
        if (!plannedRoute) {
          const reply = `${ROUTE_PLAN_FAILED_REPLY}\n\nYour booking is unchanged — try a different pin.`;
          await appendWhatsappConversation(deps.redisClient, phone, [
            { role: 'user', content: `[Shared location: ${address}]` },
            { role: 'assistant', content: reply },
          ]);
          await sendMetaReply(deps, phone, reply);
          return true;
        }
        const distanceKm = plannedRoute.distanceKm;
        const durationMin = Math.ceil(plannedRoute.durationSeconds / 60);
        const suggestedFare = plannedRoute.suggestedFareNgn;
        const minFare = plannedRoute.minOfferNgn;

        // If rider had an active ride, cancel it now that the edit succeeded
        if (activeRideId) {
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
        }

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

        const editedLabel = bookingStage === 'editing_pickup' ? 'Pickup updated!' : 'Destination updated!';
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
          { role: 'user', content: `[Shared location: ${address}]` },
          { role: 'assistant', content: reply },
        ]);
        await sendQuoteWithPriceButton(deps, user, phone, reply);
        return true;
      }
    }

    // A pin is the destination only while we are actually waiting for one.
    // Any other time it is a fresh pickup — a stale pickup from an
    // abandoned booking used to turn the next pin into a wrong-way route.
    const storedPickup = await getPendingLocation(deps.redisClient, user.id);
    const pendingPickup = bookingStage === 'awaiting_destination' ? storedPickup : null;

    if (!pendingPickup) {
      if (activeRideId) {
        const reply = 'You have an active ride. Reply *edit from* or *edit to* to change your route, or *cancel* to start fresh.';
        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: `[Shared location: ${address}]` },
          { role: 'assistant', content: reply },
        ]);
        await sendMetaReply(deps, phone, reply);
        return true;
      }
      // ── FIRST location pin = PICKUP ──
      const rememberedDestination = (await getPendingAreaHint(deps.redisClient, user.id).catch(() => null))?.counterpartAddress?.trim();
      await clearPendingAreaHint(deps.redisClient, user.id).catch(() => {});
      await setPendingLocation(deps.redisClient, user.id, {
        lat: locationLat,
        lng: locationLng,
        address,
        savedAt: new Date().toISOString(),
      });
      await setBookingStage(deps.redisClient, user.id, 'awaiting_destination');

      // They already told us where they are going: answer the destination
      // step with it instead of asking again.
      if (rememberedDestination) {
        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: `[Shared pickup location: ${address}]` },
          { role: 'assistant', content: `Pickup: ${address}` },
        ]);
        await ctx.replay({ ...msgInfo, messageId: '', isLocation: false, locationLat: undefined, locationLng: undefined, messageBody: rememberedDestination });
        return true;
      }

      const reply = `Pickup: *${address}*\n\nNow share your *destination* location pin!`;
      await appendWhatsappConversation(deps.redisClient, phone, [
        { role: 'user', content: `[Shared pickup location: ${address}]` },
        { role: 'assistant', content: reply },
      ]);
      await sendMetaReply(deps, phone, reply);
      return true;
    }

    // ── SECOND location pin = DESTINATION ──
    // We have pickup, now got destination — go straight to finding drivers
    const pickup = { lat: pendingPickup.lat, lng: pendingPickup.lng, address: pendingPickup.address };
    const destination = { lat: locationLat, lng: locationLng, address };

    // Check for existing active ride
    if (activeRideId) {
      await clearPendingLocation(deps.redisClient, user.id);
      await clearBookingStage(deps.redisClient, user.id);
      const reply = 'You already have an active ride. Say *cancel* first to book a new one.';
      await appendWhatsappConversation(deps.redisClient, phone, [
        { role: 'user', content: `[Shared destination location: ${address}]` },
        { role: 'assistant', content: reply },
      ]);
      await sendMetaReply(deps, phone, reply);
      return true;
    }

    // Plan route, store it, and ask rider for their price
    const plannedRoute = await planRouteSafe(deps, pickup, destination);
    if (!plannedRoute) {
      // Keep the pending pickup and stage so the rider can re-share a pin
      const reply = ROUTE_PLAN_FAILED_REPLY;
      await appendWhatsappConversation(deps.redisClient, phone, [
        { role: 'user', content: `[Shared destination location: ${address}]` },
        { role: 'assistant', content: reply },
      ]);
      await sendMetaReply(deps, phone, reply);
      return true;
    }

    await clearPendingLocation(deps.redisClient, user.id);
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
      { role: 'user', content: `[Shared destination location: ${address}]` },
      { role: 'assistant', content: reply },
    ]);
    await sendQuoteWithPriceButton(deps, user, phone, reply);
    return true;
    return false;
}
