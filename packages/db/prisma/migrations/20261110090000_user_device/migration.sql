-- The devices a person uses (shown on their admin profile). A new table only: nothing else changes.
-- CreateTable
CREATE TABLE "UserDevice" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "platform" TEXT,
    "osVersion" TEXT,
    "maker" TEXT,
    "model" TEXT,
    "formFactor" TEXT,
    "browser" TEXT,
    "browserVersion" TEXT,
    "appVersion" TEXT,
    "appBuild" TEXT,
    "ramGb" DOUBLE PRECISION,
    "cpuCores" INTEGER,
    "network" TEXT,
    "saveData" BOOLEAN,
    "fromWhatsapp" BOOLEAN,
    "language" TEXT,
    "timeZone" TEXT,
    "screen" TEXT,
    "phoneNetwork" TEXT,
    "formsOpen" BOOLEAN,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "timesSeen" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "UserDevice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UserDevice_userId_idx" ON "UserDevice"("userId");

-- CreateIndex
CREATE INDEX "UserDevice_platform_idx" ON "UserDevice"("platform");

-- CreateIndex
CREATE UNIQUE INDEX "UserDevice_userId_key_key" ON "UserDevice"("userId", "key");

