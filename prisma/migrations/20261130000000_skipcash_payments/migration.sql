-- SkipCash بدل MyFatoorah للمدفوعات الجديدة. أعمدة جديدة بس، والأوامر آمنة لو اتشغلت مرتين.
-- MyFatoorah لسه شغالة للطلبات القديمة (paymentProvider = 'MYFATOORAH' افتراضيًا).

-- 1) طلبات اشتراك المنصة: مين البوابة اللي اتدفع بيها + رقم الدفعة عند SkipCash
ALTER TABLE "subscription_orders" ADD COLUMN IF NOT EXISTS "paymentProvider" TEXT NOT NULL DEFAULT 'MYFATOORAH';
ALTER TABLE "subscription_orders" ADD COLUMN IF NOT EXISTS "skipcashPaymentId" TEXT;
ALTER TABLE "subscription_orders" ADD COLUMN IF NOT EXISTS "skipcashPaymentUrl" TEXT;
ALTER TABLE "subscription_orders" ADD COLUMN IF NOT EXISTS "skipcashVisaId" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "subscription_orders_skipcashPaymentId_key" ON "subscription_orders"("skipcashPaymentId");

-- 2) مفاتيح SkipCash الخاصة بكل تاجر (متشفّرة AES-256-GCM - مابترجعش للمتصفح أبدًا)
ALTER TABLE "tenant_payment_settings" ADD COLUMN IF NOT EXISTS "skipcashClientId" TEXT;
ALTER TABLE "tenant_payment_settings" ADD COLUMN IF NOT EXISTS "skipcashKeyId" TEXT;
ALTER TABLE "tenant_payment_settings" ADD COLUMN IF NOT EXISTS "skipcashSecretKey" TEXT;
ALTER TABLE "tenant_payment_settings" ADD COLUMN IF NOT EXISTS "skipcashWebhookKey" TEXT;
ALTER TABLE "tenant_payment_settings" ADD COLUMN IF NOT EXISTS "skipcashIsTest" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "tenant_payment_settings" ADD COLUMN IF NOT EXISTS "skipcashKeyLast4" TEXT;
-- جزء عشوائي في رابط الـ webhook بتاع التاجر (بيحدد الشركة من غير ما نكشف الـ id)
ALTER TABLE "tenant_payment_settings" ADD COLUMN IF NOT EXISTS "skipcashWebhookToken" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "tenant_payment_settings_skipcashWebhookToken_key" ON "tenant_payment_settings"("skipcashWebhookToken");
