-- The mail service (apps/mail-service): our own sending and receiving.
-- New tables only; nothing existing changes.

-- CreateEnum
CREATE TYPE "MailStream" AS ENUM ('TRANSACTIONAL', 'MARKETING');

-- CreateEnum
CREATE TYPE "MailPriority" AS ENUM ('URGENT', 'NORMAL');

-- CreateEnum
CREATE TYPE "MailDeliveryStatus" AS ENUM ('QUEUED', 'SENDING', 'DEFERRED', 'DELIVERED', 'BOUNCED', 'SUPPRESSED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "MailSuppressionReason" AS ENUM ('HARD_BOUNCE', 'COMPLAINT', 'UNSUBSCRIBE', 'MANUAL');

-- CreateEnum
CREATE TYPE "MailInboxKind" AS ENUM ('MESSAGE', 'BOUNCE', 'COMPLAINT', 'DMARC_REPORT');

-- CreateTable
CREATE TABLE "MailMessage" (
    "id" TEXT NOT NULL,
    "stream" "MailStream" NOT NULL DEFAULT 'TRANSACTIONAL',
    "priority" "MailPriority" NOT NULL DEFAULT 'NORMAL',
    "fromAddress" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "messageIdHeader" TEXT NOT NULL,
    "raw" BYTEA NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "idempotencyKey" TEXT,
    "tag" TEXT,
    "inReplyToInboxId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MailMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MailDelivery" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'other',
    "status" "MailDeliveryStatus" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseUntil" TIMESTAMP(3),
    "lastAttemptAt" TIMESTAMP(3),
    "lastCode" INTEGER,
    "lastEnhanced" TEXT,
    "lastResponse" TEXT,
    "mxHost" TEXT,
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MailDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MailEvent" (
    "id" TEXT NOT NULL,
    "messageId" TEXT,
    "deliveryId" TEXT,
    "type" TEXT NOT NULL,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MailEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MailSuppression" (
    "id" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "stream" TEXT NOT NULL DEFAULT 'ALL',
    "reason" "MailSuppressionReason" NOT NULL,
    "detail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MailSuppression_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MailProviderPause" (
    "provider" TEXT NOT NULL,
    "until" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MailProviderPause_pkey" PRIMARY KEY ("provider")
);

-- CreateTable
CREATE TABLE "MailMailbox" (
    "address" TEXT NOT NULL,
    "name" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MailMailbox_pkey" PRIMARY KEY ("address")
);

-- CreateTable
CREATE TABLE "MailInboxMessage" (
    "id" TEXT NOT NULL,
    "mailbox" TEXT NOT NULL,
    "kind" "MailInboxKind" NOT NULL DEFAULT 'MESSAGE',
    "fromAddress" TEXT,
    "fromName" TEXT,
    "toAddresses" TEXT[],
    "ccAddresses" TEXT[],
    "subject" TEXT NOT NULL,
    "messageIdHeader" TEXT,
    "inReplyTo" TEXT,
    "references" TEXT[],
    "threadId" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3),
    "text" TEXT,
    "html" TEXT,
    "snippet" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "auth" JSONB,
    "suspicious" BOOLEAN NOT NULL DEFAULT false,
    "remoteIp" TEXT,
    "helo" TEXT,
    "mailFrom" TEXT,
    "readAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MailInboxMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MailInboxRaw" (
    "inboxMessageId" TEXT NOT NULL,
    "raw" BYTEA NOT NULL,

    CONSTRAINT "MailInboxRaw_pkey" PRIMARY KEY ("inboxMessageId")
);

-- CreateTable
CREATE TABLE "MailAttachment" (
    "id" TEXT NOT NULL,
    "inboxMessageId" TEXT NOT NULL,
    "filename" TEXT,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "contentId" TEXT,
    "content" BYTEA NOT NULL,

    CONSTRAINT "MailAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MailMessage_messageIdHeader_key" ON "MailMessage"("messageIdHeader");

-- CreateIndex
CREATE UNIQUE INDEX "MailMessage_idempotencyKey_key" ON "MailMessage"("idempotencyKey");

-- CreateIndex
CREATE INDEX "MailMessage_createdAt_idx" ON "MailMessage"("createdAt");

-- CreateIndex
CREATE INDEX "MailMessage_tag_createdAt_idx" ON "MailMessage"("tag", "createdAt");

-- CreateIndex
CREATE INDEX "MailDelivery_status_nextAttemptAt_idx" ON "MailDelivery"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "MailDelivery_provider_lastAttemptAt_idx" ON "MailDelivery"("provider", "lastAttemptAt");

-- CreateIndex
CREATE INDEX "MailDelivery_recipient_idx" ON "MailDelivery"("recipient");

-- CreateIndex
CREATE INDEX "MailDelivery_messageId_idx" ON "MailDelivery"("messageId");

-- CreateIndex
CREATE INDEX "MailEvent_messageId_createdAt_idx" ON "MailEvent"("messageId", "createdAt");

-- CreateIndex
CREATE INDEX "MailEvent_deliveryId_idx" ON "MailEvent"("deliveryId");

-- CreateIndex
CREATE INDEX "MailEvent_type_createdAt_idx" ON "MailEvent"("type", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "MailSuppression_address_stream_key" ON "MailSuppression"("address", "stream");

-- CreateIndex
CREATE INDEX "MailInboxMessage_mailbox_kind_receivedAt_idx" ON "MailInboxMessage"("mailbox", "kind", "receivedAt");

-- CreateIndex
CREATE INDEX "MailInboxMessage_threadId_idx" ON "MailInboxMessage"("threadId");

-- CreateIndex
CREATE INDEX "MailInboxMessage_messageIdHeader_idx" ON "MailInboxMessage"("messageIdHeader");

-- CreateIndex
CREATE INDEX "MailAttachment_inboxMessageId_idx" ON "MailAttachment"("inboxMessageId");

-- AddForeignKey
ALTER TABLE "MailDelivery" ADD CONSTRAINT "MailDelivery_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "MailMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailEvent" ADD CONSTRAINT "MailEvent_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "MailMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailEvent" ADD CONSTRAINT "MailEvent_deliveryId_fkey" FOREIGN KEY ("deliveryId") REFERENCES "MailDelivery"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailInboxRaw" ADD CONSTRAINT "MailInboxRaw_inboxMessageId_fkey" FOREIGN KEY ("inboxMessageId") REFERENCES "MailInboxMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailAttachment" ADD CONSTRAINT "MailAttachment_inboxMessageId_fkey" FOREIGN KEY ("inboxMessageId") REFERENCES "MailInboxMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

