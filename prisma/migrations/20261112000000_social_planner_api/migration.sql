-- السوشيال: كالندر + بوستات متكررة + موافقة العميل + تقرير شهري White label
-- + مفاتيح API و Webhooks + سيناريوهات على انستجرام/ماسنجر
ALTER TABLE "social_posts" ADD COLUMN IF NOT EXISTS "repeatEvery" TEXT;
ALTER TABLE "social_posts" ADD COLUMN IF NOT EXISTS "repeatUntil" TIMESTAMP(3);
ALTER TABLE "social_posts" ADD COLUMN IF NOT EXISTS "seriesId" TEXT;
ALTER TABLE "social_posts" ADD COLUMN IF NOT EXISTS "approvalStatus" TEXT;
ALTER TABLE "social_posts" ADD COLUMN IF NOT EXISTS "approvalTokenHash" TEXT;
ALTER TABLE "social_posts" ADD COLUMN IF NOT EXISTS "approvalNote" TEXT;
ALTER TABLE "social_posts" ADD COLUMN IF NOT EXISTS "approvalBy" TEXT;
ALTER TABLE "social_posts" ADD COLUMN IF NOT EXISTS "approvalAt" TIMESTAMP(3);
CREATE UNIQUE INDEX IF NOT EXISTS "social_posts_approvalTokenHash_key" ON "social_posts"("approvalTokenHash");

ALTER TABLE "whatsapp_flows" ADD COLUMN IF NOT EXISTS "channels" TEXT[] DEFAULT ARRAY['whatsapp']::TEXT[];

CREATE TABLE IF NOT EXISTS "social_report_settings" (
    "tenantId" TEXT NOT NULL,
    "brandName" TEXT,
    "logoDataUrl" TEXT,
    "accentColor" TEXT,
    "hidePlatformName" BOOLEAN NOT NULL DEFAULT false,
    "recipients" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "monthlyEmail" BOOLEAN NOT NULL DEFAULT false,
    "shareToken" TEXT NOT NULL,
    "lastSentPeriod" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "social_report_settings_pkey" PRIMARY KEY ("tenantId")
);
CREATE UNIQUE INDEX IF NOT EXISTS "social_report_settings_shareToken_key" ON "social_report_settings"("shareToken");

CREATE TABLE IF NOT EXISTS "api_keys" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "createdById" TEXT,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "api_keys_keyHash_key" ON "api_keys"("keyHash");
CREATE INDEX IF NOT EXISTS "api_keys_tenantId_idx" ON "api_keys"("tenantId");

CREATE TABLE IF NOT EXISTS "webhook_endpoints" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "events" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "secret" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastStatus" INTEGER,
    "lastError" TEXT,
    "lastDeliveredAt" TIMESTAMP(3),
    "failCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "webhook_endpoints_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "webhook_endpoints_tenantId_idx" ON "webhook_endpoints"("tenantId");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'social_report_settings_tenantId_fkey') THEN
    ALTER TABLE "social_report_settings" ADD CONSTRAINT "social_report_settings_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'api_keys_tenantId_fkey') THEN
    ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'webhook_endpoints_tenantId_fkey') THEN
    ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
