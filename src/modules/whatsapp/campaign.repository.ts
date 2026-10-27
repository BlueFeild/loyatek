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
}

export interface CampaignStore {
  connection(tenantId: string): Promise<MetaConnection | null>;
  findForSend(tenantId: string, id: string): Promise<CampaignForSend | null>;
  setTemplateStatus(templateId: string, status: string, rejectionReason: string | null): Promise<CampaignTemplate>;
  // قفل ذرّي: DRAFT / READY / FAILED ← SENDING. false = حد تاني بيبعتها أو اتبعتت خلاص
  claim(tenantId: string, id: string): Promise<boolean>;
  // لو التحضير فشل بعد القفل (رفع صورة مثلًا) نرجّعها للحالة اللي كانت عليها
  release(id: string, status: string): Promise<void>;
  progress(id: string, sent: number, failed: number): Promise<void>;
  finish(id: string, status: "SENT" | "FAILED", sent: number, failed: number): Promise<void>;
  // حملات فضلت SENDING من غير أي تقدم (السيرفر اتعاد تشغيله) ← FAILED عشان تتبعت تاني
  expireStale(tenantId: string, before: Date, exceptIds: string[]): Promise<number>;
  recordOutgoing(m: OutgoingMessage): Promise<void>;
}

const CLAIMABLE = ["DRAFT", "READY", "FAILED"] as const;

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
      select: { id: true, tenantId: true, kind: true, status: true, audioBase64: true, recipients: true, template: { select: templateFields } },
    });
    if (!c) return null;
    const recipients = Array.isArray(c.recipients) ? (c.recipients as { phone: string; name: string }[]) : [];
    return { ...c, recipients };
  }

  setTemplateStatus(templateId: string, status: string, rejectionReason: string | null) {
    return this.db.whatsappTemplate.update({ where: { id: templateId }, data: { status: status as never, rejectionReason }, select: templateFields });
  }

  async claim(tenantId: string, id: string) {
    const r = await this.db.whatsappCampaign.updateMany({
      where: { id, tenantId, status: { in: [...CLAIMABLE] } },
      data: { status: "SENDING", sentCount: 0, failedCount: 0, sendingAt: new Date() },
    });
    return r.count === 1;
  }

  async release(id: string, status: string) {
    await this.db.whatsappCampaign.updateMany({ where: { id, status: "SENDING" }, data: { status: status as never, sendingAt: null } });
  }

  async progress(id: string, sent: number, failed: number) {
    await this.db.whatsappCampaign.updateMany({ where: { id, status: "SENDING" }, data: { sentCount: sent, failedCount: failed, sendingAt: new Date() } });
  }

  async finish(id: string, status: "SENT" | "FAILED", sent: number, failed: number) {
    await this.db.whatsappCampaign.updateMany({ where: { id }, data: { status, sentCount: sent, failedCount: failed, sendingAt: null } });
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
