import { groupRideClient } from '@wheleers/db';
import { createLlm } from '../LLM/llm';
import { geocodeMissLine } from '../LLM/geocoding';
import { geocodeAddress, findPlaceOptions } from '../LLM/geocoding';
import { verifySelfiePhoto } from '../LLM/face-check';
import { downloadMetaMedia } from '../whatsapp-flows/meta-media';
import { buildReadyForMatchEvent } from '../group-ride/ready-event';
import { setBookingStage, clearBookingStage, storePendingRoute, storePendingGroupRide, getPendingGroupRide, clearPendingGroupRide, setGroupRequestRider, getGroupRequestRider, clearGroupRequestRider, getPendingGeoChoices, clearPendingGeoChoices } from '../whatsapp-flows/bid-state';
import { MetaWhatsappRouteDeps, WhatsappUser } from './deps';
import { isCancelCommand, isGroupCancelCommand, parseCounterOffer, stripDirectionPrefix } from './parse';
import { sendPlaceChoices } from './places';
import { replyAndLog } from './send';
import { ROUTE_PLAN_FAILED_REPLY, planRouteSafe, quoteAndLog } from './trip';

export const GROUP_SELFIE_PROMPT = [
  'Quick safety check',
  '',
  'Send a clear *selfie of your face* so other riders know who they are sharing with.',
  '',
  'Just your face, good lighting, no sunglasses. Reply *cancel group* to stop.',
].join('\n');

export const MAX_SELFIE_ATTEMPTS = 3;

/** Entry: "group ride" intent. Pre-filled locations skip straight ahead. */
export async function startGroupRideFlow(
  deps: MetaWhatsappRouteDeps,
  user: WhatsappUser,
  phone: string,
  incomingMessage: string,
  prefill?: {
    pickup?: { lat: number; lng: number; address: string };
    destination?: { lat: number; lng: number; address: string };
  },
): Promise<void> {
  const pending = {
    ...(prefill?.pickup
      ? {
          pickupLat: prefill.pickup.lat,
          pickupLng: prefill.pickup.lng,
          pickupAddress: prefill.pickup.address,
        }
      : {}),
    ...(prefill?.destination
      ? {
          destLat: prefill.destination.lat,
          destLng: prefill.destination.lng,
          destAddress: prefill.destination.address,
        }
      : {}),
  };
  await storePendingGroupRide(deps.redisClient, user.id, pending);

  if (pending.pickupLat !== undefined && pending.destLat !== undefined) {
    await presentGroupQuote(deps, user, phone, incomingMessage);
    return;
  }

  if (pending.pickupLat !== undefined) {
    await setBookingStage(deps.redisClient, user.id, 'group_awaiting_destination');
    await replyAndLog(deps, phone, incomingMessage,
      `*Group ride!* Riders heading the same way share one car and split the fare.\n\nPickup: *${pending.pickupAddress}*\n\nWhere are you headed? Type the destination or share a pin`);
    return;
  }

  await setBookingStage(deps.redisClient, user.id, 'group_awaiting_pickup');
  await replyAndLog(deps, phone, incomingMessage,
    `*Group ride!* Riders heading the same way share one car and split the fare.\n\nWhere should we pick you up? Share a location pin or type the address.`);
}

/** Both locations known: plan the route, quote it, ask for one yes. */
export async function presentGroupQuote(
  deps: MetaWhatsappRouteDeps,
  user: WhatsappUser,
  phone: string,
  incomingMessage: string,
): Promise<void> {
  const pending = await getPendingGroupRide(deps.redisClient, user.id);
  if (
    !pending ||
    pending.pickupLat === undefined || pending.pickupLng === undefined ||
    pending.destLat === undefined || pending.destLng === undefined
  ) {
    await clearBookingStage(deps.redisClient, user.id);
    await replyAndLog(deps, phone, incomingMessage,
      'Session expired — type *group ride* to start again.');
    return;
  }

  const pickup = { lat: pending.pickupLat, lng: pending.pickupLng, address: pending.pickupAddress ?? '' };
  const destination = { lat: pending.destLat, lng: pending.destLng, address: pending.destAddress ?? '' };

  const plannedRoute = await planRouteSafe(deps, pickup, destination);
  if (!plannedRoute) {
    await replyAndLog(deps, phone, incomingMessage, ROUTE_PLAN_FAILED_REPLY);
    return;
  }

  // Every seat has its own price, set by its own rider. Suggested is 25%
  // off the solo fare — sharing should always beat riding alone.
  const suggestedSeatNgn = Math.round((plannedRoute.suggestedFareNgn * 0.75) / 50) * 50;

  await storePendingGroupRide(deps.redisClient, user.id, {
    ...pending,
    plannedDistanceKm: plannedRoute.distanceKm,
    plannedDurationSeconds: plannedRoute.durationSeconds,
    fareEstimateNgn: suggestedSeatNgn,
  });
  await setBookingStage(deps.redisClient, user.id, 'group_awaiting_confirm');

  const durationMin = Math.ceil(plannedRoute.durationSeconds / 60);
  await replyAndLog(deps, phone, incomingMessage, [
    `*Group ride*`,
    ``,
    `Pickup: *${pickup.address}*`,
    `Destination: *${destination.address}*`,
    `${plannedRoute.distanceKm.toFixed(1)} km · ~${durationMin} min`,
    ``,
    `Solo fare: ₦${plannedRoute.suggestedFareNgn.toLocaleString()}`,
    `*Your seat, your price.* Suggested: *₦${suggestedSeatNgn.toLocaleString()}* (25% off solo).`,
    ``,
    `Reply *yes* to offer ₦${suggestedSeatNgn.toLocaleString()}, send *your own price*, or *cancel*.`,
  ].join('\n'));
}

/** Text messages while in one of the group stages. */
export async function handleGroupStageText(
  deps: MetaWhatsappRouteDeps,
  user: WhatsappUser,
  phone: string,
  incomingMessage: string,
  stage: 'group_awaiting_pickup' | 'group_awaiting_destination' | 'group_awaiting_confirm' | 'group_awaiting_face_photo',
): Promise<void> {
  if (isCancelCommand(incomingMessage) || isGroupCancelCommand(incomingMessage)) {
    await cancelGroupRide(deps, user, phone, incomingMessage);
    return;
  }

  if (stage === 'group_awaiting_pickup' || stage === 'group_awaiting_destination') {
    // Riders often answer the pickup question with the whole route
    // ("From 108 Opebi to 15 Aiyetoro Street") — take both in one go.
    const routeMatch = incomingMessage.trim().match(/^from\s+(.+?)\s+to\s+(.+)$/i);
    if (routeMatch) {
      const pickupGeo = await geocodeAddress(deps.googleMapsApiKey, routeMatch[1]!.trim());
      const destGeo = await geocodeAddress(deps.googleMapsApiKey, routeMatch[2]!.trim(),
        pickupGeo ? { near: { lat: pickupGeo.lat, lng: pickupGeo.lng } } : {});
      if (pickupGeo && destGeo) {
        const pending = (await getPendingGroupRide(deps.redisClient, user.id)) ?? {};
        await storePendingGroupRide(deps.redisClient, user.id, {
          ...pending,
          pickupLat: pickupGeo.lat,
          pickupLng: pickupGeo.lng,
          pickupAddress: pickupGeo.formattedAddress,
          destLat: destGeo.lat,
          destLng: destGeo.lng,
          destAddress: destGeo.formattedAddress,
        });
        await presentGroupQuote(deps, user, phone, incomingMessage);
        return;
      }
      if (!pickupGeo) {
        await replyAndLog(deps, phone, incomingMessage,
          `${geocodeMissLine(routeMatch[1]!.trim())}\n\nPlease type a more specific pickup address or share a location pin`);
        return;
      }
      // Pickup resolved but destination didn't — keep it, say so, ask again.
      await replyAndLog(deps, phone, incomingMessage, geocodeMissLine(routeMatch[2]!.trim()));
      await applyGroupLocation(deps, user, phone, incomingMessage, 'group_awaiting_pickup', {
        lat: pickupGeo.lat,
        lng: pickupGeo.lng,
        address: pickupGeo.formattedAddress,
      });
      return;
    }

    const typed = stripDirectionPrefix(incomingMessage);

    // A bare number answers a pending "which one did you mean?" list.
    if (/^[1-9]$/.test(typed)) {
      const choices = await getPendingGeoChoices(deps.redisClient, user.id);
      const expectedContext = stage === 'group_awaiting_pickup' ? 'group_pickup' : 'group_destination';
      const pick = choices?.context === expectedContext ? choices.options[Number(typed) - 1] : undefined;
      if (pick) {
        await clearPendingGeoChoices(deps.redisClient, user.id);
        await applyGroupLocation(deps, user, phone, incomingMessage, stage, pick);
        return;
      }
    }

    const candidates = await findPlaceOptions(deps.googleMapsApiKey, typed, { spokenText: incomingMessage });
    if (candidates.length === 0) {
      await replyAndLog(deps, phone, incomingMessage,
        `${geocodeMissLine(typed)}\n\nPlease type a more specific address or share a location pin`);
      return;
    }

    // Ambiguous place name ("Aiyetoro" exists in Surulere AND Akoka) — ask
    // instead of assuming. A query that pins the area returns one candidate.
    if (candidates.length > 1) {
      await sendPlaceChoices(deps, user, phone, incomingMessage, {
        context: stage === 'group_awaiting_pickup' ? 'group_pickup' : 'group_destination',
        field: stage === 'group_awaiting_pickup' ? 'pickup' : 'destination',
        typed,
        candidates,
      });
      return;
    }

    await applyGroupLocation(deps, user, phone, incomingMessage, stage, {
      lat: candidates[0]!.lat,
      lng: candidates[0]!.lng,
      address: candidates[0]!.formattedAddress,
    });
    return;
  }

  if (stage === 'group_awaiting_confirm') {
    if (/^(yes|yeah|yea|yep|ok|okay|confirm|y)\b/i.test(incomingMessage.trim())) {
      await createGroupMatchRequest(deps, user, phone, incomingMessage);
      return;
    }

    // A number here is the rider naming their own seat price.
    const offered = parseCounterOffer(incomingMessage);
    if (offered !== null && offered >= 500) {
      const pending = await getPendingGroupRide(deps.redisClient, user.id);
      if (pending) {
        await storePendingGroupRide(deps.redisClient, user.id, {
          ...pending,
          fareEstimateNgn: offered,
        });
      }
      await createGroupMatchRequest(deps, user, phone, incomingMessage);
      return;
    }

    await replyAndLog(deps, phone, incomingMessage,
      'Reply *yes* to use the suggested seat price, send *your own price* (e.g. *4200*), or *cancel*.');
    return;
  }

  // group_awaiting_face_photo — they typed instead of sending a photo
  await replyAndLog(deps, phone, incomingMessage, GROUP_SELFIE_PROMPT);
}

/** Location pins while in a group location stage. */
export async function applyGroupLocation(
  deps: MetaWhatsappRouteDeps,
  user: WhatsappUser,
  phone: string,
  incomingMessage: string,
  stage: 'group_awaiting_pickup' | 'group_awaiting_destination',
  point: { lat: number; lng: number; address: string },
): Promise<void> {
  const pending = (await getPendingGroupRide(deps.redisClient, user.id)) ?? {};

  if (stage === 'group_awaiting_pickup') {
    await storePendingGroupRide(deps.redisClient, user.id, {
      ...pending,
      pickupLat: point.lat,
      pickupLng: point.lng,
      pickupAddress: point.address,
    });
    if (pending.destLat !== undefined) {
      await presentGroupQuote(deps, user, phone, incomingMessage);
      return;
    }
    await setBookingStage(deps.redisClient, user.id, 'group_awaiting_destination');
    await replyAndLog(deps, phone, incomingMessage,
      `Pickup: *${point.address}*\n\nWhere are you headed? Type the destination or share a pin`);
    return;
  }

  await storePendingGroupRide(deps.redisClient, user.id, {
    ...pending,
    destLat: point.lat,
    destLng: point.lng,
    destAddress: point.address,
  });
  await presentGroupQuote(deps, user, phone, incomingMessage);
}

/** "yes" on the quote: create the match request, then ask for the selfie. */
export async function createGroupMatchRequest(
  deps: MetaWhatsappRouteDeps,
  user: WhatsappUser,
  phone: string,
  incomingMessage: string,
): Promise<void> {
  const pending = await getPendingGroupRide(deps.redisClient, user.id);
  if (
    !pending ||
    pending.pickupLat === undefined || pending.pickupLng === undefined ||
    pending.destLat === undefined || pending.destLng === undefined
  ) {
    await clearBookingStage(deps.redisClient, user.id);
    await replyAndLog(deps, phone, incomingMessage,
      'Session expired — type *group ride* to start again.');
    return;
  }

  try {
    const request = await groupRideClient.createMatchRequest({
      userId: user.id,
      pickupLat: pending.pickupLat,
      pickupLng: pending.pickupLng,
      pickupAddress: pending.pickupAddress ?? '',
      destLat: pending.destLat,
      destLng: pending.destLng,
      destAddress: pending.destAddress ?? '',
      plannedDistanceKm: pending.plannedDistanceKm,
      plannedDurationSeconds: pending.plannedDurationSeconds,
      fareEstimateNgn: pending.fareEstimateNgn,
    });

    await storePendingGroupRide(deps.redisClient, user.id, {
      ...pending,
      matchRequestId: request.id,
      faceAttempts: 0,
    });
    await setGroupRequestRider(deps.redisClient, user.id, request.id);

    // Verification is once per person, not once per ride — a rider with a
    // previously verified selfie goes straight into matching.
    const priorVerification = await groupRideClient
      .findLatestStoredFaceVerificationByUser(user.id)
      .catch(() => null);
    if (priorVerification && deps.groupRideFaceStorage) {
      try {
        const stored = await deps.groupRideFaceStorage.copyFrom({
          sourceBucket: priorVerification.bucket,
          sourceObjectKey: priorVerification.objectKey,
          matchRequestId: request.id,
          userId: user.id,
          mimeType: priorVerification.mimeType,
        });
        await groupRideClient.upsertFaceVerificationUpload({
          matchRequestId: request.id,
          userId: user.id,
          bucket: stored.bucket,
          objectKey: stored.objectKey,
          mimeType: stored.mimeType,
          capturedAt: stored.capturedAt,
        });
        const completed = await groupRideClient.completeFaceVerificationAndMarkReady({
          matchRequestId: request.id,
          sizeBytes: priorVerification.sizeBytes ?? undefined,
          capturedAt: stored.capturedAt,
        });
        await deps.publisher.publishGroupRideEvent(buildReadyForMatchEvent(completed.request));

        await clearPendingGroupRide(deps.redisClient, user.id);
        await clearBookingStage(deps.redisClient, user.id);

        await replyAndLog(deps, phone, incomingMessage, [
          `You're already verified — no selfie needed this time.`,
          ``,
          `*Matching in progress!* We're finding riders heading your way — you'll get a message here the moment your group is formed.`,
          ``,
          `Reply *group status* to check, or *cancel group* to leave.`,
        ].join('\n'));
        return;
      } catch (error) {
        console.warn('[whatsapp][group-ride] selfie reuse failed — asking for a fresh one', {
          userId: user.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    await setBookingStage(deps.redisClient, user.id, 'group_awaiting_face_photo');
    await replyAndLog(deps, phone, incomingMessage, GROUP_SELFIE_PROMPT);
  } catch (error) {
    console.error('[whatsapp][group-ride] createMatchRequest failed', {
      userId: user.id,
      error: error instanceof Error ? error.message : String(error),
    });
    await replyAndLog(deps, phone, incomingMessage,
      'Could not start your group ride right now. Please try again in a moment.');
  }
}

/** The selfie arrives: guardrail-check it, store it, mark ready for matching. */
export async function handleGroupSelfie(
  deps: MetaWhatsappRouteDeps,
  user: WhatsappUser,
  phone: string,
  mediaId: string | undefined,
): Promise<void> {
  const pending = await getPendingGroupRide(deps.redisClient, user.id);
  if (!pending?.matchRequestId) {
    await clearBookingStage(deps.redisClient, user.id);
    await replyAndLog(deps, phone, '[Photo]',
      'Session expired — type *group ride* to start again.');
    return;
  }

  if (!mediaId || !deps.metaAccessToken || !deps.groupRideFaceStorage) {
    console.warn('[whatsapp][group-ride] selfie received but media pipeline unavailable', {
      hasMediaId: Boolean(mediaId),
      hasToken: Boolean(deps.metaAccessToken),
      hasStorage: Boolean(deps.groupRideFaceStorage),
    });
    await replyAndLog(deps, phone, '[Photo]',
      'Could not read that photo. Please try sending it again.');
    return;
  }

  let media;
  try {
    media = await downloadMetaMedia(deps.metaAccessToken, mediaId);
  } catch (error) {
    console.warn('[whatsapp][group-ride] media download failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    await replyAndLog(deps, phone, '[Photo]',
      'Could not read that photo. Please send a clear JPEG or PNG selfie (under 5 MB).');
    return;
  }

  // Guardrail: a real human face, not a pet, meme, or screenshot.
  const groq = createLlm({ groqApiKey: deps.groqApiKey, groqModel: deps.groqModel, timeoutMs: deps.groqTimeoutMs });
  const verdict = await verifySelfiePhoto(groq, media.buffer, media.mimeType);
  if (!verdict.accepted) {
    const attempts = (pending.faceAttempts ?? 0) + 1;
    if (attempts >= MAX_SELFIE_ATTEMPTS) {
      await cancelGroupRide(deps, user, phone, '[Photo]');
      return;
    }
    await storePendingGroupRide(deps.redisClient, user.id, { ...pending, faceAttempts: attempts });
    await replyAndLog(deps, phone, '[Photo]',
      `That doesn't look like a clear selfie of you\n\nPlease send a real photo of *your face* — no pets, cartoons, or screenshots. (${MAX_SELFIE_ATTEMPTS - attempts} tr${MAX_SELFIE_ATTEMPTS - attempts === 1 ? 'y' : 'ies'} left)`);
    return;
  }

  try {
    const stored = await deps.groupRideFaceStorage.uploadBuffer({
      matchRequestId: pending.matchRequestId,
      userId: user.id,
      imageBuffer: media.buffer,
      mimeType: media.mimeType,
    });

    await groupRideClient.upsertFaceVerificationUpload({
      matchRequestId: pending.matchRequestId,
      userId: user.id,
      bucket: stored.bucket,
      objectKey: stored.objectKey,
      mimeType: stored.mimeType,
      capturedAt: stored.capturedAt,
    });

    const completed = await groupRideClient.completeFaceVerificationAndMarkReady({
      matchRequestId: pending.matchRequestId,
      sizeBytes: stored.sizeBytes,
      capturedAt: stored.capturedAt,
    });

    await deps.publisher.publishGroupRideEvent(buildReadyForMatchEvent(completed.request));

    await clearPendingGroupRide(deps.redisClient, user.id);
    await clearBookingStage(deps.redisClient, user.id);

    await replyAndLog(deps, phone, '[Selfie]', [
      `*Selfie verified — you're all set!*`,
      ``,
      `*Matching in progress!* We're finding riders heading your way — you'll get a message here the moment your group is formed.`,
      ``,
      `You won't need a selfie again for future group rides.`,
      ``,
      `Reply *group status* to check, or *cancel group* to leave.`,
    ].join('\n'));
  } catch (error) {
    console.error('[whatsapp][group-ride] face upload failed', {
      userId: user.id,
      matchRequestId: pending.matchRequestId,
      error: error instanceof Error ? error.message : String(error),
    });
    await replyAndLog(deps, phone, '[Photo]',
      'Something went wrong saving your photo. Please send it again.');
  }
}

export async function cancelGroupRide(
  deps: MetaWhatsappRouteDeps,
  user: WhatsappUser,
  phone: string,
  incomingMessage: string,
): Promise<void> {
  const pending = await getPendingGroupRide(deps.redisClient, user.id);
  const matchRequestId = pending?.matchRequestId ?? (await getGroupRequestRider(deps.redisClient, user.id));

  let cancelled = false;
  let alreadyBooked = false;
  if (matchRequestId) {
    try {
      const result = await groupRideClient.cancelMatchRequestForUser(matchRequestId, user.id, 'rider_cancelled');
      cancelled = result.count > 0;
      if (cancelled) {
        await deps.publisher.publishGroupRideEvent({
          eventType: 'GROUP_RIDE_MATCH_CANCELLED',
          rideId: matchRequestId,
          riderId: user.id,
          reason: 'rider_cancelled',
          timestamp: new Date().toISOString(),
        });
      } else {
        const current = await groupRideClient.findMatchRequestByIdForUser(matchRequestId, user.id).catch(() => null);
        alreadyBooked = Boolean(current && ['GROUPED', 'BOOKED'].includes(String(current.status)));
      }
    } catch {
      // Already terminal (grouped/expired) — nothing to release.
    }
  }

  if (alreadyBooked) {
    // The group is already a ride with a driver — cancelling that is the
    // normal ride cancellation, with its reasons and any penalty.
    await replyAndLog(deps, phone, incomingMessage,
      'Your group is already booked with a driver, so it can\'t be dropped here. Reply *cancel* to cancel the ride itself.');
    return;
  }

  await clearPendingGroupRide(deps.redisClient, user.id);
  await clearGroupRequestRider(deps.redisClient, user.id);
  await clearBookingStage(deps.redisClient, user.id);
  await replyAndLog(deps, phone, incomingMessage, cancelled
    ? 'Group ride cancelled. Type *group ride* whenever you want to start another, or book a normal ride any time.'
    : 'No group ride to cancel. Type *group ride* to start one, or book a normal ride any time.');
}

/**
 * "normal" reply to the wait-nudge: stop the group search and rebook the
 * same trip as a standard ride, landing the rider at the familiar
 * quote → offer → bids flow.
 */
export async function convertGroupToNormalRide(
  deps: MetaWhatsappRouteDeps,
  user: WhatsappUser,
  phone: string,
  incomingMessage: string,
  matchRequestId: string,
): Promise<void> {
  const request = await groupRideClient.findMatchRequestByIdForUser(matchRequestId, user.id).catch(() => null);
  if (!request || !['READY_FOR_MATCH', 'MATCHING', 'PENDING_FACE_UPLOAD'].includes(request.status)) {
    await replyAndLog(deps, phone, incomingMessage,
      'No waiting group ride found. Type *group ride* to start one, or share a pin for a normal ride');
    return;
  }

  try {
    await groupRideClient.cancelMatchRequestForUser(matchRequestId, user.id, 'converted_to_normal_ride');
    await deps.publisher.publishGroupRideEvent({
      eventType: 'GROUP_RIDE_MATCH_CANCELLED',
      rideId: matchRequestId,
      riderId: user.id,
      reason: 'converted_to_normal_ride',
      timestamp: new Date().toISOString(),
    });
  } catch {
    // already terminal — converting is still fine
  }
  await clearGroupRequestRider(deps.redisClient, user.id);
  await clearPendingGroupRide(deps.redisClient, user.id);

  const pickup = { lat: request.pickupLat, lng: request.pickupLng, address: request.pickupAddress };
  const destination = { lat: request.destLat, lng: request.destLng, address: request.destAddress };

  const plannedRoute = await planRouteSafe(deps, pickup, destination);
  if (!plannedRoute) {
    await replyAndLog(deps, phone, incomingMessage, ROUTE_PLAN_FAILED_REPLY);
    return;
  }

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

  await quoteAndLog(deps, user, phone, incomingMessage, [
    `*Switched to a normal ride.*`,
    ``,
    `Pickup: *${pickup.address}*`,
    `Destination: *${destination.address}*`,
    `${distanceKm.toFixed(1)} km · ~${durationMin} min`,
    `Minimum fare: ₦${minFare.toLocaleString()}`,
    `Suggested fare: ₦${suggestedFare.toLocaleString()}`,
    ``,
    `Send your offer (e.g. *${suggestedFare.toLocaleString()}* or *${Math.round(suggestedFare * 0.85).toLocaleString()}*)`,
  ].join('\n'));
}

export async function sendGroupStatus(
  deps: MetaWhatsappRouteDeps,
  user: WhatsappUser,
  phone: string,
  incomingMessage: string,
): Promise<void> {
  const pending = await getPendingGroupRide(deps.redisClient, user.id);
  const matchRequestId = pending?.matchRequestId ?? (await getGroupRequestRider(deps.redisClient, user.id));

  if (!matchRequestId) {
    await replyAndLog(deps, phone, incomingMessage,
      'No group ride in progress. Type *group ride* to start one!');
    return;
  }

  const request = await groupRideClient.findMatchRequestByIdForUser(matchRequestId, user.id).catch(() => null);
  if (!request) {
    await clearGroupRequestRider(deps.redisClient, user.id);
    await replyAndLog(deps, phone, incomingMessage,
      'No group ride in progress. Type *group ride* to start one!');
    return;
  }

  const statusLine: Record<string, string> = {
    PENDING_FACE_UPLOAD: 'Waiting for your selfie — send a clear photo of your face.',
    READY_FOR_MATCH: 'Matching in progress — looking for riders heading your way.',
    MATCHING: 'Matching in progress — almost there!',
    GROUPED: 'Group found! Getting your route ready.',
    BOOKED: 'Group booked — finding your driver now.',
    EXPIRED: 'That request expired. Type *group ride* to start a new one.',
    CANCELLED: 'That request was cancelled. Type *group ride* to start a new one.',
  };

  await replyAndLog(deps, phone, incomingMessage, [
    `*Group ride status*`,
    ``,
    `Route: ${request.pickupAddress} → ${request.destAddress}`,
    statusLine[request.status] ?? `Status: ${request.status}`,
  ].join('\n'));
}

/* ─── Main POST webhook handler ─── */

