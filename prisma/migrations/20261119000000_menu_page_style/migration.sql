-- ألوان المنيو العام (خلفية / كروت / كلام / زراير) - نفس شكل pageStyle في الحجز
ALTER TABLE "catalog_settings" ADD COLUMN IF NOT EXISTS "pageStyle" JSONB;

-- القوالب الغامقة اتشالت: أي حد عليها يروح "bluefield" (فاتح)، والافتراضي بقى bluefield
UPDATE "booking_settings" SET "pageTemplate" = 'bluefield' WHERE "pageTemplate" IN ('classic', 'noir', 'forest', 'midnight');
UPDATE "catalog_settings" SET "pageTemplate" = 'bluefield' WHERE "pageTemplate" IN ('classic', 'noir', 'forest', 'midnight');
ALTER TABLE "booking_settings" ALTER COLUMN "pageTemplate" SET DEFAULT 'bluefield';
ALTER TABLE "catalog_settings" ALTER COLUMN "pageTemplate" SET DEFAULT 'bluefield';
