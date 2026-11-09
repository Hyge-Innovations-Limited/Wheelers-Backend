-- Trip chat and Live call.
--
-- A chat line is either typed ("text") or written by the call service when a
-- call ends ("call": "Missed call", "Call · 3:12"). Existing rows are typed.
--
-- TripCall records every Live call between a trip's rider and driver: who rang
-- whom, where the callee was reached (the app, or WhatsApp), and how it ended.

ALTER TABLE "ChatMessage" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'text';

CREATE TABLE "TripCall" (
    "id" TEXT NOT NULL,
    "rideId" TEXT NOT NULL,
    "callerId" TEXT NOT NULL,
    "callerRole" "ChatSenderRole" NOT NULL,
    "calleeId" TEXT NOT NULL,
    "calleeChannel" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RINGING',
    "endReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "answeredAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "durationSeconds" INTEGER,

    CONSTRAINT "TripCall_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TripCall_rideId_createdAt_idx" ON "TripCall"("rideId", "createdAt");
CREATE INDEX "TripCall_createdAt_idx" ON "TripCall"("createdAt");

ALTER TABLE "TripCall" ADD CONSTRAINT "TripCall_rideId_fkey" FOREIGN KEY ("rideId") REFERENCES "Ride"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
