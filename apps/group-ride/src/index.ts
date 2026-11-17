import { groupRideClient, pricingClient, prisma } from '@wheleers/db';
import {
  buildTopicList,
  createConsumer,
  createProducer,
  ensureTopics,
  onShutdown,
  TOPIC_PRESETS,
} from '@wheleers/kafka-client';
import {
  GoogleMapsRoutePlanner,
  groupRideLiveMode,
  loadWorkspaceEnv,
  RIDE,
  startAlerts,
  validateGroupRideEnv,
  validateSharedEnv,
} from '@wheleers/config';
import {
  GroupRideLiveOfferedEvent,
  safeParseKafkaEvent,
  TOPICS,
} from '@wheleers/kafka-schemas';
import { randomUUID } from 'node:crypto';

import { createGroupRidePlanner } from './planner/group-ride.planner';
import { createGroupRideEventsProducer } from './producers/group-ride-events.producer';
import { createGroupRideState } from './state';
import { bearingDegrees } from './algorithms/geo';
import { createLiveMatcher } from './live/live-matcher';

const SERVICE_ID = 'group-ride';

bootstrap().catch((err) => {
  console.error(`[${SERVICE_ID}] fatal`, err);
  process.exit(1);
});

async function bootstrap(): Promise<void> {
  loadWorkspaceEnv();
  startAlerts();

  process.env['NODE_ENV'] ??= 'development';
  process.env['KAFKA_CLIENT_ID'] ??= SERVICE_ID;
  process.env['KAFKA_BROKERS'] ??= 'localhost:29092';
  process.env['DATABASE_URL'] ??= 'postgresql://postgres:postgres@localhost:5432/wheelers';
  process.env['REDIS_URL'] ??= 'redis://localhost:6379';

  // The pricing settings owners save in the admin: offer limits and fares here follow them, reloaded every minute.
  await pricingClient.startSync();

  validateSharedEnv();
  const groupRideEnv = validateGroupRideEnv();

  await ensureTopics(
    buildTopicList([[TOPICS.GROUP_RIDE_EVENTS, TOPIC_PRESETS.LOW_VOLUME]]),
  );

  const producer = await createProducer({ serviceId: SERVICE_ID });
  const consumer = await createConsumer({ groupId: SERVICE_ID });
  const routePlanner = new GoogleMapsRoutePlanner(
    groupRideEnv.GOOGLE_MAPS_BASE_URL,
    groupRideEnv.GOOGLE_MAPS_API_KEY,
  );

  const planner = createGroupRidePlanner({
    env: groupRideEnv,
    routePlanner,
    groupRideEventsProducer: createGroupRideEventsProducer(producer),
    state: createGroupRideState(),
  });

  const readyRequests = await groupRideClient.findReadyRequests().catch(() => []);
  for (const request of readyRequests) {
    await planner.seedRequest({
      rideId: request.id,
      riderId: request.userId,
      pickup: {
        lat: request.pickupLat,
        lng: request.pickupLng,
        address: request.pickupAddress,
      },
      destination: {
        lat: request.destLat,
        lng: request.destLng,
        address: request.destAddress,
      },
      genderPreference:
        request.genderPreference === 'WOMEN_ONLY'
          ? 'women_only'
          : request.genderPreference === 'MEN_ONLY'
            ? 'men_only'
            : 'any',
      headingDeg: bearingDegrees(
        { lat: request.pickupLat, lng: request.pickupLng },
        { lat: request.destLat, lng: request.destLng },
      ),
      fareEstimateNgn: Number(request.fareEstimateNgn ?? 0),
      requestedAt: (request.readyForMatchAt ?? request.createdAt).toISOString(),
      sourceEvent: {
        eventType: 'GROUP_RIDE_READY_FOR_MATCH',
        rideId: request.id,
        riderId: request.userId,
        faceVerificationId: request.faceVerification?.id ?? '',
        pickup: {
          lat: request.pickupLat,
          lng: request.pickupLng,
          address: request.pickupAddress,
        },
        destination: {
          lat: request.destLat,
          lng: request.destLng,
          address: request.destAddress,
        },
        stops: Array.isArray(request.stops) ? (request.stops as any) : [],
        plannedDistanceKm: request.plannedDistanceKm ?? undefined,
        plannedDurationSeconds: request.plannedDurationSeconds ?? undefined,
        fareEstimateNgn: Number(request.fareEstimateNgn ?? 0),
        genderPreference:
          request.genderPreference === 'WOMEN_ONLY'
            ? 'women_only'
            : request.genderPreference === 'MEN_ONLY'
              ? 'men_only'
              : 'any',
        paymentMethod: 'wallet_balance' as const,
        timestamp: (request.readyForMatchAt ?? request.createdAt).toISOString(),
      },
    });
  }

  // Group ride on live searches (GROUP_RIDE_LIVE, off unless set): riders already searching who are heading
  // along the same road. dryrun logs the groups it would offer and asks nobody.
  const liveMode = groupRideLiveMode();
  const liveEvents = createGroupRideEventsProducer(producer);
  const liveMatcher = createLiveMatcher({
    mode: liveMode,
    // GROUP_RIDE_LIVE=on: the gateway holds the searches and asks the riders.
    onProposal: async (proposal) => {
      const event = GroupRideLiveOfferedEvent.parse({
        eventType: 'GROUP_RIDE_LIVE_OFFERED',
        groupId: randomUUID(),
        timestamp: new Date().toISOString(),
        rideIds: proposal.rideIds,
        members: proposal.members.map((m) => ({ rideId: m.rideId, riderId: m.riderId, offerNgn: m.offerNgn, seatPriceNgn: m.seatPriceNgn, soloSeconds: m.soloSeconds, extraSeconds: m.extraSeconds })),
        stops: proposal.stops.map((s) => ({ rideId: s.rideId, kind: s.kind, lat: s.lat, lng: s.lng, address: s.address })),
        totalSeconds: proposal.totalSeconds,
        savedSeconds: proposal.savedSeconds,
      });
      await liveEvents.publish(event as never);
    },
  });
  if (liveMode !== 'off') {
    const since = new Date(Date.now() - (RIDE.BID_TIMEOUT_SECONDS + 30) * 1000);
    const open = await prisma.ride.findMany({
      where: { status: { in: ['REQUESTED', 'MATCHING'] }, updatedAt: { gte: since }, paymentMethod: 'WALLET', routeStops: { none: { type: 'INTERMEDIATE' } } },
      select: { id: true, riderId: true, pickupLat: true, pickupLng: true, pickupAddress: true, destLat: true, destLng: true, destAddress: true, riderOfferNgn: true, passengers: true, hasPet: true, createdAt: true, updatedAt: true },
      take: 500,
    }).catch(() => []);
    liveMatcher.seed(open.filter((r) => Number(r.riderOfferNgn ?? 0) > 0).map((r) => ({
      rideId: r.id,
      riderId: r.riderId,
      pickup: { lat: r.pickupLat, lng: r.pickupLng, address: r.pickupAddress },
      destination: { lat: r.destLat, lng: r.destLng, address: r.destAddress },
      route: [],
      people: r.passengers ?? 1,
      pet: r.hasPet === true,
      paymentMethod: 'WALLET',
      offerNgn: Number(r.riderOfferNgn),
      openedAtMs: r.createdAt.getTime(),
      priceAtMs: r.updatedAt.getTime(),
    })));
    liveMatcher.start();
    console.log(`[${SERVICE_ID}] live group matching ${liveMode} (${liveMatcher.size()} open searches)`);
  }

  await consumer.subscribe(
    [TOPICS.RIDE_EVENTS, TOPICS.GROUP_RIDE_EVENTS],
    async (value, ctx) => {
      if (ctx.topic === TOPICS.RIDE_EVENTS) {
        const event = safeParseKafkaEvent(TOPICS.RIDE_EVENTS, value);
        if (!event) {
          return;
        }

        liveMatcher.onRideEvent(event);

        if (
          event.eventType === 'RIDE_CANCELLED' ||
          event.eventType === 'RIDE_COMPLETED'
        ) {
          planner.releaseRide(event.rideId);
        }

        return;
      }

      const event = safeParseKafkaEvent(TOPICS.GROUP_RIDE_EVENTS, value);
      if (!event) {
        return;
      }

      if (event.eventType === 'GROUP_RIDE_READY_FOR_MATCH') {
        await planner.handleRideReadyForMatch(event);
        return;
      }

      if (event.eventType === 'GROUP_RIDE_MATCH_CANCELLED') {
        planner.releaseRide(event.rideId);
        return;
      }

      await planner.handleGroupRideEvent(event);
    },
  );

  onShutdown(async () => {
    liveMatcher.stop();
    await consumer.disconnect();
    await producer.disconnect();
  });

  console.log(
    `[${SERVICE_ID}] consuming ` +
      `(pickupRadiusKm=${groupRideEnv.GROUP_RIDE_PICKUP_RADIUS_KM}, ` +
      `destinationRadiusKm=${groupRideEnv.GROUP_RIDE_DESTINATION_RADIUS_KM}, ` +
      `maxGroupSize=${groupRideEnv.GROUP_RIDE_MAX_SIZE})`,
  );
}
