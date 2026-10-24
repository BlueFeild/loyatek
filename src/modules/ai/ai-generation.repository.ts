import { Prisma, PrismaClient } from "@prisma/client";
import type { BusinessContext } from "./copy-generator";

export interface NewGeneration {
  tenantId: string;
  userId?: string | null;
  tool: string;
  kind: string;
  input: Prisma.InputJsonValue;
  output: Prisma.InputJsonValue;
  creditsUsed: number;
  model: string;
}

export interface GenerationStore {
  create(g: NewGeneration): Promise<{ id: string }>;
  recent(tenantId: string, tool: string): Promise<unknown[]>;
  business(tenantId: string): Promise<BusinessContext | null>;
}

// الوصول لقاعدة البيانات بس (نتايج الذكاء الاصطناعي + بيانات الشركة اللي بتتكتب عنها)
export class AiGenerationRepository implements GenerationStore {
  constructor(private readonly db: PrismaClient) {}

  create(g: NewGeneration) {
    return this.db.aiGeneration.create({ data: { ...g, userId: g.userId ?? null } });
  }

  recent(tenantId: string, tool: string, take = 20) {
    return this.db.aiGeneration.findMany({ where: { tenantId, tool }, orderBy: { createdAt: "desc" }, take });
  }

  async business(tenantId: string): Promise<BusinessContext | null> {
    const t = await this.db.tenant.findUnique({ where: { id: tenantId }, select: { name: true, industry: true } });
    return t ? { name: t.name, industry: String(t.industry) } : null;
  }
}
