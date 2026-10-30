// Tests that seed a bid straight into the chat's Redis state: the WhatsApp booking also needs the
// bid's database row (a real, PENDING bid by that driver on that ride), as the gateway writes it
// when a driver bids. This makes addBid write the row too, when the ride and the driver are real.
const { driverBidClient, rideClient } = require('../../packages/db/dist/index.js');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const bidState = require('../../apps/api-gateway/dist/whatsapp-flows/bid-state.js');

const realAddBid = bidState.addBid;
bidState.addBid = async (redis, rideId, bid, ...rest) => {
  const out = await realAddBid(redis, rideId, bid, ...rest);
  try {
    let ride = await rideClient.findStanding(rideId);
    if (!ride) {
      // The row ride-service writes when it hears the request, here from the chat's own record of it.
      const meta = await bidState.getRideMeta(redis, rideId);
      if (meta) {
        await prisma.ride.create({ data: {
          id: rideId, riderId: meta.riderId, status: 'MATCHING',
          pickupLat: meta.pickupLat ?? 6.5, pickupLng: meta.pickupLng ?? 3.3, pickupAddress: meta.pickupAddress ?? 'A',
          destLat: meta.destinationLat ?? 6.5, destLng: meta.destinationLng ?? 3.3, destAddress: meta.destinationAddress ?? 'B',
        } });
        ride = await rideClient.findStanding(rideId);
      }
    }
    if (ride) {
      const rows = await driverBidClient.findByRide(rideId);
      if (!rows.some((row) => row.driverId === bid.driverId)) {
        await driverBidClient.record({
          rideId, driverId: bid.driverId, driverUserId: bid.driverUserId, riderId: ride.riderId,
          amountNgn: bid.counterOfferNgn, etaSeconds: bid.etaSeconds ?? 0, distanceKm: bid.distanceKm,
        });
      }
    }
  } catch { /* not a real ride or driver in this test */ }
  return out;
};
