-- Where a ride for later was booked: "WHATSAPP" (the ride page) or null (the app).
ALTER TABLE "ScheduledRide" ADD COLUMN "channel" TEXT;
