-- خدمة جديدة: الموقع التعريفي (website) - جداول جديدة بس، والأوامر آمنة لو اتشغلت مرتين
CREATE TABLE IF NOT EXISTS "website_settings" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "published" BOOLEAN NOT NULL DEFAULT false,
    "template" TEXT NOT NULL DEFAULT 'bluefield',
    "pageStyle" JSONB,
    "content" JSONB,
    "brandName" TEXT,
    "logoDataUrl" TEXT,
    "coverDataUrl" TEXT,
    "seoTitle" TEXT,
    "seoDescription" TEXT,
    "language" TEXT NOT NULL DEFAULT 'en',
    "savedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "website_settings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "website_photos" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'gallery',
    "dataUrl" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "website_photos_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "website_inquiries" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "message" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "website_inquiries_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "website_visit_days" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "website_visit_days_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "website_settings_tenantId_key" ON "website_settings"("tenantId");
CREATE INDEX IF NOT EXISTS "website_photos_tenantId_kind_idx" ON "website_photos"("tenantId", "kind");
CREATE INDEX IF NOT EXISTS "website_inquiries_tenantId_createdAt_idx" ON "website_inquiries"("tenantId", "createdAt");
CREATE UNIQUE INDEX IF NOT EXISTS "website_visit_days_tenantId_day_key" ON "website_visit_days"("tenantId", "day");
