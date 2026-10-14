-- واتساب حقيقي: تأكيد الربط من Meta، Webhook لاستقبال الرسايل، بوت ردود
-- تلقائية، قوالب حجز معتمدة، وتذكير قبل الميعاد

ALTER TABLE "whatsapp_settings" ADD COLUMN IF NOT EXISTS "displayPhoneNumber" TEXT;
ALTER TABLE "whatsapp_settings" ADD COLUMN IF NOT EXISTS "verifiedName" TEXT;
ALTER TABLE "whatsapp_settings" ADD COLUMN IF NOT EXISTS "lastVerifiedAt" TIMESTAMP(3);
ALTER TABLE "whatsapp_settings" ADD COLUMN IF NOT EXISTS "lastVerifyError" TEXT;
ALTER TABLE "whatsapp_settings" ADD COLUMN IF NOT EXISTS "webhookKey" TEXT;
ALTER TABLE "whatsapp_settings" ADD COLUMN IF NOT EXISTS "webhookVerifyToken" TEXT;
ALTER TABLE "whatsapp_settings" ADD COLUMN IF NOT EXISTS "metaAppSecret" TEXT;
ALTER TABLE "whatsapp_settings" ADD COLUMN IF NOT EXISTS "lastWebhookAt" TIMESTAMP(3);
ALTER TABLE "whatsapp_settings" ADD COLUMN IF NOT EXISTS "botEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "whatsapp_settings" ADD COLUMN IF NOT EXISTS "botFallbackReply" TEXT NOT NULL DEFAULT '';
CREATE UNIQUE INDEX IF NOT EXISTS "whatsapp_settings_webhookKey_key" ON "whatsapp_settings"("webhookKey");

ALTER TABLE "whatsapp_templates" ADD COLUMN IF NOT EXISTS "purpose" TEXT;

ALTER TABLE "booking_settings" ADD COLUMN IF NOT EXISTS "waTemplateLang" TEXT NOT NULL DEFAULT 'en';
ALTER TABLE "booking_settings" ADD COLUMN IF NOT EXISTS "reminderEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "booking_settings" ADD COLUMN IF NOT EXISTS "reminderHoursBefore" INTEGER NOT NULL DEFAULT 24;
ALTER TABLE "booking_settings" ADD COLUMN IF NOT EXISTS "timezone" TEXT NOT NULL DEFAULT 'Asia/Qatar';

ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "reminderSentAt" TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "whatsapp_messages" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "contactPhone" TEXT NOT NULL,
    "contactName" TEXT,
    "body" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'text',
    "waMessageId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'sent',
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "whatsapp_messages_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "whatsapp_messages_waMessageId_key" ON "whatsapp_messages"("waMessageId");
CREATE INDEX IF NOT EXISTS "whatsapp_messages_tenantId_contactPhone_createdAt_idx" ON "whatsapp_messages"("tenantId", "contactPhone", "createdAt");
CREATE INDEX IF NOT EXISTS "whatsapp_messages_tenantId_createdAt_idx" ON "whatsapp_messages"("tenantId", "createdAt");
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'whatsapp_messages_tenantId_fkey') THEN
    ALTER TABLE "whatsapp_messages" ADD CONSTRAINT "whatsapp_messages_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "whatsapp_auto_replies" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "keywords" TEXT[],
    "reply" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "whatsapp_auto_replies_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "whatsapp_auto_replies_tenantId_idx" ON "whatsapp_auto_replies"("tenantId");
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'whatsapp_auto_replies_tenantId_fkey') THEN
    ALTER TABLE "whatsapp_auto_replies" ADD CONSTRAINT "whatsapp_auto_replies_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
