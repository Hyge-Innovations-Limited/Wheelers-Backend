-- An account's email is confirmed with a code sent to it; until then it is only what was typed.
ALTER TABLE "User" ADD COLUMN "emailVerifiedAt" TIMESTAMP(3);
