-- سعر لكل خدمة في الحجز (بالدولار) + الخدمات اللي العميل اختارها
ALTER TABLE "booking_settings" ADD COLUMN IF NOT EXISTS "servicePrices" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "services" TEXT[] DEFAULT ARRAY[]::TEXT[];
