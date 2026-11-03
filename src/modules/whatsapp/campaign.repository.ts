import { PrismaClient } from "@prisma/client";
import { recordWhatsappMessage } from "./whatsapp.service";

// اللي خدمة إرسال الحملات محتاجاه من التخزين (Prisma أو نسخة في الذاكرة للاختبار)

export interface MetaConnection {
  token: string;
  phoneNumberId: string;
}

export interface CampaignTemplate {
  id: string;
  name: string;
  language: string;
  status: string;
  metaTemplateId: string | null;
  bodyText: string;
  format: string | null;
  headerImageDataUrl: string | null;
  cards: unknown;
}

export interface CampaignForSend {
  id: string;
  tenantId: string;
  kind: "TEXT" | "VOICE";
  status: string;
  audioBase64: string | null;
  recipients: { phone: string; name: string }[];
  // فاضي = قايمة الإكسل. غير كده = المشتركين في دفتر جهات الاتصال اللي عليهم التاجز دي
  audienceTags: string[];
  audienceMatch: "any" | "all";
  template: CampaignTemplate | null;
}

export interface OutgoingMessage {
  tenantId: string;
  contactPhone: string;
  contactName: string | null;
  body: string;
  waMessageId: string | null;
  ok: boolean;
  error: string | null;
  campaignId?: string | null;
}

export interface CampaignStore {
  connection(tenantId: string): Promise<MetaConnection | null>;
  findForSend(tenantId: string, id: string): Promise<CampaignForSend | null>;
  setTemplateStatus(templateId: string, status: string, rejectionReason: string | null): Promise<CampaignTemplate>;
  // قفل ذرّي: DRAFT / READY / SCHEDULED / FAILED ← SENDING. false = حد تاني بيبعتها أو اتبعتت خلاص
  claim(tenantId: string, id: string): Promise<boolean>;
  // الجمهور من دفتر جهات الاتصال (المشتركين بس) + مين في القايمة ألغى الاشتراك
  audience(tenantId: string, tags: string[], match: "any" | "all"): Promise<{ phone: string; name: string }[]>;
  optedOutAmong(tenantId: string, phones: string[]): Promise<Set<string>>;
  // جدولة: DRAFT / READY / FAILED / SCHEDULED ← SCHEDULED بميعاد. false = بتتبعت أو اتبعتت
  schedule(tenantId: string, id: string, at: Date): Promise<boolean>;
  unschedule(tenantId: string, id: string): Promise<boolean>;
  dueScheduled(now: Date, limit: number): Promise<{ id: string; tenantId: string }[]>;
  // حملة مجدولة ماقدرتش تتبعت في ميعادها (القالب اترفض مثلًا) ← FAILED مع السبب
  markFailed(id: string, error: string): Promise<void>;
  // لو التحضير فشل بعد القفل (رفع صورة مثلًا) نرجّعها للحالة اللي كانت عليها
  release(id: string, status: string): Promise<void>;
  progress(id: string, sent: number, failed: number): Promise<void>;
  finish(id: string, status: "SENT" | "FAILED", sent: number, failed: number, skipped?: number): Promise<void>;
  // حملات فضلت SENDING من غير أي تقدم (السيرفر اتعاد تشغيله) ← FAILED عشان تتبعت تاني
  expireStale(tenantId: string, before: Date, exceptIds: string[]): Promise<number>;
  recordOutgoing(m: OutgoingMessage): Promise<void>;
}

const CLAIMABLE = ["DRAFT", "READY", "SCHEDULED", "FAILED"] as const;
const SCHEDULABLE = ["DRAFT", "READY", "FAILED", "SCHEDULED"] as const;

// الوصول لقاعدة البيانات بس - مفيش منطق هنا
export class PrismaCampaignRepository implements CampaignStore {
  constructor(private readonly db: PrismaClient) {}

  async connection(tenantId: string) {
    const s = await this.db.whatsappSettings.findUnique({ where: { tenantId }, select: { isConnected: true, metaAccessToken: true, metaPhoneNumberId: true } });
    if (!s?.isConnected || !s.metaAccessToken || !s.metaPhoneNumberId) return null;
    return { token: s.metaAccessToken, phoneNumberId: s.metaPhoneNumberId };
  }

  async findForSend(tenantId: string, id: string): Promise<CampaignForSend | null> {
    const c = await this.db.whatsappCampaign.findFirst({
      where: { id, tenantId },
      select: { id: true, tenantId: true, kind: true, status: true, audioBase64: true, recipients: true, audienceTags: true, audienceMatch: true, template: { select: templateFields } },
    });
    if (!c) return null;
    const recipients = Array.isArray(c.recipients) ? (c.recipients as { phone: string; name: string }[]) : [];
    return { ...c, recipients, audienceMatch: c.audienceMatch === "all" ? "all" : "any" };
  }

  setTemplateStatus(templateId: string, status: string, rejectionReason: string | null) {
    return this.db.whatsappTemplate.update({ where: { id: templateId }, data: { status: status as never, rejectionReason }, select: templateFields });
  }

  async claim(tenantId: string, id: string) {
    const r = await this.db.whatsappCampaign.updateMany({
      where: { id, tenantId, status: { in: [...CLAIMABLE] } },
      data: { status: "SENDING", sentCount: 0, failedCount: 0, skippedCount: 0, sendingAt: new Date(), lastError: null },
    });
    return r.count === 1;
  }

  async audience(tenantId: string, tags: string[], match: "any" | "all") {
    const rows = await this.db.whatsappContact.findMany({
      where: { tenantId, optedOut: false, tags: match === "all" ? { hasEvery: tags } : { hasSome: tags } },
      select: { phone: true, name: true },
      orderBy: { createdAt: "asc" },
    });
    return rows.map((r) => ({ phone: r.phone, name: r.name ?? "" }));
  }

  async optedOutAmong(tenantId: string, phones: string[]) {
    if (phones.length === 0) return new Set<string>();
    const rows = await this.db.whatsappContact.findMany({ where: { tenantId, optedOut: true, phone: { in: phones } }, select: { phone: true } });
    return new Set(rows.map((r) => r.phone));
  }

  async schedule(tenantId: string, id: string, at: Date) {
    const r = await this.db.whatsappCampaign.updateMany({ where: { id, tenantId, status: { in: [...SCHEDULABLE] } }, data: { status: "SCHEDULED", scheduledAt: at, lastError: null } });
    return r.count === 1;
  }

  async unschedule(tenantId: string, id: string) {
    const r = await this.db.whatsappCampaign.updateMany({ where: { id, tenantId, status: "SCHEDULED" }, data: { status: "DRAFT", scheduledAt: null } });
    return r.count === 1;
  }

  dueScheduled(now: Date, limit: number) {
    return this.db.whatsappCampaign.findMany({ where: { status: "SCHEDULED", scheduledAt: { lte: now } }, orderBy: { scheduledAt: "asc" }, take: limit, select: { id: true, tenantId: true } });
  }

  async markFailed(id: string, error: string) {
    await this.db.whatsappCampaign.updateMany({ where: { id, status: { in: ["SCHEDULED", "SENDING"] } }, data: { status: "FAILED", lastError: error.slice(0, 1000), sendingAt: null } });
  }

  async release(id: string, status: string) {
    await this.db.whatsappCampaign.updateMany({ where: { id, status: "SENDING" }, data: { status: status as never, sendingAt: null } });
  }

  async progress(id: string, sent: number, failed: number) {
    await this.db.whatsappCampaign.updateMany({ where: { id, status: "SENDING" }, data: { sentCount: sent, failedCount: failed, sendingAt: new Date() } });
  }

  async finish(id: string, status: "SENT" | "FAILED", sent: number, failed: number, skipped = 0) {
    await this.db.whatsappCampaign.updateMany({ where: { id }, data: { status, sentCount: sent, failedCount: failed, skippedCount: skipped, sendingAt: null } });
  }

  async expireStale(tenantId: string, before: Date, exceptIds: string[]) {
    const r = await this.db.whatsappCampaign.updateMany({
      where: { tenantId, status: "SENDING", OR: [{ sendingAt: null }, { sendingAt: { lt: before } }], id: { notIn: exceptIds } },
      data: { status: "FAILED", sendingAt: null },
    });
    return r.count;
  }

  async recordOutgoing(m: OutgoingMessage) {
    await recordWhatsappMessage({
      tenantId: m.tenantId,
      direction: "OUT",
      contactPhone: m.contactPhone,
      contactName: m.contactName,
      body: m.body,
      kind: "campaign",
      waMessageId: m.waMessageId,
      status: m.ok ? "sent" : "failed",
      error: m.error,
      campaignId: m.campaignId ?? null,
    });
  }
}

const templateFields = {
  id: true,
  name: true,
  language: true,
  status: true,
  metaTemplateId: true,
  bodyText: true,
  format: true,
  headerImageDataUrl: true,
  cards: true,
} as const;
