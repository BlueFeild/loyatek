-- قوالب المنيو العام (نفس قوالب صفحة الحجز)
ALTER TABLE "catalog_settings" ADD COLUMN IF NOT EXISTS "pageTemplate" TEXT NOT NULL DEFAULT 'classic';
ALTER TABLE "catalog_settings" ADD COLUMN IF NOT EXISTS "pageFont" TEXT NOT NULL DEFAULT 'modern';
ALTER TABLE "catalog_settings" ADD COLUMN IF NOT EXISTS "coverDataUrl" TEXT;
