-- Rider memory for the WhatsApp bot. The Redis conversation window forgets
-- after ten turns or seven days, so the model met every rider as a stranger.
-- WhatsappMessage keeps the whole transcript; UserMemoryFact keeps what we
-- learned from it as rider → predicate → object edges.
CREATE TABLE "WhatsappMessage" (
  "id"        TEXT NOT NULL,
  "userId"    TEXT NOT NULL,
  "role"      TEXT NOT NULL,
  "content"   TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WhatsappMessage_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "WhatsappMessage_userId_createdAt_idx" ON "WhatsappMessage"("userId", "createdAt");

CREATE TABLE "UserMemoryFact" (
  "id"          TEXT NOT NULL,
  "userId"      TEXT NOT NULL,
  "predicate"   TEXT NOT NULL,
  "object"      TEXT NOT NULL,
  "weight"      INTEGER NOT NULL DEFAULT 1,
  "source"      TEXT NOT NULL DEFAULT 'llm',
  "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UserMemoryFact_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "UserMemoryFact_userId_predicate_object_key" ON "UserMemoryFact"("userId", "predicate", "object");
CREATE INDEX "UserMemoryFact_userId_predicate_idx" ON "UserMemoryFact"("userId", "predicate");
