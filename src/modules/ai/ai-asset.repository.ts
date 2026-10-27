import { Prisma, PrismaClient } from "@prisma/client";

export interface NewAsset {
  tenantId: string;
  generationId: string;
  kind: "image" | "video";
  mimeType: string;
  base64: string;
}

export interface AssetMeta {
  id: string;
  kind: string;
  mimeType: string;
  size: number;
}

export interface StoredAsset extends Omit<AssetMeta, "size"> {
  data: Buffer;
}

export interface AssetStore {
  save(a: NewAsset): Promise<{ id: string; size: number }>;
  // دايمًا بشركة صاحب الطلب - مفيش شركة تشوف ملفات شركة تانية
  get(tenantId: string, id: string): Promise<StoredAsset | null>;
}

// للعرض/التحميل: البيانات من غير الملف، وجزء من الملف بس (تقديم فيديو من غير تحميله كله)
export interface AssetReader extends AssetStore {
  meta(tenantId: string, id: string): Promise<AssetMeta | null>;
  slice(tenantId: string, id: string, start: number, length: number): Promise<Buffer | null>;
}

// الصور والفيديوهات المتولّدة (متخزنة في قاعدة البيانات زي ملفات Link-in-Bio)
export class AiAssetRepository implements AssetReader {
  constructor(private readonly db: PrismaClient) {}

  async save(a: NewAsset) {
    const data = Buffer.from(a.base64, "base64");
    const row = await this.db.aiAsset.create({
      data: { tenantId: a.tenantId, generationId: a.generationId, kind: a.kind, mimeType: a.mimeType, size: data.length, data },
      select: { id: true, size: true },
    });
    return row;
  }

  // Prisma بيرجّع Buffer أصلًا - مفيش نسخة تانية
  async get(tenantId: string, id: string) {
    const r = await this.db.aiAsset.findFirst({ where: { id, tenantId }, select: { id: true, kind: true, mimeType: true, data: true } });
    return r ? { ...r, data: r.data as Buffer } : null;
  }

  meta(tenantId: string, id: string) {
    return this.db.aiAsset.findFirst({ where: { id, tenantId }, select: { id: true, kind: true, mimeType: true, size: true } });
  }

  // substring في Postgres بيبدأ من 1
  async slice(tenantId: string, id: string, start: number, length: number) {
    const rows = await this.db.$queryRaw<{ chunk: Buffer }[]>(
      Prisma.sql`SELECT substring("data" from ${start + 1}::int for ${length}::int) AS chunk FROM "ai_assets" WHERE "id" = ${id} AND "tenantId" = ${tenantId}`
    );
    return rows[0]?.chunk ?? null;
  }
}
