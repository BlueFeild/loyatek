-- Link-in-Bio: مفيش خلفية غامقة افتراضية تاني. الصفحات اللي لسه على الكحلي الافتراضي القديم بتبقى سماوي فاتح،
-- واللي التاجر اختار لونها بنفسه ما بتتغيرش.
ALTER TABLE "linktree_settings" ALTER COLUMN "backgroundColor" SET DEFAULT '#f0f9ff';
UPDATE "linktree_settings" SET "backgroundColor" = '#f0f9ff' WHERE lower("backgroundColor") = '#0f172a';
