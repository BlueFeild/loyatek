-- واتساب: دفتر جهات اتصال (تاجز + إلغاء اشتراك) + جدولة الحملات + تقرير الحملة
ALTER TYPE "CampaignStatus" ADD VALUE IF NOT EXISTS 'SCHEDULED';

ALTER TABLE "whatsapp_campaigns" ADD COLUMN IF NOT EXISTS "scheduledAt" TIMESTAMP(3);
ALTER TABLE "whatsapp_campaigns" ADD COLUMN IF NOT EXISTS "audienceTags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "whatsapp_campaigns" ADD COLUMN IF NOT EXISTS "audienceMatch" TEXT NOT NULL DEFAULT 'any';
ALTER TABLE "whatsapp_campaigns" ADD COLUMN IF NOT EXISTS "skippedCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "whatsapp_campaigns" ADD COLUMN IF NOT EXISTS "lastError" TEXT;
CREATE INDEX IF NOT EXISTS "whatsapp_campaigns_status_scheduledAt_idx" ON "whatsapp_campaigns"("status", "scheduledAt");

ALTER TABLE "whatsapp_messages" ADD COLUMN IF NOT EXISTS "campaignId" TEXT;
CREATE INDEX IF NOT EXISTS "whatsapp_messages_campaignId_idx" ON "whatsapp_messages"("campaignId");

CREATE TABLE IF NOT EXISTS "whatsapp_contacts" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "name" TEXT,
    "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "optedOut" BOOLEAN NOT NULL DEFAULT false,
    "optedOutAt" TIMESTAMP(3),
    "source" TEXT NOT NULL DEFAULT 'manual',
    "lastInboundAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "whatsapp_contacts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "whatsapp_contacts_tenantId_phone_key" ON "whatsapp_contacts"("tenantId", "phone");
CREATE INDEX IF NOT EXISTS "whatsapp_contacts_tenantId_optedOut_idx" ON "whatsapp_contacts"("tenantId", "optedOut");
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'whatsapp_contacts_tenantId_fkey') THEN
    ALTER TABLE "whatsapp_contacts" ADD CONSTRAINT "whatsapp_contacts_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
