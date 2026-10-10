-- AlterTable
ALTER TABLE "subscription_orders" ADD COLUMN "orderType" TEXT NOT NULL DEFAULT 'MODULES';
ALTER TABLE "subscription_orders" ADD COLUMN "extraCompanyName" TEXT;
ALTER TABLE "subscription_orders" ADD COLUMN "extraCompanyIndustry" TEXT;
