-- خصم شهري لكل خدمة + أسعار حسب الدولة + تفعيل تلقائي بعد الدفع
ALTER TABLE "platform_settings" ADD COLUMN IF NOT EXISTS "moduleDiscounts" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "platform_settings" ADD COLUMN IF NOT EXISTS "pricingRegions" JSONB NOT NULL DEFAULT '[]';

ALTER TABLE "subscription_orders" ADD COLUMN IF NOT EXISTS "amountUsd" DECIMAL(18,6);
ALTER TABLE "subscription_orders" ADD COLUMN IF NOT EXISTS "country" TEXT;
-- الطلبات القديمة كلها كانت بالدولار
UPDATE "subscription_orders" SET "amountUsd" = "amount" WHERE "amountUsd" IS NULL AND "currency" = 'USD';

ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'SUBSCRIPTION_ACTIVATED';
