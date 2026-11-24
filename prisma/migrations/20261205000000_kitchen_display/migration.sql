-- شاشة المطبخ + صفحة متابعة الطلب للعميل (2026-11-24)
ALTER TABLE "catalog_orders" ADD COLUMN IF NOT EXISTS "orderNumber" INTEGER;
ALTER TABLE "catalog_orders" ADD COLUMN IF NOT EXISTS "note" TEXT;
ALTER TABLE "catalog_orders" ADD COLUMN IF NOT EXISTS "preparingAt" TIMESTAMP(3);
ALTER TABLE "catalog_orders" ADD COLUMN IF NOT EXISTS "completedAt" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "catalog_orders_tenantId_createdAt_idx" ON "catalog_orders"("tenantId", "createdAt");

ALTER TABLE "catalog_settings" ADD COLUMN IF NOT EXISTS "orderSeq" INTEGER NOT NULL DEFAULT 0;

-- الطلبات القديمة اللي اتسلّمت (COMPLETED) ماتظهرش في شاشة المطبخ
UPDATE "catalog_orders" SET "completedAt" = COALESCE("readyAt", "createdAt") WHERE "status" = 'COMPLETED' AND "completedAt" IS NULL;
