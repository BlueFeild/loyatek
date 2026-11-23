-- تدقيق أمني COM-02: الحجز الملغي كان بيقفل الميعاد للأبد (unique على كل الحجوزات حتى الملغية)،
-- فالميعاد يظهر متاح وأي حجز جديد فيه يفشل. دلوقتي الـ unique على الحجوزات اللي مش ملغية بس.
-- آمن للتشغيل أكتر من مرة.
DROP INDEX IF EXISTS "bookings_resourceId_date_hour_key";

CREATE UNIQUE INDEX IF NOT EXISTS "bookings_resource_slot_active_key"
  ON "bookings" ("resourceId", "date", "hour")
  WHERE "status" <> 'CANCELLED';

-- index عادي للبحث بنفس الأعمدة (اللي الـ schema مستنيه)
CREATE INDEX IF NOT EXISTS "bookings_resourceId_date_hour_idx" ON "bookings" ("resourceId", "date", "hour");
