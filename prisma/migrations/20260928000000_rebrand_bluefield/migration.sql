-- Rebrand: update wallet terms default text and any existing rows that
-- still hold the old default wording (rows customized by a tenant, i.e.
-- with different text, are left untouched)
ALTER TABLE "wallet_settings"
  ALTER COLUMN "termsText" SET DEFAULT 'By joining this loyalty program, you agree to receive points, offers, and updates via WhatsApp and SMS. Points expire per the schedule shown on your pass. BlueField and the merchant may update these terms at any time.';

UPDATE "wallet_settings"
SET "termsText" = 'By joining this loyalty program, you agree to receive points, offers, and updates via WhatsApp and SMS. Points expire per the schedule shown on your pass. BlueField and the merchant may update these terms at any time.'
WHERE "termsText" = 'By joining this loyalty program, you agree to receive points, offers, and updates via WhatsApp and SMS. Points expire per the schedule shown on your pass. Loyatek and the merchant may update these terms at any time.';
