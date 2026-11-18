-- مواعيد كل يوم لوحده + أيام الإجازة لصفحة الحجز
ALTER TABLE "booking_settings" ADD COLUMN IF NOT EXISTS "weeklyHours" JSONB;
ALTER TABLE "booking_settings" ADD COLUMN IF NOT EXISTS "holidays" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
