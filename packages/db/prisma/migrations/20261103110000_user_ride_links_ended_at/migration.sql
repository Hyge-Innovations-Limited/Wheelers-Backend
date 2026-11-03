-- Booking page links no longer expire; "new link" in the chat ends every earlier one.
ALTER TABLE "User" ADD COLUMN "rideLinksEndedAt" TIMESTAMP(3);
