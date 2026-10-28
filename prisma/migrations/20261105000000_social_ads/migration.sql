-- الإعلانات المدفوعة على Meta ("تمويل بوست") + حدود الميزانية من السوبر أدمن (idempotent)

ALTER TABLE "platform_settings" ADD COLUMN IF NOT EXISTS "adsMaxDailyBudgetUsd" INTEGER NOT NULL DEFAULT 100;
ALTER TABLE "platform_settings" ADD COLUMN IF NOT EXISTS "adsMaxDays" INTEGER NOT NULL DEFAULT 30;

CREATE TABLE IF NOT EXISTS "social_ads_auth" (
  "tenantId" TEXT NOT NULL,
  "accessToken" TEXT NOT NULL,
  "tokenExpiresAt" TIMESTAMP(3),
  "connectedById" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "social_ads_auth_pkey" PRIMARY KEY ("tenantId")
);

CREATE TABLE IF NOT EXISTS "social_ad_campaigns" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "accountId" TEXT,
  "platform" TEXT NOT NULL,
  "postExternalId" TEXT NOT NULL,
  "permalink" TEXT,
  "caption" TEXT,
  "adAccountId" TEXT NOT NULL,
  "adAccountName" TEXT,
  "currency" TEXT NOT NULL,
  "objective" TEXT NOT NULL,
  "dailyBudget" DECIMAL(18,2) NOT NULL,
  "startAt" TIMESTAMP(3) NOT NULL,
  "endAt" TIMESTAMP(3) NOT NULL,
  "targeting" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'CREATING',
  "metaStatus" TEXT,
  "reviewFeedback" TEXT,
  "error" TEXT,
  "metaCampaignId" TEXT,
  "metaAdSetId" TEXT,
  "metaCreativeId" TEXT,
  "metaAdId" TEXT,
  "impressions" INTEGER NOT NULL DEFAULT 0,
  "reach" INTEGER NOT NULL DEFAULT 0,
  "clicks" INTEGER NOT NULL DEFAULT 0,
  "engagements" INTEGER NOT NULL DEFAULT 0,
  "spend" DECIMAL(18,2) NOT NULL DEFAULT 0,
  "syncedAt" TIMESTAMP(3),
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "social_ad_campaigns_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "social_ad_campaigns_tenantId_createdAt_idx" ON "social_ad_campaigns"("tenantId", "createdAt");

CREATE TABLE IF NOT EXISTS "social_ad_events" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "campaignId" TEXT NOT NULL,
  "userId" TEXT,
  "action" TEXT NOT NULL,
  "details" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "social_ad_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "social_ad_events_campaignId_createdAt_idx" ON "social_ad_events"("campaignId", "createdAt");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'social_ads_auth_tenantId_fkey') THEN
    ALTER TABLE "social_ads_auth" ADD CONSTRAINT "social_ads_auth_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'social_ad_campaigns_tenantId_fkey') THEN
    ALTER TABLE "social_ad_campaigns" ADD CONSTRAINT "social_ad_campaigns_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'social_ad_campaigns_accountId_fkey') THEN
    ALTER TABLE "social_ad_campaigns" ADD CONSTRAINT "social_ad_campaigns_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "social_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'social_ad_events_tenantId_fkey') THEN
    ALTER TABLE "social_ad_events" ADD CONSTRAINT "social_ad_events_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'social_ad_events_campaignId_fkey') THEN
    ALTER TABLE "social_ad_events" ADD CONSTRAINT "social_ad_events_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "social_ad_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
