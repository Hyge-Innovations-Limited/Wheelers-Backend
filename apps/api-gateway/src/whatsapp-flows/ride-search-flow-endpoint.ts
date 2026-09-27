import type { IncomingMessage, ServerResponse } from 'http';
import { randomUUID } from 'crypto';
import { GoogleMapsRoutePlanner, validateRiderOffer } from '@wheleers/config';
import { RideRequestedEvent } from '@wheleers/kafka-schemas';
import type { GatewayPublisher } from '../websocket/publisher';
import type { RedisClient } from '../redis/client';
import { readRawBody, sendJson } from '../http/utils';
import { decryptFlowRequest, encryptFlowResponse, verifyFlowToken } from './encryption';
import type { FlowRequestBody } from './encryption';
import { geocodeAddress } from '../LLM/geocoding';
import { storeWhatsappRide, setActiveRide, getActiveRide } from './bid-state';

export interface RideSearchFlowDeps {
  redisClient: RedisClient;
  publisher: GatewayPublisher;
  privateKeyPem: string;
  tokenSecret: string;
  googleMapsApiKey: string;
  routePlanner: GoogleMapsRoutePlanner;
}

/** Stored in Redis when the rider mentions vague locations. */
export interface PendingRideSearch {
  userId: string;
  phone: string;
  pickupArea: string;
  destinationArea: string;
  offerNgn: number | null;
  paymentMethod: 'CASH' | 'WALLET';
  createdAt: string;
}

const PENDING_SEARCH_TTL = 600; // 10 minutes

function pendingSearchKey(userId: string): string {
  return `whatsapp:ride_search:${userId}`;
}

export async function storePendingRideSearch(
  redis: RedisClient,
  userId: string,
  data: PendingRideSearch,
): Promise<void> {
  await redis.set(pendingSearchKey(userId), JSON.stringify(data), PENDING_SEARCH_TTL);
}

async function getPendingRideSearch(
  redis: RedisClient,
  userId: string,
): Promise<PendingRideSearch | null> {
  const raw = await redis.get(pendingSearchKey(userId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PendingRideSearch;
  } catch {
    return null;
  }
}

async function clearPendingRideSearch(
  redis: RedisClient,
  userId: string,
): Promise<void> {
  await redis.del(pendingSearchKey(userId));
}

function parseFlowToken(flowToken: string, secret: string): { userId: string } | null {
  const payload = verifyFlowToken(flowToken, secret);
  if (!payload) return null;
  return { userId: payload };
}

function buildAddressFormData(
  pending: PendingRideSearch,
  error?: string,
): Record<string, unknown> {
  return {
    pickup_area: pending.pickupArea,
    destination_area: pending.destinationArea,
    pickup_hint: `e.g. Shoprite ${pending.pickupArea}, or a street name`,
    destination_hint: `e.g. a bus stop, junction, or landmark in ${pending.destinationArea}`,
    error: error ?? '',
    has_error: Boolean(error),
  };
}

async function handleFlowAction(
  body: FlowRequestBody,
  deps: RideSearchFlowDeps,
): Promise<{ screen: string; data: Record<string, unknown> }> {
  if (body.action === 'ping') {
    return { screen: 'SUCCESS', data: { status: 'active' } };
  }

  const tokenData = parseFlowToken(body.flow_token, deps.tokenSecret);
  if (!tokenData) {
    return { screen: 'CONFIRMATION', data: { message: 'Invalid session. Please send a new ride request.' } };
  }

  const { userId } = tokenData;
  const pending = await getPendingRideSearch(deps.redisClient, userId);
  if (!pending) {
    return { screen: 'CONFIRMATION', data: { message: 'This ride search has expired. Send a new message to book a ride.' } };
  }

  // INIT — show the address form pre-filled with area names
  if (body.action === 'INIT') {
    return { screen: 'ADDRESS_FORM', data: buildAddressFormData(pending) };
  }

  // BACK — return to address form
  if (body.action === 'BACK') {
    return { screen: 'ADDRESS_FORM', data: buildAddressFormData(pending) };
  }

  // data_exchange — user submitted the address form
  if (body.action === 'data_exchange') {
    const data = body.data ?? {};
    const action = data.action as string | undefined;

    if (action === 'search_ride') {
      const pickupAddress = (data.pickup_address as string)?.trim();
      const destinationAddress = (data.destination_address as string)?.trim();

      if (!pickupAddress || pickupAddress.length < 3) {
        return {
          screen: 'ADDRESS_FORM',
          data: buildAddressFormData(pending, 'Please enter a more specific pickup location (street, landmark, bus stop, etc.)'),
        };
      }

      if (!destinationAddress || destinationAddress.length < 3) {
        return {
          screen: 'ADDRESS_FORM',
          data: buildAddressFormData(pending, 'Please enter a more specific destination (street, landmark, bus stop, etc.)'),
        };
      }

      // Check for existing active ride
      const existingRide = await getActiveRide(deps.redisClient, userId);
      if (existingRide) {
        return {
          screen: 'CONFIRMATION',
          data: { message: "You already have an active ride request. Say 'cancel ride' on WhatsApp to cancel it first." },
        };
      }

      // Geocode both addresses
      const fullPickup = `${pickupAddress}, ${pending.pickupArea}, Lagos, Nigeria`;
      const fullDest = `${destinationAddress}, ${pending.destinationArea}, Lagos, Nigeria`;

      const [pickupGeo, destGeo] = await Promise.all([
        geocodeAddress(deps.googleMapsApiKey, fullPickup),
        geocodeAddress(deps.googleMapsApiKey, fullDest),
      ]);

      if (!pickupGeo) {
        return {
          screen: 'ADDRESS_FORM',
          data: buildAddressFormData(pending, `Could not find "${pickupAddress}". Try a well-known landmark, bus stop, or street name.`),
        };
      }

      if (!destGeo) {
        return {
          screen: 'ADDRESS_FORM',
          data: buildAddressFormData(pending, `Could not find "${destinationAddress}". Try a well-known landmark, bus stop, or street name.`),
        };
      }

      // Plan route and create ride
      let plannedRoute: Awaited<ReturnType<typeof deps.routePlanner.planRoute>>;
      try {
        plannedRoute = await deps.routePlanner.planRoute({
          origin: pickupGeo,
          destination: destGeo,
        });
      } catch (error) {
        console.warn('[ride-search-flow] route planning failed', {
          pickup: pickupGeo.formattedAddress,
          destination: destGeo.formattedAddress,
          error: error instanceof Error ? error.message : String(error),
        });
        return {
          screen: 'ADDRESS_FORM',
          data: buildAddressFormData(pending, 'Could not find a driving route between those two points. Please check the addresses.'),
        };
      }

      const rideId = randomUUID();
      const suggestedFareNgn = plannedRoute.suggestedFareNgn;
      const riderOfferNgn = pending.offerNgn ?? suggestedFareNgn;
      const paymentMethod = pending.paymentMethod;

      const validation = validateRiderOffer(riderOfferNgn, suggestedFareNgn);
      const finalOffer = validation.valid ? riderOfferNgn : suggestedFareNgn;

      const event = RideRequestedEvent.parse({
        eventType: 'RIDE_REQUESTED',
        channel: 'WHATSAPP',
        rideId,
        riderId: userId,
        pickup: { lat: pickupGeo.lat, lng: pickupGeo.lng, address: pickupGeo.formattedAddress },
        destination: { lat: destGeo.lat, lng: destGeo.lng, address: destGeo.formattedAddress },
        stops: [],
        plannedDistanceKm: plannedRoute.distanceKm,
        plannedDurationSeconds: plannedRoute.durationSeconds,
        fareEstimateNgn: suggestedFareNgn,
        paymentMethod,
        riderOfferNgn: finalOffer,
        suggestedFareNgn,
        minOfferNgn: plannedRoute.minOfferNgn,
        ratePerKmNgn: plannedRoute.ratePerKmNgn,
        route: plannedRoute.geometry,
        timestamp: new Date().toISOString(),
      });

      await deps.publisher.publishRideEvent(event);

      await storeWhatsappRide(deps.redisClient, rideId, {
        riderId: userId,
        phone: pending.phone,
        pickupAddress: pickupGeo.formattedAddress,
        destinationAddress: destGeo.formattedAddress,
        offerNgn: finalOffer,
        suggestedFareNgn,
        paymentMethod,
        createdAt: new Date().toISOString(),
      });
      await setActiveRide(deps.redisClient, userId, rideId);
      await clearPendingRideSearch(deps.redisClient, userId);

      const offerDisplay = `₦${finalOffer.toLocaleString()}`;
      return {
        screen: 'CONFIRMATION',
        data: {
          message: `Looking for drivers!\n\n${pickupGeo.formattedAddress}\n${destGeo.formattedAddress}\n\nYour offer: ${offerDisplay}\n\nI'll message you on WhatsApp when drivers respond!`,
        },
      };
    }

    // Default: show form again
    return { screen: 'ADDRESS_FORM', data: buildAddressFormData(pending) };
  }

  return { screen: 'CONFIRMATION', data: { message: 'Something went wrong. Please try again.' } };
}

export async function handleRideSearchFlowEndpoint(
  req: IncomingMessage,
  res: ServerResponse,
  deps: RideSearchFlowDeps,
): Promise<void> {
  try {
    const rawBody = await readRawBody(req);
    const envelope = JSON.parse(rawBody.toString('utf8'));

    let decryptedParts;
    try {
      decryptedParts = decryptFlowRequest(envelope, deps.privateKeyPem);
    } catch (error) {
      // Meta spec: 421 = "re-fetch my public key and retry" — never 500.
      console.warn('[whatsapp-ride-search-flow] could not decrypt — 421 so Meta refreshes the key', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.statusCode = 421;
      res.end();
      return;
    }
    const { decryptedBody, aesKey, iv } = decryptedParts;

    const response = await handleFlowAction(decryptedBody, deps);

    const encrypted = encryptFlowResponse(response, aesKey, iv);
    res.statusCode = 200;
    res.setHeader('content-type', 'text/plain');
    res.end(encrypted);
  } catch (error) {
    console.error('[ride-search-flow] Endpoint error', error);
    sendJson(res, 500, { error: 'Internal error' });
  }
}
