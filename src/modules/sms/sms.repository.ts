import { Prisma } from "@prisma/client";
import { prisma } from "../../config/db";
import type { Recipient } from "./sms-text";

// كل كلام قاعدة البيانات لخدمة الـ SMS هنا بس (الخدمة بتكلّم الواجهة SmsStore)
export type CreditReason = "GRANT" | "SEND" | "REFUND" | "SUBSCRIPTION" | "TRIAL";
export interface LedgerEntry {
  reason: CreditReason;
  refId?: string | null;
  note?: string | null;
  userId?: string | null;
}
export interface SmsAccount {
  balance: number;
  senderName: string | null;
  unlimited: boolean;
}
export type CampaignStatus = "DRAFT" | "SCHEDULED" | "SENDING" | "SENT" | "FAILED";
export interface CampaignRow {
  id: string;
  tenantId: string;
  name: string;
  body: string;
  audienceTags: string[];
  audienceMatch: string;
  recipients: unknown;
  status: string;
  scheduledAt: Date | null;
  sendingAt: Date | null;
  sentAt: Date | null;
  total: number;
  sentCount: number;
  failedCount: number;
  segmentsUsed: number;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}
export interface CampaignInput {
  name: string;
  body: string;
  audienceTags: string[];
  audienceMatch: "any" | "all";
  recipients: Recipient[] | null;
}
export interface MessageInput {
  id?: string;
  tenantId: string;
  campaignId?: string | null;
  to: string;
  body: string;
  segments: number;
  status: string;
  provider?: string | null;
  providerId?: string | null;
  error?: string | null;
}

export interface SmsStore {
  account(tenantId: string): Promise<SmsAccount>;
  tenantExists(tenantId: string): Promise<boolean>;
  setSenderName(tenantId: string, senderName: string | null): Promise<void>;
  // خصم ذرّي (balance >= n). الشركات المجانية (صاحب المنصة): مفيش خصم بس الحركة بتتسجل
  spend(tenantId: string, n: number, entry: LedgerEntry): Promise<boolean>;
  // إضافة (أو خصم من السوبر أدمن). null = الرصيد كان هيبقى بالسالب
  adjust(tenantId: string, amount: number, entry: LedgerEntry): Promise<number | null>;
  transactions(tenantId: string, take: number): Promise<unknown[]>;

  createMessage(m: MessageInput): Promise<{ id: string }>;
  updateMessage(id: string, data: Partial<MessageInput>): Promise<void>;
  listMessages(tenantId: string, q: { status?: string; campaignId?: string; page: number; pageSize: number }): Promise<{ items: unknown[]; total: number }>;
  monthUsage(tenantId: string, since: Date): Promise<{ messages: number; segments: number }>;
  campaignMessages(tenantId: string, campaignId: string, take: number): Promise<unknown[]>;
  sentPhonesForCampaign(campaignId: string): Promise<Set<string>>;
  sentSegmentsForCampaign(campaignId: string): Promise<number>;

  listCampaigns(tenantId: string): Promise<CampaignRow[]>;
  getCampaign(tenantId: string, id: string): Promise<CampaignRow | null>;
  createCampaign(tenantId: string, input: CampaignInput): Promise<CampaignRow>;
  updateDraft(tenantId: string, id: string, input: Partial<CampaignInput>): Promise<boolean>;
  deleteDraft(tenantId: string, id: string): Promise<boolean>;
  claim(tenantId: string, id: string, from: CampaignStatus[]): Promise<boolean>;
  release(id: string, status: CampaignStatus, lastError?: string | null): Promise<void>;
  startSending(id: string, data: { total: number; segmentsUsed: number }): Promise<void>;
  progress(id: string, data: { sentCount: number; failedCount: number }): Promise<void>;
  finish(id: string, data: { status: CampaignStatus; sentCount: number; failedCount: number; segmentsUsed: number; lastError: string | null }): Promise<void>;
  schedule(tenantId: string, id: string, at: Date): Promise<boolean>;
  unschedule(tenantId: string, id: string): Promise<boolean>;
  dueCampaigns(now: Date, take: number): Promise<{ id: string; tenantId: string }[]>;
  staleSending(before: Date): Promise<CampaignRow[]>;

  audienceByTags(tenantId: string, tags: string[], match: "any" | "all"): Promise<{ recipients: Recipient[]; optedOut: number }>;
  optedOutPhones(tenantId: string, phones: string[]): Promise<Set<string>>;
  tagCounts(tenantId: string): Promise<{ tags: { tag: string; count: number }[]; contacts: number; optedOut: number }>;
}

export class PrismaSmsStore implements SmsStore {
  private async ensureSettings(tenantId: string) {
    try {
      await prisma.smsSettings.upsert({ where: { tenantId }, create: { tenantId }, update: {} });
    } catch (err) {
      // طلبين أول مرة في نفس اللحظة: التاني بيلاقي الصف موجود
      if ((err as { code?: string }).code !== "P2002") throw err;
    }
  }

  private async unlimited(tenantId: string) {
    const t = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { isPlatformOwner: true } });
    return !!t?.isPlatformOwner;
  }

  async account(tenantId: string): Promise<SmsAccount> {
    const [s, unlimited] = await Promise.all([prisma.smsSettings.findUnique({ where: { tenantId } }), this.unlimited(tenantId)]);
    return { balance: s?.balance ?? 0, senderName: s?.senderName ?? null, unlimited };
  }

  async tenantExists(tenantId: string) {
    return !!(await prisma.tenant.findUnique({ where: { id: tenantId }, select: { id: true } }));
  }

  async setSenderName(tenantId: string, senderName: string | null) {
    await prisma.smsSettings.upsert({ where: { tenantId }, create: { tenantId, senderName }, update: { senderName } });
  }

  async spend(tenantId: string, n: number, entry: LedgerEntry) {
    if (n <= 0) return true;
    const unlimited = await this.unlimited(tenantId);
    if (!unlimited) await this.ensureSettings(tenantId);
    return prisma.$transaction(async (tx) => {
      if (!unlimited) {
        const r = await tx.smsSettings.updateMany({ where: { tenantId, balance: { gte: n } }, data: { balance: { decrement: n } } });
        if (r.count === 0) return false;
      }
      await tx.smsCreditTransaction.create({
        data: { tenantId, amount: -n, reason: entry.reason, refId: entry.refId ?? null, note: entry.note ?? (unlimited ? "Unlimited plan" : null), createdById: entry.userId ?? null },
      });
      return true;
    });
  }

  async adjust(tenantId: string, amount: number, entry: LedgerEntry) {
    const unlimited = await this.unlimited(tenantId);
    await this.ensureSettings(tenantId);
    return prisma.$transaction(async (tx) => {
      // الشركات المجانية: الاسترجاع مابيغيرش رصيد (ماكانش اتخصم)، بس الإضافة من السوبر أدمن بتتحسب
      const touchBalance = !(unlimited && entry.reason === "REFUND");
      if (touchBalance) {
        const where = amount < 0 ? { tenantId, balance: { gte: -amount } } : { tenantId };
        const r = await tx.smsSettings.updateMany({ where, data: { balance: { increment: amount } } });
        if (r.count === 0) return null;
      }
      await tx.smsCreditTransaction.create({
        data: { tenantId, amount, reason: entry.reason, refId: entry.refId ?? null, note: entry.note ?? null, createdById: entry.userId ?? null },
      });
      const s = await tx.smsSettings.findUnique({ where: { tenantId }, select: { balance: true } });
      return s?.balance ?? 0;
    });
  }

  transactions(tenantId: string, take: number) {
    return prisma.smsCreditTransaction.findMany({
      where: { tenantId },
      orderBy: { createdAt: "desc" },
      take,
      select: { id: true, amount: true, reason: true, note: true, refId: true, createdAt: true },
    });
  }

  async createMessage(m: MessageInput) {
    return prisma.smsMessage.create({ data: m, select: { id: true } });
  }

  async updateMessage(id: string, data: Partial<MessageInput>) {
    await prisma.smsMessage.update({ where: { id }, data });
  }

  async listMessages(tenantId: string, q: { status?: string; campaignId?: string; page: number; pageSize: number }) {
    const where = { tenantId, ...(q.status ? { status: q.status } : {}), ...(q.campaignId ? { campaignId: q.campaignId } : {}) };
    const [items, total] = await Promise.all([
      prisma.smsMessage.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        select: { id: true, campaignId: true, to: true, body: true, segments: true, status: true, error: true, createdAt: true },
      }),
      prisma.smsMessage.count({ where }),
    ]);
    return { items, total };
  }

  async monthUsage(tenantId: string, since: Date) {
    const r = await prisma.smsMessage.aggregate({
      where: { tenantId, createdAt: { gte: since }, status: { in: ["SENT", "DELIVERED"] } },
      _count: { _all: true },
      _sum: { segments: true },
    });
    return { messages: r._count._all, segments: r._sum.segments ?? 0 };
  }

  campaignMessages(tenantId: string, campaignId: string, take: number) {
    return prisma.smsMessage.findMany({
      where: { tenantId, campaignId },
      orderBy: { createdAt: "asc" },
      take,
      select: { id: true, to: true, segments: true, status: true, error: true, createdAt: true },
    });
  }

  async sentPhonesForCampaign(campaignId: string) {
    const rows = await prisma.smsMessage.findMany({ where: { campaignId, status: { in: ["SENT", "DELIVERED"] } }, select: { to: true } });
    return new Set(rows.map((r) => r.to));
  }

  async sentSegmentsForCampaign(campaignId: string) {
    const r = await prisma.smsMessage.aggregate({ where: { campaignId, status: { in: ["SENT", "DELIVERED"] } }, _sum: { segments: true } });
    return r._sum.segments ?? 0;
  }

  listCampaigns(tenantId: string) {
    return prisma.smsCampaign.findMany({ where: { tenantId }, orderBy: { createdAt: "desc" }, take: 200 }) as Promise<CampaignRow[]>;
  }

  getCampaign(tenantId: string, id: string) {
    return prisma.smsCampaign.findFirst({ where: { id, tenantId } }) as Promise<CampaignRow | null>;
  }

  createCampaign(tenantId: string, input: CampaignInput) {
    return prisma.smsCampaign.create({
      data: { tenantId, name: input.name, body: input.body, audienceTags: input.audienceTags, audienceMatch: input.audienceMatch, recipients: (input.recipients ?? undefined) as never },
    }) as Promise<CampaignRow>;
  }

  async updateDraft(tenantId: string, id: string, input: Partial<CampaignInput>) {
    const data: Record<string, unknown> = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.body !== undefined) data.body = input.body;
    if (input.audienceTags !== undefined) data.audienceTags = input.audienceTags;
    if (input.audienceMatch !== undefined) data.audienceMatch = input.audienceMatch;
    if (input.recipients !== undefined) data.recipients = input.recipients === null ? Prisma.DbNull : input.recipients;
    const r = await prisma.smsCampaign.updateMany({ where: { id, tenantId, status: "DRAFT" }, data });
    return r.count > 0;
  }

  async deleteDraft(tenantId: string, id: string) {
    const r = await prisma.smsCampaign.deleteMany({ where: { id, tenantId, status: "DRAFT" } });
    return r.count > 0;
  }

  async claim(tenantId: string, id: string, from: CampaignStatus[]) {
    const r = await prisma.smsCampaign.updateMany({
      where: { id, tenantId, status: { in: from } },
      data: { status: "SENDING", sendingAt: new Date(), lastError: null },
    });
    return r.count > 0;
  }

  async release(id: string, status: CampaignStatus, lastError: string | null = null) {
    await prisma.smsCampaign.update({ where: { id }, data: { status, lastError, sendingAt: null } });
  }

  async startSending(id: string, data: { total: number; segmentsUsed: number }) {
    await prisma.smsCampaign.update({ where: { id }, data: { ...data, sentCount: 0, failedCount: 0, sendingAt: new Date() } });
  }

  async progress(id: string, data: { sentCount: number; failedCount: number }) {
    await prisma.smsCampaign.update({ where: { id }, data: { ...data, sendingAt: new Date() } });
  }

  async finish(id: string, data: { status: CampaignStatus; sentCount: number; failedCount: number; segmentsUsed: number; lastError: string | null }) {
    await prisma.smsCampaign.update({ where: { id }, data: { ...data, sentAt: new Date(), sendingAt: null } });
  }

  async schedule(tenantId: string, id: string, at: Date) {
    const r = await prisma.smsCampaign.updateMany({ where: { id, tenantId, status: { in: ["DRAFT", "FAILED", "SCHEDULED"] } }, data: { status: "SCHEDULED", scheduledAt: at, lastError: null } });
    return r.count > 0;
  }

  async unschedule(tenantId: string, id: string) {
    const r = await prisma.smsCampaign.updateMany({ where: { id, tenantId, status: "SCHEDULED" }, data: { status: "DRAFT", scheduledAt: null } });
    return r.count > 0;
  }

  dueCampaigns(now: Date, take: number) {
    return prisma.smsCampaign.findMany({ where: { status: "SCHEDULED", scheduledAt: { lte: now } }, orderBy: { scheduledAt: "asc" }, take, select: { id: true, tenantId: true } });
  }

  staleSending(before: Date) {
    return prisma.smsCampaign.findMany({ where: { status: "SENDING", sendingAt: { lt: before } }, take: 20 }) as Promise<CampaignRow[]>;
  }

  async audienceByTags(tenantId: string, tags: string[], match: "any" | "all") {
    if (tags.length === 0) return { recipients: [], optedOut: 0 };
    const tagFilter = match === "all" ? { hasEvery: tags } : { hasSome: tags };
    const [rows, optedOut] = await Promise.all([
      prisma.whatsappContact.findMany({
        where: { tenantId, optedOut: false, tags: tagFilter },
        select: { phone: true, name: true },
        orderBy: { createdAt: "asc" },
        take: 20000,
      }),
      prisma.whatsappContact.count({ where: { tenantId, optedOut: true, tags: tagFilter } }),
    ]);
    return { recipients: rows.map((r) => ({ phone: r.phone, name: r.name ?? "" })), optedOut };
  }

  async optedOutPhones(tenantId: string, phones: string[]) {
    if (phones.length === 0) return new Set<string>();
    const rows = await prisma.whatsappContact.findMany({ where: { tenantId, optedOut: true, phone: { in: phones } }, select: { phone: true } });
    return new Set(rows.map((r) => r.phone));
  }

  async tagCounts(tenantId: string) {
    const [rows, contacts, optedOut] = await Promise.all([
      prisma.$queryRaw<{ tag: string; count: bigint }[]>`
        SELECT t AS tag, COUNT(*)::bigint AS count
        FROM whatsapp_contacts, unnest(tags) AS t
        WHERE "tenantId" = ${tenantId} AND "optedOut" = false
        GROUP BY t ORDER BY count DESC, t ASC LIMIT 100`,
      prisma.whatsappContact.count({ where: { tenantId, optedOut: false } }),
      prisma.whatsappContact.count({ where: { tenantId, optedOut: true } }),
    ]);
    return { tags: rows.map((r) => ({ tag: r.tag, count: Number(r.count) })), contacts, optedOut };
  }
}
