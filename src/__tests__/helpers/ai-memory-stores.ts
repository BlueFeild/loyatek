import type { CreditMovement, CreditStore } from "../../modules/credits/credit.repository";
import type { GenerationRow, GenerationStore, NewGeneration } from "../../modules/ai/ai-generation.repository";
import type { AssetStore, NewAsset, StoredAsset } from "../../modules/ai/ai-asset.repository";
import type { Prisma } from "@prisma/client";

// تخزين في الذاكرة (نفس عقود Prisma) - عشان نختبر المنطق لوحده من غير قاعدة بيانات

export class MemoryCredits implements CreditStore {
  log: (CreditMovement & { balanceAfter: number })[] = [];
  constructor(public tenants: Record<string, { balance: number; isPlatformOwner: boolean }>) {}
  async balance(id: string) {
    return this.tenants[id] ?? null;
  }
  async apply(m: CreditMovement) {
    const t = this.tenants[m.tenantId];
    if (m.amount < 0 && t.balance < -m.amount) return null;
    t.balance += m.amount;
    this.log.push({ ...m, balanceAfter: t.balance });
    return t.balance;
  }
  async logOnly(m: CreditMovement, balanceAfter: number) {
    this.log.push({ ...m, balanceAfter });
  }
  async history(id: string) {
    return this.log.filter((l) => l.tenantId === id);
  }
}

export class MemoryGenerations implements GenerationStore {
  rows: (GenerationRow & { model: string; userId: string | null })[] = [];
  private seq = 0;
  constructor(private readonly assets?: MemoryAssets) {}

  async create(g: NewGeneration) {
    const id = `gen${++this.seq}`;
    this.rows.push({
      id,
      tenantId: g.tenantId,
      userId: g.userId ?? null,
      tool: g.tool,
      kind: g.kind,
      input: g.input,
      output: g.output,
      creditsUsed: g.creditsUsed,
      model: g.model,
      status: g.status ?? "DONE",
      error: null,
      createdAt: new Date(Date.now() + this.seq), // ترتيب ثابت
      finishedAt: g.status === "PENDING" ? null : new Date(),
      assetIds: [],
    });
    return { id };
  }
  private withAssets(r: GenerationRow) {
    return { ...r, assetIds: this.assets ? this.assets.items.filter((a) => a.generationId === r.id).map((a) => a.id) : [] };
  }
  async recent(tenantId: string, tool: string) {
    return this.rows
      .filter((r) => r.tenantId === tenantId && r.tool === tool)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((r) => this.withAssets(r));
  }
  async find(tenantId: string, id: string) {
    const r = this.rows.find((x) => x.id === id && x.tenantId === tenantId);
    return r ? this.withAssets(r) : null;
  }
  async finish(id: string, result: { status: "DONE" | "FAILED"; output?: Prisma.InputJsonValue; error?: string | null; creditsUsed?: number }) {
    const r = this.rows.find((x) => x.id === id)!;
    r.status = result.status;
    if (result.output !== undefined) r.output = result.output;
    r.error = result.error ?? null;
    if (result.creditsUsed !== undefined) r.creditsUsed = result.creditsUsed;
    r.finishedAt = new Date();
  }
  async business(tenantId: string) {
    return tenantId === "missing" ? null : { name: "Doha Cafe", industry: "HOSPITALITY" };
  }
}

export class MemoryAssets implements AssetStore {
  items: (StoredAsset & { tenantId: string; generationId: string })[] = [];
  async save(a: NewAsset) {
    const data = Buffer.from(a.base64, "base64");
    const id = `00000000-0000-4000-8000-${String(this.items.length + 1).padStart(12, "0")}`;
    this.items.push({ id, tenantId: a.tenantId, generationId: a.generationId, kind: a.kind, mimeType: a.mimeType, data });
    return { id, size: data.length };
  }
  async get(tenantId: string, id: string) {
    return this.items.find((x) => x.id === id && x.tenantId === tenantId) ?? null;
  }
}
