-- أسئلة صفحة الحجز (نوع الحيوان / حجم العربية / أول زيارة...) + إجابات العميل على كل حجز
ALTER TABLE "booking_settings" ADD COLUMN IF NOT EXISTS "questions" JSONB;
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "answers" JSONB;
