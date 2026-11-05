-- واتساب: سيناريوهات (Flow Builder) - رسايل بأزرار / أسئلة / تحويل لموظف + مكان العميل في السيناريو + إجاباته
CREATE TABLE IF NOT EXISTS "whatsapp_flows" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "keywords" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "startNodeId" TEXT NOT NULL,
    "nodes" JSONB NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "startedCount" INTEGER NOT NULL DEFAULT 0,
    "completedCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "whatsapp_flows_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "whatsapp_flows_tenantId_idx" ON "whatsapp_flows"("tenantId");

CREATE TABLE IF NOT EXISTS "whatsapp_flow_sessions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "flowId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "answers" JSONB NOT NULL DEFAULT '{}',
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "whatsapp_flow_sessions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "whatsapp_flow_sessions_tenantId_phone_key" ON "whatsapp_flow_sessions"("tenantId", "phone");

CREATE TABLE IF NOT EXISTS "whatsapp_flow_responses" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "flowId" TEXT NOT NULL,
    "flowName" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "name" TEXT,
    "answers" JSONB NOT NULL,
    "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "whatsapp_flow_responses_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "whatsapp_flow_responses_tenantId_flowId_completedAt_idx" ON "whatsapp_flow_responses"("tenantId", "flowId", "completedAt");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'whatsapp_flows_tenantId_fkey') THEN
    ALTER TABLE "whatsapp_flows" ADD CONSTRAINT "whatsapp_flows_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'whatsapp_flow_sessions_tenantId_fkey') THEN
    ALTER TABLE "whatsapp_flow_sessions" ADD CONSTRAINT "whatsapp_flow_sessions_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'whatsapp_flow_responses_tenantId_fkey') THEN
    ALTER TABLE "whatsapp_flow_responses" ADD CONSTRAINT "whatsapp_flow_responses_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
