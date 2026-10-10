-- Add optional POS system link to catalog settings
ALTER TABLE "catalog_settings" ADD COLUMN "posLink" TEXT NOT NULL DEFAULT '';
