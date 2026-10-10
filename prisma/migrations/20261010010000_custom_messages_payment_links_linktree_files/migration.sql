-- 1) رسائل واتساب الكتالوج بنص التاجر
ALTER TABLE "catalog_settings" ADD COLUMN IF NOT EXISTS "waMerchantTemplate" TEXT NOT NULL DEFAULT E'🔔 New Order\n{mode}\n\n{items}\n\nTotal: {total}';
ALTER TABLE "catalog_settings" ADD COLUMN IF NOT EXISTS "waCustomerTemplate" TEXT NOT NULL DEFAULT E'✅ Order confirmed!\n{mode}\n\n{items}\n\nTotal: {total}\nEstimated prep time: {prep} minutes.';

-- 2) مزوّد الدفع الخاص بالتاجر
ALTER TABLE "tenant_payment_settings" ADD COLUMN IF NOT EXISTS "provider" TEXT NOT NULL DEFAULT 'MYFATOORAH';
ALTER TABLE "tenant_payment_settings" ADD COLUMN IF NOT EXISTS "customProviderName" TEXT;
ALTER TABLE "tenant_payment_settings" ADD COLUMN IF NOT EXISTS "customPaymentUrl" TEXT;

-- 3) Link-in-Bio: ملفات مرفوعة
ALTER TABLE "linktree_links" ADD COLUMN IF NOT EXISTS "kind" TEXT NOT NULL DEFAULT 'URL';
ALTER TABLE "linktree_links" ADD COLUMN IF NOT EXISTS "fileName" TEXT;
ALTER TABLE "linktree_links" ADD COLUMN IF NOT EXISTS "fileSize" INTEGER;

CREATE TABLE IF NOT EXISTS "linktree_files" (
  "linkId" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL,
  "data" BYTEA NOT NULL,
  CONSTRAINT "linktree_files_pkey" PRIMARY KEY ("linkId")
);

DO $$ BEGIN
  ALTER TABLE "linktree_files" ADD CONSTRAINT "linktree_files_linkId_fkey"
    FOREIGN KEY ("linkId") REFERENCES "linktree_links"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
