-- أكواد الخصم للحجز والمنيو (2026-11-26). المتجر عنده كوبوناته الخاصة من قبل (store_coupons).
-- كل الأرقام بالدولار. idempotent: ينفع يتشغل أكتر من مرة.

CREATE TABLE IF NOT EXISTS "promo_codes" (
  "id"          TEXT NOT NULL,
  "tenantId"    TEXT NOT NULL,
  "service"     TEXT NOT NULL,
  "code"        TEXT NOT NULL,
  "kind"        TEXT NOT NULL,
  "value"       DECIMAL(18,6) NOT NULL,
  "minOrderUsd" DECIMAL(18,6),
  "maxUses"     INTEGER,
  "usedCount"   INTEGER NOT NULL DEFAULT 0,
  "startsAt"    TIMESTAMP(3),
  "endsAt"      TIMESTAMP(3),
  "active"      BOOLEAN NOT NULL DEFAULT true,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "promo_codes_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "promo_codes_tenantId_service_code_key" ON "promo_codes"("tenantId", "service", "code");
CREATE INDEX IF NOT EXISTS "promo_codes_tenantId_service_idx" ON "promo_codes"("tenantId", "service");

CREATE TABLE IF NOT EXISTS "promo_redemptions" (
  "id"          TEXT NOT NULL,
  "tenantId"    TEXT NOT NULL,
  "promoId"     TEXT NOT NULL,
  "orderType"   TEXT NOT NULL,
  "orderId"     TEXT NOT NULL,
  "discountUsd" DECIMAL(18,6) NOT NULL,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "promo_redemptions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "promo_redemptions_promoId_orderType_orderId_key" ON "promo_redemptions"("promoId", "orderType", "orderId");
CREATE INDEX IF NOT EXISTS "promo_redemptions_orderType_orderId_idx" ON "promo_redemptions"("orderType", "orderId");
CREATE INDEX IF NOT EXISTS "promo_redemptions_tenantId_idx" ON "promo_redemptions"("tenantId");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'promo_redemptions_promoId_fkey') THEN
    ALTER TABLE "promo_redemptions" ADD CONSTRAINT "promo_redemptions_promoId_fkey"
      FOREIGN KEY ("promoId") REFERENCES "promo_codes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- الكود والخصم على الحجز / طلب المنيو نفسه
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "promoCode" TEXT;
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "discountUsd" DECIMAL(18,6);
ALTER TABLE "catalog_orders" ADD COLUMN IF NOT EXISTS "promoCode" TEXT;
ALTER TABLE "catalog_orders" ADD COLUMN IF NOT EXISTS "discountUsd" DECIMAL(18,6);
