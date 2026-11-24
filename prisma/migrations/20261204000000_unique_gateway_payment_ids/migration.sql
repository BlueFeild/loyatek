-- تدقيق أمني PAY-01: رقم الدفعة من بوابة الدفع مايتستخدمش لتأكيد طلبين.
-- فهرس unique جزئي (على الصفوف اللي فيها رقم دفعة بس). Prisma 5 مابيكتبش partial index
-- في الـ schema فمش هيظهر كـ drift. لو فيه أرقام مكررة قديمة في جدول، الفهرس بتاعه مابيتعملش
-- (NOTICE بس) بدل ما الـ migration يفشل ويوقف كل اللي بعده - والكود بيفضل يفحص التكرار بنفسه.
DO $$
DECLARE
  t TEXT;
  dup INT;
BEGIN
  FOREACH t IN ARRAY ARRAY['subscription_orders', 'bookings', 'catalog_orders', 'seat_orders'] LOOP
    IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = t || '_gateway_payment_id_key') THEN
      CONTINUE;
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = t AND column_name = 'myFatoorahPaymentId'
    ) THEN
      dup := NULL;
      EXECUTE format(
        'SELECT 1 FROM %I WHERE "myFatoorahPaymentId" IS NOT NULL GROUP BY "myFatoorahPaymentId" HAVING COUNT(*) > 1 LIMIT 1', t
      ) INTO dup;
      IF dup IS NOT NULL THEN
        RAISE NOTICE 'Skipping unique payment id index on %: duplicate payment ids exist', t;
      ELSE
        EXECUTE format(
          'CREATE UNIQUE INDEX %I ON %I ("myFatoorahPaymentId") WHERE "myFatoorahPaymentId" IS NOT NULL',
          t || '_gateway_payment_id_key', t
        );
      END IF;
    END IF;
  END LOOP;
END $$;
