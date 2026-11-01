-- Trip recording guards (expand only: two nullable columns, nothing existing changes)
ALTER TABLE "Ride" ADD COLUMN "recordingStartedAt" TIMESTAMP(3);
ALTER TABLE "TripRecording" ADD COLUMN "etag" TEXT;
