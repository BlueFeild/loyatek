-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "moduleExpirations" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "trialExpiresAt" TIMESTAMP(3);
