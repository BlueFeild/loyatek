-- Link-in-Bio: أشكال جاهزة + صورة غلاف + إعدادات الشكل (أزرار/خط/لينك مميز/أيقونات السوشيال)
-- "classic" = الشكل القديم بالظبط (لون خلفية واحد)، فمفيش صفحة بتتغير لوحدها
ALTER TABLE "linktree_settings" ADD COLUMN IF NOT EXISTS "pageTemplate" TEXT NOT NULL DEFAULT 'classic';
ALTER TABLE "linktree_settings" ADD COLUMN IF NOT EXISTS "pageStyle" JSONB;
ALTER TABLE "linktree_settings" ADD COLUMN IF NOT EXISTS "coverDataUrl" TEXT;
ALTER TABLE "linktree_settings" ADD COLUMN IF NOT EXISTS "backgroundDataUrl" TEXT;
