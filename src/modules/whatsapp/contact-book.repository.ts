import { Prisma, PrismaClient } from "@prisma/client";

// اللي دفتر جهات الاتصال محتاجه من التخزين (Prisma أو نسخة في الذاكرة للاختبار)

export interface ContactRow {
  id: string;
  phone: string;
  name: string | null;
  tags: string[];
  optedOut: boolean;
  optedOutAt: Date | null;
  source: string;
  lastInboundAt: Date | null;
  createdAt: Date;
}

export type ContactStatusFilter = "all" | "subscribed" | "opted_out";
export type TagMatch = "any" | "all";

export interface ContactQuery {
  q?: string;
  tag?: string;
  status: ContactStatusFilter;
  skip: number;
  take: number;
}

export interface ContactInput {
  phone: string;
  name?: string | null;
  tags?: string[];
}

export interface ContactBookStore {
  list(tenantId: string, query: ContactQuery): Promise<{ items: ContactRow[]; total: number }>;
  tagCounts(tenantId: string): Promise<{ tag: string; count: number }[]>;
  stats(tenantId: string): Promise<{ total: number; optedOut: number }>;
  findById(tenantId: string, id: string): Promise<ContactRow | null>;
  findByPhone(tenantId: string, phone: string): Promise<ContactRow | null>;
  create(tenantId: string, input: ContactInput, source: string): Promise<ContactRow>;
  update(tenantId: string, id: string, data: { name?: string | null; tags?: string[]; optedOut?: boolean; optedOutAt?: Date | null }): Promise<ContactRow | null>;
  delete(tenantId: string, id: string): Promise<boolean>;
  // جهات اتصال كتير مرة واحدة: الجديد يتضاف، والموجود ياخد التاجز الجديدة (ومايتمسحش منه حاجة)
  upsertMany(tenantId: string, rows: ContactInput[], source: string): Promise<{ created: number; updated: number }>;
  bulkTags(tenantId: string, ids: string[], add: string[], remove: string[]): Promise<number>;
  setOptOut(tenantId: string, phone: string, optedOut: boolean, at: Date): Promise<void>;
  touchInbound(tenantId: string, phone: string, name: string | null, at: Date): Promise<void>;
  // الجمهور: المشتركين اللي عليهم التاجز
  audience(tenantId: string, tags: string[], match: TagMatch): Promise<{ phone: string; name: string }[]>;
  countAudience(tenantId: string, tags: string[], match: TagMatch): Promise<number>;
  optedOutAmong(tenantId: string, phones: string[]): Promise<Set<string>>;
}

const contactSelect = { id: true, phone: true, name: true, tags: true, optedOut: true, optedOutAt: true, source: true, lastInboundAt: true, createdAt: true } as const;

function audienceWhere(tenantId: string, tags: string[], match: TagMatch): Prisma.WhatsappContactWhereInput {
  return { tenantId, optedOut: false, tags: match === "all" ? { hasEvery: tags } : { hasSome: tags } };
}

// الوصول لقاعدة البيانات بس - مفيش منطق هنا
export class PrismaContactBookRepository implements ContactBookStore {
  constructor(private readonly db: PrismaClient) {}

  async list(tenantId: string, query: ContactQuery) {
    const where: Prisma.WhatsappContactWhereInput = { tenantId };
    if (query.status === "subscribed") where.optedOut = false;
    if (query.status === "opted_out") where.optedOut = true;
    if (query.tag) where.tags = { has: query.tag };
    if (query.q) where.OR = [{ name: { contains: query.q, mode: "insensitive" } }, { phone: { contains: query.q.replace(/[^\d]/g, "") || query.q } }];
    const [items, total] = await Promise.all([
      this.db.whatsappContact.findMany({ where, orderBy: [{ lastInboundAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }], skip: query.skip, take: query.take, select: contactSelect }),
      this.db.whatsappContact.count({ where }),
    ]);
    return { items, total };
  }

  async tagCounts(tenantId: string) {
    const rows = await this.db.$queryRaw<{ tag: string; count: number }[]>`
      SELECT t AS "tag", COUNT(*)::int AS "count" FROM "whatsapp_contacts", unnest("tags") AS t
      WHERE "tenantId" = ${tenantId} GROUP BY t ORDER BY COUNT(*) DESC, t ASC LIMIT 200`;
    return rows;
  }

  async stats(tenantId: string) {
    const [total, optedOut] = await Promise.all([this.db.whatsappContact.count({ where: { tenantId } }), this.db.whatsappContact.count({ where: { tenantId, optedOut: true } })]);
    return { total, optedOut };
  }

  findById(tenantId: string, id: string) {
    return this.db.whatsappContact.findFirst({ where: { id, tenantId }, select: contactSelect });
  }

  findByPhone(tenantId: string, phone: string) {
    return this.db.whatsappContact.findUnique({ where: { tenantId_phone: { tenantId, phone } }, select: contactSelect });
  }

  create(tenantId: string, input: ContactInput, source: string) {
    return this.db.whatsappContact.create({ data: { tenantId, phone: input.phone, name: input.name ?? null, tags: input.tags ?? [], source }, select: contactSelect });
  }

  async update(tenantId: string, id: string, data: { name?: string | null; tags?: string[]; optedOut?: boolean; optedOutAt?: Date | null }) {
    const r = await this.db.whatsappContact.updateMany({ where: { id, tenantId }, data });
    return r.count ? this.findById(tenantId, id) : null;
  }

  async delete(tenantId: string, id: string) {
    const r = await this.db.whatsappContact.deleteMany({ where: { id, tenantId } });
    return r.count > 0;
  }

  async upsertMany(tenantId: string, rows: ContactInput[], source: string) {
    if (rows.length === 0) return { created: 0, updated: 0 };
    const phones = rows.map((r) => r.phone);
    const existing = await this.db.whatsappContact.findMany({ where: { tenantId, phone: { in: phones } }, select: { id: true, phone: true, name: true, tags: true } });
    const byPhone = new Map(existing.map((e) => [e.phone, e]));
    const fresh = rows.filter((r) => !byPhone.has(r.phone));
    const created = fresh.length
      ? (await this.db.whatsappContact.createMany({ data: fresh.map((r) => ({ tenantId, phone: r.phone, name: r.name ?? null, tags: r.tags ?? [], source })), skipDuplicates: true })).count
      : 0;
    let updated = 0;
    for (const r of rows) {
      const e = byPhone.get(r.phone);
      if (!e) continue;
      const tags = [...new Set([...e.tags, ...(r.tags ?? [])])];
      const name = e.name || r.name || null;
      if (tags.length === e.tags.length && name === e.name) continue;
      await this.db.whatsappContact.update({ where: { id: e.id }, data: { tags, name } });
      updated++;
    }
    return { created, updated };
  }

  async bulkTags(tenantId: string, ids: string[], add: string[], remove: string[]) {
    const rows = await this.db.whatsappContact.findMany({ where: { tenantId, id: { in: ids } }, select: { id: true, tags: true } });
    for (const r of rows) {
      const tags = [...new Set([...r.tags.filter((t) => !remove.includes(t)), ...add])];
      await this.db.whatsappContact.update({ where: { id: r.id }, data: { tags } });
    }
    return rows.length;
  }

  async setOptOut(tenantId: string, phone: string, optedOut: boolean, at: Date) {
    await this.db.whatsappContact.upsert({
      where: { tenantId_phone: { tenantId, phone } },
      create: { tenantId, phone, optedOut, optedOutAt: optedOut ? at : null, source: "inbound", lastInboundAt: at },
      update: { optedOut, optedOutAt: optedOut ? at : null },
    });
  }

  async touchInbound(tenantId: string, phone: string, name: string | null, at: Date) {
    const existing = await this.findByPhone(tenantId, phone);
    if (existing) {
      await this.db.whatsappContact.update({ where: { id: existing.id }, data: { lastInboundAt: at, ...(name && !existing.name ? { name } : {}) } });
      return;
    }
    await this.db.whatsappContact.create({ data: { tenantId, phone, name, source: "inbound", lastInboundAt: at } }).catch(() => {});
  }

  async audience(tenantId: string, tags: string[], match: TagMatch) {
    const rows = await this.db.whatsappContact.findMany({ where: audienceWhere(tenantId, tags, match), select: { phone: true, name: true }, orderBy: { createdAt: "asc" } });
    return rows.map((r) => ({ phone: r.phone, name: r.name ?? "" }));
  }

  countAudience(tenantId: string, tags: string[], match: TagMatch) {
    return this.db.whatsappContact.count({ where: audienceWhere(tenantId, tags, match) });
  }

  async optedOutAmong(tenantId: string, phones: string[]) {
    if (phones.length === 0) return new Set<string>();
    const rows = await this.db.whatsappContact.findMany({ where: { tenantId, optedOut: true, phone: { in: phones } }, select: { phone: true } });
    return new Set(rows.map((r) => r.phone));
  }
}
