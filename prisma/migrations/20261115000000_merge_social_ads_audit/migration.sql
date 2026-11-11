-- دمج "الإعلانات المدفوعة" و"تحليل الحسابات" في خدمة السوشيال (social) - اشتراك واحد.
-- أي شركة مشتركة في أي واحدة منهم بتاخد social بأطول مدة كانت عندها (أو من غير انتهاء لو
-- واحدة منهم كانت من غير تاريخ انتهاء). بيتنفّذ أكتر من مرة عادي (مابيلاقيش ads/audit تاني).
DO $$
DECLARE
  t RECORD;
  m TEXT;
  unlimited BOOLEAN;
  best TIMESTAMPTZ;
  best_text TEXT;
  exps JSONB;
BEGIN
  FOR t IN SELECT id, "subscribedModules" AS subs, COALESCE("moduleExpirations", '{}'::jsonb) AS exps
           FROM "tenants" WHERE "subscribedModules" && ARRAY['ads', 'audit']::text[] LOOP
    unlimited := FALSE;
    best := NULL;
    best_text := NULL;
    FOREACH m IN ARRAY ARRAY['social', 'ads', 'audit'] LOOP
      IF m = ANY (t.subs) THEN
        IF NOT (t.exps ? m) OR t.exps->>m IS NULL OR t.exps->>m = '' THEN
          unlimited := TRUE;
        ELSIF best IS NULL OR (t.exps->>m)::timestamptz > best THEN
          best := (t.exps->>m)::timestamptz;
          best_text := t.exps->>m;
        END IF;
      END IF;
    END LOOP;
    exps := t.exps - 'ads' - 'audit' - 'social';
    IF NOT unlimited AND best_text IS NOT NULL THEN
      exps := exps || jsonb_build_object('social', best_text);
    END IF;
    UPDATE "tenants"
       SET "subscribedModules" = array_append(array_remove(array_remove(array_remove(t.subs, 'ads'), 'audit'), 'social'), 'social'),
           "moduleExpirations" = exps
     WHERE id = t.id;
  END LOOP;
END $$;

-- طلبات دفع لسه ما اتفعلتش: ads / audit -> social (من غير تكرار)
UPDATE "subscription_orders"
   SET "selectedModules" = (
     SELECT COALESCE(array_agg(DISTINCT CASE WHEN x IN ('ads', 'audit') THEN 'social' ELSE x END), ARRAY[]::text[])
     FROM unnest("selectedModules") AS x
   )
 WHERE "status" IN ('PENDING', 'PAID') AND "selectedModules" && ARRAY['ads', 'audit']::text[];

-- أسعار الخدمتين القديمتين مالهاش لازمة (الكود بيتجاهلها، بس عشان لوحة السوبر أدمن تحفظ عادي)
UPDATE "platform_settings" SET "modulePrices" = "modulePrices" - 'ads' - 'audit'
 WHERE "modulePrices" ? 'ads' OR "modulePrices" ? 'audit';
UPDATE "platform_settings"
   SET "pricingRegions" = (
     SELECT COALESCE(jsonb_agg(
       CASE WHEN jsonb_typeof(r->'modulePrices') = 'object'
            THEN jsonb_set(r, '{modulePrices}', (r->'modulePrices') - 'ads' - 'audit')
            ELSE r END), '[]'::jsonb)
     FROM jsonb_array_elements("pricingRegions") AS r
   )
 WHERE jsonb_typeof("pricingRegions") = 'array' AND "pricingRegions"::text ~ '"(ads|audit)"';
