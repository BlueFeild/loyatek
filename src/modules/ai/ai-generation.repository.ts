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
  status?: "PENDING" | "DONE" | "FAILED";
}

export interface GenerationRow {
  id: string;
  tenantId: string;
  tool: string;
  kind: string;
  input: unknown;
  output: unknown;
  creditsUsed: number;
  status: string;
  error: string | null;
  createdAt: Date;
  finishedAt: Date | null;
  assetIds: string[];
}

export interface GenerationStore {
  create(g: NewGeneration): Promise<{ id: string }>;
  recent(tenantId: string, tool: string): Promise<GenerationRow[]>;
  find(tenantId: string, id: string): Promise<GenerationRow | null>;
  finish(id: string, result: { status: "DONE" | "FAILED"; output?: Prisma.InputJsonValue; error?: string | null; creditsUsed?: number }): Promise<void>;
  business(tenantId: string): Promise<BusinessContext | null>;
}

const withAssets = { assets: { select: { id: true }, orderBy: { createdAt: "asc" as const } } };

type RowWithAssets = Prisma.AiGenerationGetPayload<{ include: typeof withAssets }>;

function toRow(r: RowWithAssets): GenerationRow {
  const { assets, ...rest } = r;
  return { ...rest, assetIds: assets.map((a) => a.id) };
}

// الوصول لقاعدة البيانات بس (نتايج الذكاء الاصطناعي + بيانات الشركة اللي بتتكتب عنها)
export class AiGenerationRepository implements GenerationStore {
  constructor(private readonly db: PrismaClient) {}

  create(g: NewGeneration) {
    return this.db.aiGeneration.create({ data: { ...g, userId: g.userId ?? null, status: g.status ?? "DONE", finishedAt: g.status === "PENDING" ? null : new Date() }, select: { id: true } });
  }

  async recent(tenantId: string, tool: string, take = 20) {
    const rows = await this.db.aiGeneration.findMany({ where: { tenantId, tool }, orderBy: { createdAt: "desc" }, take, include: withAssets });
    return rows.map(toRow);
  }

  async find(tenantId: string, id: string) {
    const r = await this.db.aiGeneration.findFirst({ where: { id, tenantId }, include: withAssets });
    return r ? toRow(r) : null;
  }

  async finish(id: string, result: { status: "DONE" | "FAILED"; output?: Prisma.InputJsonValue; error?: string | null; creditsUsed?: number }) {
    await this.db.aiGeneration.update({
      where: { id },
      data: { status: result.status, output: result.output, error: result.error ?? null, creditsUsed: result.creditsUsed, finishedAt: new Date() },
    });
  }

  async business(tenantId: string): Promise<BusinessContext | null> {
    const t = await this.db.tenant.findUnique({ where: { id: tenantId }, select: { name: true, industry: true } });
    return t ? { name: t.name, industry: String(t.industry) } : null;
  }
}
