import { PrismaClient } from "@prisma/client";

// مفاتيح الـ API والـ webhooks - Prisma بس، كل حاجة بشركة صاحب الطلب

export interface ApiKeyView {
  id: string;
  name: string;
  prefix: string;
  lastUsedAt: Date | null;
  createdAt: Date;
}

export interface WebhookRow {
  id: string;
  tenantId: string;
  url: string;
  events: string[];
  secret: string; // متشفّر
  enabled: boolean;
  lastStatus: number | null;
  lastError: string | null;
  lastDeliveredAt: Date | null;
  failCount: number;
  createdAt: Date;
}

export interface IntegrationsStore {
  createKey(k: { tenantId: string; name: string; prefix: string; keyHash: string; createdById: string | null }): Promise<ApiKeyView>;
  listKeys(tenantId: string): Promise<ApiKeyView[]>;
  revokeKey(tenantId: string, id: string, at: Date): Promise<boolean>;
  keyByHash(hash: string): Promise<{ id: string; tenantId: string; revokedAt: Date | null; lastUsedAt: Date | null } | null>;
  touchKey(id: string, at: Date): Promise<void>;
  countKeys(tenantId: string): Promise<number>;

  createWebhook(w: { tenantId: string; url: string; events: string[]; secret: string }): Promise<WebhookRow>;
  listWebhooks(tenantId: string): Promise<WebhookRow[]>;
  webhook(tenantId: string, id: string): Promise<WebhookRow | null>;
  updateWebhook(tenantId: string, id: string, patch: { url?: string; events?: string[]; enabled?: boolean; secret?: string }): Promise<boolean>;
  deleteWebhook(tenantId: string, id: string): Promise<boolean>;
  // الـ webhooks الشغالة اللي مستنية الحدث ده
  subscribers(tenantId: string, event: string): Promise<WebhookRow[]>;
  recordDelivery(id: string, r: { ok: boolean; status: number | null; error: string | null; at: Date; disableAfter: number }): Promise<void>;
}

const keySelect = { id: true, name: true, prefix: true, lastUsedAt: true, createdAt: true } as const;

export class PrismaIntegrationsRepository implements IntegrationsStore {
  constructor(private readonly db: PrismaClient) {}

  createKey(k: { tenantId: string; name: string; prefix: string; keyHash: string; createdById: string | null }) {
    return this.db.apiKey.create({ data: k, select: keySelect });
  }

  listKeys(tenantId: string) {
    return this.db.apiKey.findMany({ where: { tenantId, revokedAt: null }, select: keySelect, orderBy: { createdAt: "desc" } });
  }

  async revokeKey(tenantId: string, id: string, at: Date) {
    return (await this.db.apiKey.updateMany({ where: { id, tenantId, revokedAt: null }, data: { revokedAt: at } })).count > 0;
  }

  keyByHash(hash: string) {
    return this.db.apiKey.findUnique({ where: { keyHash: hash }, select: { id: true, tenantId: true, revokedAt: true, lastUsedAt: true } });
  }

  async touchKey(id: string, at: Date) {
    await this.db.apiKey.update({ where: { id }, data: { lastUsedAt: at } });
  }

  countKeys(tenantId: string) {
    return this.db.apiKey.count({ where: { tenantId, revokedAt: null } });
  }

  createWebhook(w: { tenantId: string; url: string; events: string[]; secret: string }) {
    return this.db.webhookEndpoint.create({ data: w });
  }

  listWebhooks(tenantId: string) {
    return this.db.webhookEndpoint.findMany({ where: { tenantId }, orderBy: { createdAt: "asc" } });
  }

  webhook(tenantId: string, id: string) {
    return this.db.webhookEndpoint.findFirst({ where: { id, tenantId } });
  }

  async updateWebhook(tenantId: string, id: string, patch: { url?: string; events?: string[]; enabled?: boolean; secret?: string }) {
    // اتفعّل تاني = نبدأ عدّ الأخطاء من الأول
    const data = patch.enabled ? { ...patch, failCount: 0 } : patch;
    return (await this.db.webhookEndpoint.updateMany({ where: { id, tenantId }, data })).count > 0;
  }

  async deleteWebhook(tenantId: string, id: string) {
    return (await this.db.webhookEndpoint.deleteMany({ where: { id, tenantId } })).count > 0;
  }

  subscribers(tenantId: string, event: string) {
    return this.db.webhookEndpoint.findMany({ where: { tenantId, enabled: true, events: { has: event } } });
  }

  async recordDelivery(id: string, r: { ok: boolean; status: number | null; error: string | null; at: Date; disableAfter: number }) {
    if (r.ok) {
      await this.db.webhookEndpoint.updateMany({ where: { id }, data: { lastStatus: r.status, lastError: null, lastDeliveredAt: r.at, failCount: 0 } });
      return;
    }
    const row = await this.db.webhookEndpoint.update({ where: { id }, data: { lastStatus: r.status, lastError: r.error?.slice(0, 300) ?? null, failCount: { increment: 1 } }, select: { failCount: true } });
    // لينك بايظ بقاله كتير = نوقفه (التاجر يشوف السبب ويشغّله تاني)
    if (row.failCount >= r.disableAfter) await this.db.webhookEndpoint.updateMany({ where: { id }, data: { enabled: false } });
  }
}
