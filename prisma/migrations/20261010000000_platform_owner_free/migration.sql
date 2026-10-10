-- شركات صاحب المنصة (السوبر أدمن) مجانية بالكامل
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "isPlatformOwner" BOOLEAN NOT NULL DEFAULT false;
UPDATE "tenants" SET "isPlatformOwner" = true
WHERE "id" IN (SELECT "tenantId" FROM "users" WHERE "isSuperAdmin" = true);
