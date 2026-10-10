-- Catch-up migration (idempotent): these objects exist in schema.prisma but no
-- earlier migration created them. Every statement is guarded, so it is a safe
-- no-op on a database that already has them and fixes a freshly built one.

DO $$ BEGIN
  CREATE TYPE "PaymentGateStatus" AS ENUM ('NOT_REQUIRED', 'AWAITING_PAYMENT', 'PAID');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "NotificationType" AS ENUM ('BOOKING_CONFIRMED', 'CATALOG_ORDER');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "PlatformEventType" AS ENUM ('PAGE_VIEW', 'SIGNUP', 'LOGIN');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "booking_settings" ADD COLUMN IF NOT EXISTS "paymentRequired" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "booking_settings" ADD COLUMN IF NOT EXISTS "paymentAmount" DECIMAL(10,2) NOT NULL DEFAULT 0;

ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "paymentStatus" "PaymentGateStatus" NOT NULL DEFAULT 'NOT_REQUIRED';
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "amount" DECIMAL(10,2);
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "myFatoorahInvoiceId" TEXT;
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "myFatoorahPaymentId" TEXT;
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "myFatoorahPaymentUrl" TEXT;

ALTER TABLE "catalog_settings" ADD COLUMN IF NOT EXISTS "paymentRequired" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "catalog_orders" ADD COLUMN IF NOT EXISTS "paymentStatus" "PaymentGateStatus" NOT NULL DEFAULT 'NOT_REQUIRED';
ALTER TABLE "catalog_orders" ADD COLUMN IF NOT EXISTS "myFatoorahInvoiceId" TEXT;
ALTER TABLE "catalog_orders" ADD COLUMN IF NOT EXISTS "myFatoorahPaymentId" TEXT;
ALTER TABLE "catalog_orders" ADD COLUMN IF NOT EXISTS "myFatoorahPaymentUrl" TEXT;

CREATE TABLE IF NOT EXISTS "tenant_payment_settings" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "myFatoorahApiKey" TEXT,
  "myFatoorahIsTest" BOOLEAN NOT NULL DEFAULT true,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "tenant_payment_settings_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "tenant_payment_settings_tenantId_key" ON "tenant_payment_settings"("tenantId");

CREATE TABLE IF NOT EXISTS "notifications" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "type" "NotificationType" NOT NULL,
  "title" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "link" TEXT,
  "read" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "notifications_tenantId_read_idx" ON "notifications"("tenantId", "read");
CREATE INDEX IF NOT EXISTS "notifications_tenantId_createdAt_idx" ON "notifications"("tenantId", "createdAt");

CREATE TABLE IF NOT EXISTS "platform_events" (
  "id" TEXT NOT NULL,
  "type" "PlatformEventType" NOT NULL,
  "path" TEXT,
  "tenantId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "platform_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "platform_events_type_createdAt_idx" ON "platform_events"("type", "createdAt");

DO $$ BEGIN
  ALTER TABLE "tenant_payment_settings" ADD CONSTRAINT "tenant_payment_settings_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "notifications" ADD CONSTRAINT "notifications_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
