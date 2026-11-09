-- زرار "الطلب جاهز": وقت التجهيز + نتيجة رسالة واتساب للعميل، ولغة قوالب الأوردرات
ALTER TABLE "catalog_orders" ADD COLUMN IF NOT EXISTS "readyAt" TIMESTAMP(3);
ALTER TABLE "catalog_orders" ADD COLUMN IF NOT EXISTS "readyNotify" TEXT;
ALTER TABLE "catalog_orders" ADD COLUMN IF NOT EXISTS "readyNotifyError" TEXT;
ALTER TABLE "catalog_settings" ADD COLUMN IF NOT EXISTS "waTemplateLang" TEXT NOT NULL DEFAULT 'en';
