-- التذاكر والمقاعد بقت خدمة لوحدها (tickets) + أكواد خصم، سعر مبكر، تذاكر مجانية/بيع على الباب،
-- أسئلة للعميل، أكتر من ميعاد للعرض، تذكير، قائمة انتظار، إعدادات صفحة التذاكر.
-- بيتنفّذ أكتر من مرة عادي.

-- ---------- العروض ----------
ALTER TABLE "seat_events" ADD COLUMN IF NOT EXISTS "seriesId" TEXT;
ALTER TABLE "seat_events" ADD COLUMN IF NOT EXISTS "earlyBirdPct" INTEGER;
ALTER TABLE "seat_events" ADD COLUMN IF NOT EXISTS "earlyBirdEndsAt" TIMESTAMP(3);
ALTER TABLE "seat_events" ADD COLUMN IF NOT EXISTS "questions" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "seat_events" ADD COLUMN IF NOT EXISTS "notice" TEXT;
ALTER TABLE "seat_events" ADD COLUMN IF NOT EXISTS "noticeRequired" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "seat_events" ADD COLUMN IF NOT EXISTS "avoidSingleSeats" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "seat_events" ADD COLUMN IF NOT EXISTS "reminderHours" INTEGER DEFAULT 24;
CREATE INDEX IF NOT EXISTS "seat_events_seriesId_idx" ON "seat_events"("seriesId");

-- ---------- الطلبات ----------
ALTER TABLE "seat_orders" ADD COLUMN IF NOT EXISTS "subtotal" DECIMAL(18,6) NOT NULL DEFAULT 0;
ALTER TABLE "seat_orders" ADD COLUMN IF NOT EXISTS "discount" DECIMAL(18,6) NOT NULL DEFAULT 0;
ALTER TABLE "seat_orders" ADD COLUMN IF NOT EXISTS "promoCodeId" TEXT;
ALTER TABLE "seat_orders" ADD COLUMN IF NOT EXISTS "promoCode" TEXT;
ALTER TABLE "seat_orders" ADD COLUMN IF NOT EXISTS "channel" TEXT NOT NULL DEFAULT 'ONLINE';
ALTER TABLE "seat_orders" ADD COLUMN IF NOT EXISTS "note" TEXT;
ALTER TABLE "seat_orders" ADD COLUMN IF NOT EXISTS "answers" JSONB;
ALTER TABLE "seat_orders" ADD COLUMN IF NOT EXISTS "noticeAcceptedAt" TIMESTAMP(3);
ALTER TABLE "seat_orders" ADD COLUMN IF NOT EXISTS "reminderSentAt" TIMESTAMP(3);
-- الطلبات القديمة: السعر قبل الخصم = المبلغ نفسه
UPDATE "seat_orders" SET "subtotal" = "amount" WHERE "subtotal" = 0 AND "amount" > 0 AND "discount" = 0;

-- ---------- أكواد الخصم ----------
CREATE TABLE IF NOT EXISTS "seat_promo_codes" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "kind" TEXT NOT NULL DEFAULT 'PERCENT',
  "value" DECIMAL(18,6) NOT NULL,
  "maxUses" INTEGER,
  "usedCount" INTEGER NOT NULL DEFAULT 0,
  "startsAt" TIMESTAMP(3),
  "endsAt" TIMESTAMP(3),
  "eventId" TEXT,
  "tierIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "seat_promo_codes_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "seat_promo_codes_tenantId_code_key" ON "seat_promo_codes"("tenantId", "code");
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'seat_promo_codes_tenantId_fkey') THEN
    ALTER TABLE "seat_promo_codes" ADD CONSTRAINT "seat_promo_codes_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- ---------- قائمة الانتظار ----------
CREATE TABLE IF NOT EXISTS "seat_waitlist" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "phone" TEXT NOT NULL,
  "email" TEXT,
  "seats" INTEGER NOT NULL DEFAULT 1,
  "status" TEXT NOT NULL DEFAULT 'WAITING',
  "notifiedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "seat_waitlist_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "seat_waitlist_eventId_phone_key" ON "seat_waitlist"("eventId", "phone");
CREATE INDEX IF NOT EXISTS "seat_waitlist_tenantId_eventId_idx" ON "seat_waitlist"("tenantId", "eventId");
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'seat_waitlist_tenantId_fkey') THEN
    ALTER TABLE "seat_waitlist" ADD CONSTRAINT "seat_waitlist_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'seat_waitlist_eventId_fkey') THEN
    ALTER TABLE "seat_waitlist" ADD CONSTRAINT "seat_waitlist_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "seat_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- ---------- إعدادات صفحة التذاكر ----------
CREATE TABLE IF NOT EXISTS "seat_settings" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "brandName" TEXT,
  "logoDataUrl" TEXT,
  "accentColor" TEXT,
  "timezone" TEXT,
  "pageTemplate" TEXT NOT NULL DEFAULT 'bluefield',
  "pageStyle" JSONB,
  "coverDataUrl" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "seat_settings_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "seat_settings" ADD COLUMN IF NOT EXISTS "pageTemplate" TEXT NOT NULL DEFAULT 'bluefield';
ALTER TABLE "seat_settings" ADD COLUMN IF NOT EXISTS "pageStyle" JSONB;
ALTER TABLE "seat_settings" ADD COLUMN IF NOT EXISTS "coverDataUrl" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "seat_settings_tenantId_key" ON "seat_settings"("tenantId");
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'seat_settings_tenantId_fkey') THEN
    ALTER TABLE "seat_settings" ADD CONSTRAINT "seat_settings_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- ---------- الخدمة الجديدة لمين استخدم التذاكر فعلًا ----------
-- (قرار Heba 2026-11-12) الشركة اللي عملت قاعة أو عرض وعندها اشتراك حجز: تاخد tickets بنفس تاريخ
-- انتهاء الحجز (أو من غير انتهاء لو الحجز من غير انتهاء). الباقي يشترك لو عايز.
UPDATE "tenants" t
   SET "subscribedModules" = array_append(t."subscribedModules", 'tickets'),
       "moduleExpirations" = CASE
         WHEN COALESCE(t."moduleExpirations", '{}'::jsonb) ? 'booking'
              AND COALESCE(t."moduleExpirations"->>'booking', '') <> ''
         THEN COALESCE(t."moduleExpirations", '{}'::jsonb) || jsonb_build_object('tickets', t."moduleExpirations"->>'booking')
         ELSE COALESCE(t."moduleExpirations", '{}'::jsonb) - 'tickets'
       END
 WHERE 'booking' = ANY (t."subscribedModules")
   AND NOT ('tickets' = ANY (t."subscribedModules"))
   AND (EXISTS (SELECT 1 FROM "seat_venues" v WHERE v."tenantId" = t.id)
        OR EXISTS (SELECT 1 FROM "seat_events" e WHERE e."tenantId" = t.id));
