-- Agency staff: BlueField team members scoped to manage specific client tenants
ALTER TABLE "users" ADD COLUMN "isAgencyStaff" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "agency_assignments" (
    "id" TEXT NOT NULL,
    "staffUserId" TEXT NOT NULL,
    "clientTenantId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agency_assignments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "agency_assignments_staffUserId_clientTenantId_key" ON "agency_assignments"("staffUserId", "clientTenantId");
CREATE INDEX "agency_assignments_clientTenantId_idx" ON "agency_assignments"("clientTenantId");

ALTER TABLE "agency_assignments" ADD CONSTRAINT "agency_assignments_staffUserId_fkey" FOREIGN KEY ("staffUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agency_assignments" ADD CONSTRAINT "agency_assignments_clientTenantId_fkey" FOREIGN KEY ("clientTenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
