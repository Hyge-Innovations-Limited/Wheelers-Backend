-- Studio devices (Timi, 20 Nov 2026): the device each ride request and each bid came from (a UserDevice id). Additive.
ALTER TABLE "Ride" ADD COLUMN "deviceId" TEXT;
ALTER TABLE "DriverBid" ADD COLUMN "deviceId" TEXT;
