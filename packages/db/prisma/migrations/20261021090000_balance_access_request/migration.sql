-- Support asking to see one person's wallet balance, for a money issue, and
-- an owner's answer. Approved, the balance is shown to that admin until expiresAt.
CREATE TABLE "BalanceAccessRequest" (
    "id" TEXT NOT NULL,
    "adminId" TEXT NOT NULL,
    "adminName" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "decidedById" TEXT,
    "decidedByName" TEXT,
    "decidedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BalanceAccessRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "BalanceAccessRequest_status_createdAt_idx" ON "BalanceAccessRequest"("status", "createdAt");
CREATE INDEX "BalanceAccessRequest_adminId_userId_createdAt_idx" ON "BalanceAccessRequest"("adminId", "userId", "createdAt");
