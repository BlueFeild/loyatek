-- طرق الشحن للمتجر + ربط شركات الشحن (Aramex / FedEx / DHL) - 2026-11-26
-- idempotent: ينفع يتشغل أكتر من مرة. الطريقة القديمة (توصيل بالمناطق + استلام) بتفضل شغالة لما shippingMethods = null.

ALTER TABLE "store_settings" ADD COLUMN IF NOT EXISTS "shippingMethods" JSONB;
ALTER TABLE "store_settings" ADD COLUMN IF NOT EXISTS "shippingOrigin" JSONB;
ALTER TABLE "store_settings" ADD COLUMN IF NOT EXISTS "shippingPackage" JSONB;

ALTER TABLE "store_orders" ADD COLUMN IF NOT EXISTS "shippingMethodId" TEXT;
ALTER TABLE "store_orders" ADD COLUMN IF NOT EXISTS "shippingMethodLabel" TEXT;
ALTER TABLE "store_orders" ADD COLUMN IF NOT EXISTS "shippingCarrier" TEXT;
ALTER TABLE "store_orders" ADD COLUMN IF NOT EXISTS "shippingService" TEXT;
ALTER TABLE "store_orders" ADD COLUMN IF NOT EXISTS "shippingCountry" TEXT;
ALTER TABLE "store_orders" ADD COLUMN IF NOT EXISTS "shippingCity" TEXT;
ALTER TABLE "store_orders" ADD COLUMN IF NOT EXISTS "shippingPostalCode" TEXT;

CREATE TABLE IF NOT EXISTS "store_carrier_accounts" (
  "id"            TEXT NOT NULL,
  "tenantId"      TEXT NOT NULL,
  "carrier"       TEXT NOT NULL,
  "mode"          TEXT NOT NULL DEFAULT 'TEST',
  "credentials"   TEXT NOT NULL,
  "accountHint"   TEXT,
  "enabled"       BOOLEAN NOT NULL DEFAULT true,
  "lastCheckedAt" TIMESTAMP(3),
  "lastError"     TEXT,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "store_carrier_accounts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "store_carrier_accounts_tenantId_carrier_key" ON "store_carrier_accounts"("tenantId", "carrier");

CREATE TABLE IF NOT EXISTS "store_shipments" (
  "id"             TEXT NOT NULL,
  "tenantId"       TEXT NOT NULL,
  "orderId"        TEXT NOT NULL,
  "carrier"        TEXT NOT NULL,
  "service"        TEXT,
  "mode"           TEXT NOT NULL DEFAULT 'TEST',
  "status"         TEXT NOT NULL DEFAULT 'CREATING',
  "trackingNumber" TEXT,
  "labelPdf"       BYTEA,
  "labelUrl"       TEXT,
  "trackingStatus" TEXT,
  "trackingEvents" JSONB,
  "lastTrackedAt"  TIMESTAMP(3),
  "deliveredAt"    TIMESTAMP(3),
  "error"          TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "store_shipments_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "store_shipments_orderId_key" ON "store_shipments"("orderId");
CREATE INDEX IF NOT EXISTS "store_shipments_tenantId_createdAt_idx" ON "store_shipments"("tenantId", "createdAt");
CREATE INDEX IF NOT EXISTS "store_shipments_status_trackingStatus_idx" ON "store_shipments"("status", "trackingStatus");
