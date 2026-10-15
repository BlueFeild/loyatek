-- السوبر أدمن: إيقاف / أرشفة الحسابات، أيام سماح لكل شركة، وأسعار الخدمات من اللوحة
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "accountStatus" TEXT NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "statusReason" TEXT;
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "statusChangedAt" TIMESTAMP(3);
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "graceDays" INTEGER;

ALTER TABLE "platform_settings" ADD COLUMN IF NOT EXISTS "modulePrices" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "platform_settings" ADD COLUMN IF NOT EXISTS "extraCompanyBasePrice" DECIMAL(18,6);
ALTER TABLE "platform_settings" ADD COLUMN IF NOT EXISTS "yearlyDiscountPct" INTEGER;
ALTER TABLE "platform_settings" ADD COLUMN IF NOT EXISTS "defaultGraceDays" INTEGER NOT NULL DEFAULT 3;
