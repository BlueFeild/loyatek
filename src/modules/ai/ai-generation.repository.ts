import { Prisma, PrismaClient } from "@prisma/client";

export interface NewGeneration {
  // رقم العملية ممكن يتحدد من الأول (عشان حركة النقاط تتسجل بيه قبل ما الصف يتعمل)
  id?: string;
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

export interface PendingJob {
  id: string;
  creditsUsed: number;
  userId: string | null;
}

export type FinishResult = { status: "DONE" | "FAILED"; output?: Prisma.InputJsonValue; error?: string | null; creditsUsed?: number };

export interface GenerationStore {
  create(g: NewGeneration): Promise<{ id: string }>;
  recent(tenantId: string, tool: string): Promise<GenerationRow[]>;
  find(tenantId: string, id: string): Promise<GenerationRow | null>;
  // إنهاء عملية PENDING بشكل ذرّي: true = احنا اللي قفلناها (فمسموح نرجّع النقاط)،
  // false = حد تاني قفلها قبلنا (مانرجّعش تاني)
  finishPending(id: string, result: FinishResult): Promise<boolean>;
  countPending(tenantId: string, tool: string): Promise<number>;
  pendingBefore(tenantId: string, tool: string, before: Date): Promise<PendingJob[]>;
}

const withAssets = { assets: { select: { id: true }, orderBy: { createdAt: "asc" as const } } };

type RowWithAssets = Prisma.AiGenerationGetPayload<{ include: typeof withAssets }>;

function toRow(r: RowWithAssets): GenerationRow {
  const { assets, ...rest } = r;
  return { ...rest, assetIds: assets.map((a) => a.id) };
}

// الوصول لقاعدة البيانات بس (نتايج الذكاء الاصطناعي)
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

  async finishPending(id: string, result: FinishResult) {
    const updated = await this.db.aiGeneration.updateMany({
      where: { id, status: "PENDING" },
      data: { status: result.status, output: result.output, error: result.error ?? null, creditsUsed: result.creditsUsed, finishedAt: new Date() },
    });
    return updated.count === 1;
  }

  countPending(tenantId: string, tool: string) {
    return this.db.aiGeneration.count({ where: { tenantId, tool, status: "PENDING" } });
  }

  pendingBefore(tenantId: string, tool: string, before: Date) {
    return this.db.aiGeneration.findMany({ where: { tenantId, tool, status: "PENDING", createdAt: { lt: before } }, select: { id: true, creditsUsed: true, userId: true } });
  }
}
