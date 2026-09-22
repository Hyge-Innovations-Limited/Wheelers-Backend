import type { WheelersProducer } from '@wheleers/kafka-client';
import {
  TOPICS,
  type GroupRideDriverAssignedEvent,
  type GpsStaleWarningEvent,
  type InAppSendEvent,
  type PushSendEvent,
  type RideBidTimeoutEvent,
  type RideCancelledEvent,
  type RideCompletedEvent,
  type RideDriverAssignedEvent,
  type RideDriverRejectedEvent,
  type RideOfferAcceptedEvent,
  type RideOfferSentEvent,
  type RideRouteUpdatedEvent,
  type RideRequestedEvent,
} from '@wheleers/kafka-schemas';
import { randomUUID } from 'node:crypto';

import type { GroupRideMemberSeatInfo, OnlineDriver } from '../index';
import { estimateEtaSeconds, haversineKm } from '../utils/geo';

/** Driver→pickup distance/ETA for an offer, from match data or coordinates. */
function pickupProximity(
  driver: OnlineDriver,
  pickup: { lat: number; lng: number },
): { pickupDistanceKm: number; pickupEtaSeconds: number } {
  const distanceKm =
    driver.distanceKm ?? haversineKm(driver.lat, driver.lng, pickup.lat, pickup.lng);
  const rounded = Math.round(distanceKm * 100) / 100;
  return { pickupDistanceKm: rounded, pickupEtaSeconds: estimateEtaSeconds(rounded) };
}

export type RideEventsProducer = {
  rideRequested(event: RideRequestedEvent): Promise<void>;
  rideDriverAssigned(event: RideDriverAssignedEvent): Promise<void>;
  rideDriverRejected(event: RideDriverRejectedEvent): Promise<void>;
  rideCancelled(event: RideCancelledEvent): Promise<void>;
  rideCompleted(event: RideCompletedEvent): Promise<void>;
  rideRouteUpdated(event: RideRouteUpdatedEvent): Promise<void>;
  rideBidTimeout(event: RideBidTimeoutEvent): Promise<void>;
  groupRideDriverAssigned(event: GroupRideDriverAssignedEvent): Promise<void>;
  rideOfferAccepted(event: RideOfferAcceptedEvent): Promise<void>;
  broadcastRideOffer(params: {
    drivers: OnlineDriver[];
    rideRequested: RideRequestedEvent;
    expiresAt: Date;
    /** Set for group rides so the driver app can badge the offer. */
    group?: { riderCount: number; stopKinds?: Array<'pickup' | 'dropoff'>; members?: GroupRideMemberSeatInfo[] };
  }): Promise<void>;
  sendUpdatedOfferToDriver(params: {
    driver: OnlineDriver;
    rideRequested: RideRequestedEvent;
    updatedOfferNgn: number;
    expiresAt: Date;
    /** Same badge as the original offer — a re-price does not change the job. */
    group?: { riderCount: number; stopKinds?: Array<'pickup' | 'dropoff'>; members?: GroupRideMemberSeatInfo[] };
  }): Promise<void>;
  gpsStaleWarning(event: GpsStaleWarningEvent): Promise<void>;
};

export function createRideEventsProducer(producer: WheelersProducer): RideEventsProducer {
  return {
    async rideRequested(event) {
      await producer.send(TOPICS.RIDE_EVENTS, event as any, { key: event.rideId });
    },

    async rideDriverAssigned(event) {
      await producer.send(TOPICS.RIDE_EVENTS, event as any, { key: event.rideId });
    },

    async rideDriverRejected(event) {
      await producer.send(TOPICS.RIDE_EVENTS, event as any, { key: event.rideId });
    },

    async rideCancelled(event) {
      await producer.send(TOPICS.RIDE_EVENTS, event as any, { key: event.rideId });
    },

    async rideCompleted(event) {
      await producer.send(TOPICS.RIDE_EVENTS, event as any, { key: event.rideId });
    },

    async rideRouteUpdated(event) {
      await producer.send(TOPICS.RIDE_EVENTS, event as any, { key: event.rideId });
    },

    async rideBidTimeout(event) {
      await producer.send(TOPICS.RIDE_EVENTS, event as any, { key: event.rideId });
    },

    async groupRideDriverAssigned(event) {
      await producer.send(TOPICS.GROUP_RIDE_EVENTS, event as any, { key: event.groupId });
    },

    async rideOfferAccepted(event) {
      await producer.send(TOPICS.RIDE_EVENTS, event as any, { key: event.rideId });
    },

    async broadcastRideOffer({ drivers, rideRequested, expiresAt, group }) {
      const timestamp = new Date().toISOString();
      const title = group ? `Group ride · ${group.riderCount} riders` : 'New ride request';
      const stopCount = rideRequested.stops.length;
      const body =
        stopCount > 0
          ? `${rideRequested.pickup.address} to ${rideRequested.destination.address} with ${stopCount} stop${stopCount === 1 ? '' : 's'}`
          : `${rideRequested.pickup.address} to ${rideRequested.destination.address}`;

      const batch: Array<{
        topic: string;
        value: any;
        options: { key: string };
      }> = [];

      for (const driver of drivers) {
        const offerEvent: RideOfferSentEvent = {
          eventType: 'RIDE_OFFER_SENT',
          rideId: rideRequested.rideId,
          riderId: rideRequested.riderId,
          driverId: driver.driverId,
          driverUserId: driver.userId,
          pickup: rideRequested.pickup,
          destination: rideRequested.destination,
          stops: rideRequested.stops,
          fareEstimateNgn: rideRequested.fareEstimateNgn,
          paymentMethod: rideRequested.paymentMethod,
          riderOfferNgn: rideRequested.riderOfferNgn,
          suggestedFareNgn: rideRequested.suggestedFareNgn,
          minOfferNgn: rideRequested.minOfferNgn,
          ratePerKmNgn: rideRequested.ratePerKmNgn,
          plannedDistanceKm: rideRequested.plannedDistanceKm,
          plannedDurationSeconds: rideRequested.plannedDurationSeconds,
          ...pickupProximity(driver, rideRequested.pickup),
          ...(driver.afterCurrentTrip ? { afterCurrentTrip: true } : {}),
          expiresAt: expiresAt.toISOString(),
          // Same instant as expiresAt — the card and the auction are one
          // clock now. Sent under its own name so clients state intent.
          bidsCloseAt: expiresAt.toISOString(),
          route: rideRequested.route,
          timestamp,
          ...(group
            ? {
                isGroupRide: true,
                riderCount: group.riderCount,
                ...(group.stopKinds ? { stopKinds: group.stopKinds } : {}),
                ...(group.members ? { groupMembers: group.members } : {}),
              }
            : {}),
        };

        batch.push({
          topic: TOPICS.RIDE_EVENTS,
          value: offerEvent,
          options: { key: rideRequested.rideId },
        });

        const push: PushSendEvent = {
          eventType: 'PUSH_SEND',
          notificationId: randomUUID(),
          userId: driver.userId,
          title,
          body: `${body} | ₦${rideRequested.riderOfferNgn} offered | ${rideRequested.paymentMethod}`,
          data: {
            type: 'ride:request',
            rideId: rideRequested.rideId,
            riderId: rideRequested.riderId,
            pickupAddress: rideRequested.pickup.address,
            destinationAddress: rideRequested.destination.address,
            riderOfferNgn: String(rideRequested.riderOfferNgn),
            suggestedFareNgn: String(rideRequested.suggestedFareNgn),
            paymentMethod: rideRequested.paymentMethod,
            expiresAt: expiresAt.toISOString(),
          // Same instant as expiresAt — the card and the auction are one
          // clock now. Sent under its own name so clients state intent.
          bidsCloseAt: expiresAt.toISOString(),
          },
          priority: 'high',
          timestamp,
        };

        const inApp: InAppSendEvent = {
          eventType: 'IN_APP_SEND',
          notificationId: randomUUID(),
          userId: driver.userId,
          title,
          body: `${body} | ₦${rideRequested.riderOfferNgn} offered | ${rideRequested.paymentMethod}`,
          category: 'ride',
          referenceId: rideRequested.rideId,
          referenceType: 'ride',
          read: false,
          timestamp,
        };

        batch.push(
          { topic: TOPICS.NOTIFICATION_EVENTS, value: push, options: { key: driver.driverId } },
          { topic: TOPICS.NOTIFICATION_EVENTS, value: inApp, options: { key: driver.driverId } },
        );
      }

      if (batch.length > 0) {
        await producer.sendBatch(batch);
      }
    },

    async sendUpdatedOfferToDriver({ driver, rideRequested, updatedOfferNgn, expiresAt, group }) {
      const timestamp = new Date().toISOString();

      const offerEvent: RideOfferSentEvent = {
        eventType: 'RIDE_OFFER_SENT',
        rideId: rideRequested.rideId,
        riderId: rideRequested.riderId,
        driverId: driver.driverId,
        driverUserId: driver.userId,
        pickup: rideRequested.pickup,
        destination: rideRequested.destination,
        stops: rideRequested.stops,
        fareEstimateNgn: rideRequested.fareEstimateNgn,
        paymentMethod: rideRequested.paymentMethod,
        riderOfferNgn: updatedOfferNgn,
        suggestedFareNgn: rideRequested.suggestedFareNgn,
        minOfferNgn: rideRequested.minOfferNgn,
        ratePerKmNgn: rideRequested.ratePerKmNgn,
        plannedDistanceKm: rideRequested.plannedDistanceKm,
        plannedDurationSeconds: rideRequested.plannedDurationSeconds,
        ...pickupProximity(driver, rideRequested.pickup),
        expiresAt: expiresAt.toISOString(),
        route: rideRequested.route,
        timestamp,
        // A re-price replaces the offer card in the driver app. Omitting these
        // stripped the group badge and the pickup/dropoff labels off a shared
        // ride the moment the rider changed their bid.
        ...(group
          ? {
              isGroupRide: true,
              riderCount: group.riderCount,
              ...(group.stopKinds ? { stopKinds: group.stopKinds } : {}),
              ...(group.members ? { groupMembers: group.members } : {}),
            }
          : {}),
      };

      const push: PushSendEvent = {
        eventType: 'PUSH_SEND',
        notificationId: randomUUID(),
        userId: driver.userId,
        title: group ? `Updated offer · group ride (${group.riderCount} riders)` : 'Updated rider offer',
        body: `Rider updated their offer to ₦${updatedOfferNgn} for ${rideRequested.pickup.address} → ${rideRequested.destination.address}`,
        data: {
          type: 'ride:offer_updated',
          rideId: rideRequested.rideId,
          riderOfferNgn: String(updatedOfferNgn),
        },
        priority: 'high',
        timestamp,
      };

      await producer.sendBatch([
        { topic: TOPICS.RIDE_EVENTS, value: offerEvent, options: { key: rideRequested.rideId } },
        { topic: TOPICS.NOTIFICATION_EVENTS, value: push, options: { key: driver.driverId } },
      ]);
    },

    async gpsStaleWarning(event) {
      await producer.send(TOPICS.COMPLIANCE_EVENTS, event as any, { key: event.rideId });
    },
  };
}
