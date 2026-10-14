-- شكل لوجو Link-in-Bio (fit / shape / zoom / position)
ALTER TABLE "linktree_settings" ADD COLUMN IF NOT EXISTS "avatarStyle" JSONB;
