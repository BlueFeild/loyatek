-- أكتر من طريقة دفع لكل تاجر (لينكات / تحويل بنكي / كاش / MyFatoorah)
-- والعميل بيختار. null = لسه على الإعداد القديم (طريقة واحدة)
ALTER TABLE "tenant_payment_settings" ADD COLUMN IF NOT EXISTS "methods" JSONB;

-- طريقة الدفع اللي العميل اختارها في كل حجز / أوردر
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "paymentMethodType" TEXT;
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "paymentMethodLabel" TEXT;
ALTER TABLE "catalog_orders" ADD COLUMN IF NOT EXISTS "paymentMethodType" TEXT;
ALTER TABLE "catalog_orders" ADD COLUMN IF NOT EXISTS "paymentMethodLabel" TEXT;
