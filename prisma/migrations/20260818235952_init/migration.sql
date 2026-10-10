-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "subscribedModules" TEXT[] DEFAULT ARRAY['erp', 'booking', 'wallet', 'whatsapp', 'catalog']::TEXT[];

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "isSuperAdmin" BOOLEAN NOT NULL DEFAULT false;
