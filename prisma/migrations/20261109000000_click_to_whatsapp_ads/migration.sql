-- Click-to-WhatsApp ads: which ad a WhatsApp conversation came from + conversations counted by Meta per ad
ALTER TABLE "whatsapp_conversations" ADD COLUMN IF NOT EXISTS "sourceAdId" TEXT;
ALTER TABLE "whatsapp_conversations" ADD COLUMN IF NOT EXISTS "sourceAdHeadline" TEXT;
ALTER TABLE "whatsapp_conversations" ADD COLUMN IF NOT EXISTS "sourceAt" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "whatsapp_conversations_tenantId_sourceAdId_idx" ON "whatsapp_conversations"("tenantId", "sourceAdId");

ALTER TABLE "social_ad_campaigns" ADD COLUMN IF NOT EXISTS "conversations" INTEGER NOT NULL DEFAULT 0;
