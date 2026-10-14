-- الدولار عملة أساسية لكل المبالغ + عملة عرض لكل شركة + أسعار صرف

-- 1) عملة الشركة
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "displayCurrency" TEXT NOT NULL DEFAULT 'USD';

-- 2) أسعار الصرف (تلقائي من الإنترنت + يدوي من السوبر أدمن)
CREATE TABLE IF NOT EXISTS "exchange_rates" (
    "currency" TEXT NOT NULL,
    "autoRate" DECIMAL(18,8),
    "manualRate" DECIMAL(18,8),
    "autoUpdatedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "exchange_rates_pkey" PRIMARY KEY ("currency")
);

-- 3) دقة 6 خانات لكل المبالغ (عشان التحويل من/لعملة الشركة يرجع نفس الرقم
--    بالظبط - مثلًا 100 جنيه = 2.061856$ مش 2.06$). توسيع بس، مفيش بيانات بتضيع
ALTER TABLE "inventory_items" ALTER COLUMN "costPrice" TYPE DECIMAL(18,6);
ALTER TABLE "inventory_items" ALTER COLUMN "sellPrice" TYPE DECIMAL(18,6);
ALTER TABLE "purchase_order_items" ALTER COLUMN "unitCost" TYPE DECIMAL(18,6);
ALTER TABLE "rfq_quotes" ALTER COLUMN "price" TYPE DECIMAL(18,6);
ALTER TABLE "journal_entry_lines" ALTER COLUMN "debit" TYPE DECIMAL(18,6);
ALTER TABLE "journal_entry_lines" ALTER COLUMN "credit" TYPE DECIMAL(18,6);
ALTER TABLE "invoices" ALTER COLUMN "subtotal" TYPE DECIMAL(18,6);
ALTER TABLE "invoices" ALTER COLUMN "vatAmount" TYPE DECIMAL(18,6);
ALTER TABLE "invoices" ALTER COLUMN "total" TYPE DECIMAL(18,6);
ALTER TABLE "invoice_items" ALTER COLUMN "unitPrice" TYPE DECIMAL(18,6);
ALTER TABLE "employees" ALTER COLUMN "baseSalary" TYPE DECIMAL(18,6);
ALTER TABLE "employees" ALTER COLUMN "monthlyTarget" TYPE DECIMAL(18,6);
ALTER TABLE "sales" ALTER COLUMN "unitPrice" TYPE DECIMAL(18,6);
ALTER TABLE "sales" ALTER COLUMN "totalAmount" TYPE DECIMAL(18,6);
ALTER TABLE "sales" ALTER COLUMN "commissionAmount" TYPE DECIMAL(18,6);
ALTER TABLE "deals" ALTER COLUMN "value" TYPE DECIMAL(18,6);
ALTER TABLE "booking_settings" ALTER COLUMN "paymentAmount" TYPE DECIMAL(18,6);
ALTER TABLE "bookings" ALTER COLUMN "amount" TYPE DECIMAL(18,6);
ALTER TABLE "menu_items" ALTER COLUMN "price" TYPE DECIMAL(18,6);
ALTER TABLE "catalog_orders" ALTER COLUMN "totalAmount" TYPE DECIMAL(18,6);
ALTER TABLE "order_items" ALTER COLUMN "price" TYPE DECIMAL(18,6);
ALTER TABLE "subscription_orders" ALTER COLUMN "amount" TYPE DECIMAL(18,6);
ALTER TABLE "fixed_assets" ALTER COLUMN "purchaseValue" TYPE DECIMAL(18,6);
ALTER TABLE "fixed_assets" ALTER COLUMN "salvageValue" TYPE DECIMAL(18,6);
ALTER TABLE "budget_lines" ALTER COLUMN "budgetedAmount" TYPE DECIMAL(18,6);
ALTER TABLE "vehicle_service_logs" ALTER COLUMN "cost" TYPE DECIMAL(18,6);
ALTER TABLE "vendor_bills" ALTER COLUMN "amount" TYPE DECIMAL(18,6);

-- 4) الشركات اللي كانت اختارت عملة للمنيو (قبل كده أسعار المنيو كانت
--    مكتوبة بالعملة دي): عملة الشركة = عملة المنيو، وأسعار المنيو والأوردرات
--    بتتحوّل لدولار بالسعر الاحتياطي. وبعدها عملة المنيو بترجع USD - فلو
--    الملف اتشغّل تاني مش هيحوّل الأسعار مرتين
DO $$
DECLARE r RECORD; rate NUMERIC;
BEGIN
    FOR r IN SELECT cs."tenantId", cs."currency" FROM "catalog_settings" cs WHERE cs."currency" IS NOT NULL AND cs."currency" <> 'USD' LOOP
      rate := CASE r."currency"
        WHEN 'QAR' THEN 3.64 WHEN 'AED' THEN 3.6725 WHEN 'SAR' THEN 3.75 WHEN 'KWD' THEN 0.3075 WHEN 'BHD' THEN 0.376
        WHEN 'OMR' THEN 0.3845 WHEN 'JOD' THEN 0.709 WHEN 'EGP' THEN 48.5 WHEN 'EUR' THEN 0.92 WHEN 'GBP' THEN 0.79 ELSE NULL END;
      IF rate IS NOT NULL THEN
        UPDATE "tenants" SET "displayCurrency" = r."currency" WHERE "id" = r."tenantId" AND "displayCurrency" = 'USD';
        UPDATE "menu_items" SET "price" = ROUND("price" / rate, 6) WHERE "tenantId" = r."tenantId";
        UPDATE "catalog_orders" SET "totalAmount" = ROUND("totalAmount" / rate, 6) WHERE "tenantId" = r."tenantId";
        UPDATE "order_items" oi SET "price" = ROUND(oi."price" / rate, 6) FROM "catalog_orders" co WHERE oi."orderId" = co."id" AND co."tenantId" = r."tenantId";
        UPDATE "catalog_settings" SET "currency" = 'USD' WHERE "tenantId" = r."tenantId";
      END IF;
    END LOOP;
END $$;
