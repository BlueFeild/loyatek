-- خصم على صنف المنيو (نسبة 1-90 + تاريخ انتهاء اختياري) وخصومات خدمات الحجز
ALTER TABLE "menu_items" ADD COLUMN IF NOT EXISTS "discountPct" INTEGER;
ALTER TABLE "menu_items" ADD COLUMN IF NOT EXISTS "discountEndsAt" TIMESTAMP(3);
ALTER TABLE "booking_settings" ADD COLUMN IF NOT EXISTS "serviceDiscounts" JSONB;
