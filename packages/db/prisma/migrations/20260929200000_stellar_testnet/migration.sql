-- Stellar Testnet (grant deliverable 3). Wheelers holds a testnet account for
-- each rider and driver, and one for operations. Only public addresses are
-- kept: secrets are derived on the server and never stored. Every transfer
-- (account opening, top-up, fare, commission, withdrawal) is queued here and
-- confirmed by a background job, once, with its transaction hash.

CREATE TABLE "StellarAccount" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "role" TEXT NOT NULL DEFAULT 'user',
    "publicKey" TEXT NOT NULL,
    "derivationIndex" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "openedAt" TIMESTAMP(3),

    CONSTRAINT "StellarAccount_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "StellarTransfer" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "rideId" TEXT,
    "userId" TEXT,
    "fromPublicKey" TEXT NOT NULL,
    "toPublicKey" TEXT NOT NULL,
    "amountXlm" DECIMAL(20,7) NOT NULL,
    "amountNgn" DECIMAL(18,2),
    "memo" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "txHash" TEXT,
    "ledger" INTEGER,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submittedAt" TIMESTAMP(3),
    "confirmedAt" TIMESTAMP(3),

    CONSTRAINT "StellarTransfer_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StellarAccount_userId_key" ON "StellarAccount"("userId");

CREATE UNIQUE INDEX "StellarAccount_publicKey_key" ON "StellarAccount"("publicKey");

CREATE UNIQUE INDEX "StellarAccount_derivationIndex_key" ON "StellarAccount"("derivationIndex");

CREATE INDEX "StellarAccount_role_idx" ON "StellarAccount"("role");

CREATE UNIQUE INDEX "StellarTransfer_reference_key" ON "StellarTransfer"("reference");

CREATE UNIQUE INDEX "StellarTransfer_txHash_key" ON "StellarTransfer"("txHash");

CREATE INDEX "StellarTransfer_status_createdAt_idx" ON "StellarTransfer"("status", "createdAt");

CREATE INDEX "StellarTransfer_rideId_idx" ON "StellarTransfer"("rideId");

CREATE INDEX "StellarTransfer_userId_createdAt_idx" ON "StellarTransfer"("userId", "createdAt");

