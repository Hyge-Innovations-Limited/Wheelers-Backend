-- CreateEnum
CREATE TYPE "AdminRole" AS ENUM ('OWNER', 'STAFF');

-- AlterTable
ALTER TABLE "AdminUser" ADD COLUMN     "role" "AdminRole" NOT NULL DEFAULT 'STAFF';

-- CreateTable
CREATE TABLE "AdminActivity" (
    "id" TEXT NOT NULL,
    "adminId" TEXT,
    "adminName" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "page" TEXT,
    "detail" JSONB,
    "flagged" BOOLEAN NOT NULL DEFAULT false,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminActivity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdminActivity_createdAt_idx" ON "AdminActivity"("createdAt");

-- CreateIndex
CREATE INDEX "AdminActivity_adminId_createdAt_idx" ON "AdminActivity"("adminId", "createdAt");

-- CreateIndex
CREATE INDEX "AdminActivity_flagged_createdAt_idx" ON "AdminActivity"("flagged", "createdAt");


-- Everyone already here was let in by the founders and keeps seeing
-- everything, except Ajuwonlo, who is staff. Roles change on the Team page.
UPDATE "AdminUser" SET "role" = 'OWNER' WHERE "username" <> 'ajuwonlo';
