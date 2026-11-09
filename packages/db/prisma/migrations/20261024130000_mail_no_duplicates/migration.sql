-- The mail service never sends anything twice: a content hash for repeated calls,
-- the moment a message body went out (so a crash after it is never resent),
-- UNCONFIRMED for a message that went out without a final answer, and drafts
-- that are saved by version and sent once.

-- AlterEnum
ALTER TYPE "MailDeliveryStatus" ADD VALUE 'UNCONFIRMED';

-- AlterTable
ALTER TABLE "MailMessage" ADD COLUMN     "contentHash" TEXT;

-- AlterTable
ALTER TABLE "MailDelivery" ADD COLUMN     "bodySentAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "MailDraft" (
    "id" TEXT NOT NULL,
    "mailbox" TEXT NOT NULL,
    "toAddresses" TEXT[],
    "ccAddresses" TEXT[],
    "subject" TEXT NOT NULL DEFAULT '',
    "text" TEXT,
    "html" TEXT,
    "inReplyToInboxId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "sentMessageId" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MailDraft_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MailDraft_mailbox_updatedAt_idx" ON "MailDraft"("mailbox", "updatedAt");

-- CreateIndex
CREATE INDEX "MailMessage_contentHash_createdAt_idx" ON "MailMessage"("contentHash", "createdAt");

