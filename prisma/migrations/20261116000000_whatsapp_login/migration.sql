-- خدمة "الدخول بالواتساب": عملاء التاجر يأكدوا رقمهم بكود على الواتساب
CREATE TABLE IF NOT EXISTS "wa_login_settings" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "requireOnBooking" BOOLEAN NOT NULL DEFAULT false,
  "siteOrigins" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "templateLang" TEXT NOT NULL DEFAULT 'en',
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wa_login_settings_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "wa_login_settings_tenantId_key" ON "wa_login_settings"("tenantId");
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wa_login_settings_tenantId_fkey') THEN
    ALTER TABLE "wa_login_settings" ADD CONSTRAINT "wa_login_settings_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "wa_login_codes" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "phone" TEXT NOT NULL,
  "codeHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "usedAt" TIMESTAMP(3),
  "ip" TEXT,
  "source" TEXT NOT NULL DEFAULT 'api',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wa_login_codes_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "wa_login_codes_tenantId_phone_createdAt_idx" ON "wa_login_codes"("tenantId", "phone", "createdAt");
CREATE INDEX IF NOT EXISTS "wa_login_codes_tenantId_ip_createdAt_idx" ON "wa_login_codes"("tenantId", "ip", "createdAt");
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wa_login_codes_tenantId_fkey') THEN
    ALTER TABLE "wa_login_codes" ADD CONSTRAINT "wa_login_codes_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
