import { PrismaClient } from "@prisma/client";

export interface NewAsset {
  tenantId: string;
  generationId: string;
  kind: "image" | "video";
  mimeType: string;
  base64: string;
}

export interface StoredAsset {
  id: string;
  kind: string;
  mimeType: string;
  data: Buffer;
}

export interface AssetStore {
  save(a: NewAsset): Promise<{ id: string; size: number }>;
  // دايمًا بشركة صاحب الطلب - مفيش شركة تشوف ملفات شركة تانية
  get(tenantId: string, id: string): Promise<StoredAsset | null>;
}

// الصور والفيديوهات المتولّدة (متخزنة في قاعدة البيانات زي ملفات Link-in-Bio)
export class AiAssetRepository implements AssetStore {
  constructor(private readonly db: PrismaClient) {}

  async save(a: NewAsset) {
    const data = Buffer.from(a.base64, "base64");
    const row = await this.db.aiAsset.create({
      data: { tenantId: a.tenantId, generationId: a.generationId, kind: a.kind, mimeType: a.mimeType, size: data.length, data },
      select: { id: true, size: true },
    });
    return row;
  }

  async get(tenantId: string, id: string) {
    const r = await this.db.aiAsset.findFirst({ where: { id, tenantId }, select: { id: true, kind: true, mimeType: true, data: true } });
    return r ? { ...r, data: Buffer.from(r.data) } : null;
  }
}
