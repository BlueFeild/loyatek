import { Prisma, PrismaClient } from "@prisma/client";
import type { FlowDef, FlowInput, FlowNode, FlowSessionState } from "./flow-engine";
import { recordWhatsappMessage, sendWhatsappInteractiveMessage, type InteractiveMessage } from "./whatsapp.service";

// اللي سيناريوهات واتساب محتاجاه من التخزين (Prisma أو نسخة في الذاكرة للاختبار)

export interface FlowRow extends FlowDef {
  startedCount: number;
  completedCount: number;
  responseCount: number;
  updatedAt: Date;
}

export interface FlowResponseRow {
  id: string;
  phone: string;
  name: string | null;
  answers: Record<string, string>;
  completedAt: Date;
}

export interface FlowStore {
  list(tenantId: string): Promise<FlowRow[]>;
  enabled(tenantId: string): Promise<FlowDef[]>;
  get(tenantId: string, id: string): Promise<FlowRow | null>;
  create(tenantId: string, input: FlowInput, sortOrder: number): Promise<string>;
  update(tenantId: string, id: string, input: FlowInput): Promise<boolean>;
  setEnabled(tenantId: string, id: string, enabled: boolean): Promise<boolean>;
  remove(tenantId: string, id: string): Promise<boolean>;
  responses(tenantId: string, flowId: string, limit: number): Promise<FlowResponseRow[]>;
  // المحادثة مع موظف؟ (ساعتها السيناريو مايردش)
  isWithHuman(tenantId: string, phone: string): Promise<boolean>;
  accountActive(tenantId: string): Promise<boolean>;
  session(tenantId: string, phone: string): Promise<FlowSessionState | null>;
  saveSession(tenantId: string, phone: string, s: { flowId: string; nodeId: string; answers: Record<string, string> } | null): Promise<void>;
  countStart(flowId: string): Promise<void>;
  complete(tenantId: string, r: { flowId: string; flowName: string; phone: string; name: string | null; answers: Record<string, string> }): Promise<void>;
  tagContact(tenantId: string, phone: string, tags: string[], name: string | null): Promise<void>;
  handoff(tenantId: string, phone: string, reason: string): Promise<void>;
  vars(tenantId: string): Promise<Record<string, string>>;
}

export interface FlowMessenger {
  connection(tenantId: string): Promise<{ token: string; phoneNumberId: string } | null>;
  send(conn: { token: string; phoneNumberId: string }, to: string, m: InteractiveMessage): Promise<{ ok: boolean; messageId?: string; error?: string }>;
  record(m: { tenantId: string; phone: string; name: string | null; body: string; waMessageId: string | null; ok: boolean; error: string | null }): Promise<void>;
}

const nodesOf = (raw: unknown): FlowNode[] => (Array.isArray(raw) ? (raw as FlowNode[]) : []);

function publicBase() {
  return (process.env.FRONTEND_BASE_URL || "https://digital.blue-field.co").replace(/\/+$/, "");
}

// الوصول لقاعدة البيانات بس - كل حاجة بشركة صاحب الطلب
export class PrismaFlowRepository implements FlowStore {
  constructor(private readonly db: PrismaClient) {}

  private toDef(f: { id: string; name: string; enabled: boolean; keywords: string[]; startNodeId: string; nodes: unknown; sortOrder: number }): FlowDef {
    return { id: f.id, name: f.name, enabled: f.enabled, keywords: f.keywords, startNodeId: f.startNodeId, nodes: nodesOf(f.nodes), sortOrder: f.sortOrder };
  }

  async list(tenantId: string): Promise<FlowRow[]> {
    const [flows, counts] = await Promise.all([
      this.db.whatsappFlow.findMany({ where: { tenantId }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] }),
      this.db.whatsappFlowResponse.groupBy({ by: ["flowId"], where: { tenantId }, _count: { _all: true } }),
    ]);
    const byFlow = new Map(counts.map((c) => [c.flowId, c._count._all]));
    return flows.map((f) => ({ ...this.toDef(f), startedCount: f.startedCount, completedCount: f.completedCount, responseCount: byFlow.get(f.id) ?? 0, updatedAt: f.updatedAt }));
  }

  async enabled(tenantId: string) {
    const flows = await this.db.whatsappFlow.findMany({ where: { tenantId, enabled: true }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] });
    return flows.map((f) => this.toDef(f));
  }

  async get(tenantId: string, id: string) {
    return (await this.list(tenantId)).find((f) => f.id === id) ?? null;
  }

  async create(tenantId: string, input: FlowInput, sortOrder: number) {
    const row = await this.db.whatsappFlow.create({ data: { tenantId, ...input, nodes: input.nodes as unknown as Prisma.InputJsonValue, sortOrder }, select: { id: true } });
    return row.id;
  }

  async update(tenantId: string, id: string, input: FlowInput) {
    const r = await this.db.whatsappFlow.updateMany({ where: { id, tenantId }, data: { ...input, nodes: input.nodes as unknown as Prisma.InputJsonValue } });
    // السيناريو اتغيّر: اللي كانوا واقفين في نصه يبدأوا من جديد
    if (r.count) await this.db.whatsappFlowSession.deleteMany({ where: { tenantId, flowId: id } });
    return r.count > 0;
  }

  async setEnabled(tenantId: string, id: string, enabled: boolean) {
    return (await this.db.whatsappFlow.updateMany({ where: { id, tenantId }, data: { enabled } })).count > 0;
  }

  async remove(tenantId: string, id: string) {
    const r = await this.db.whatsappFlow.deleteMany({ where: { id, tenantId } });
    if (r.count) await this.db.whatsappFlowSession.deleteMany({ where: { tenantId, flowId: id } });
    return r.count > 0;
  }

  async responses(tenantId: string, flowId: string, limit: number) {
    const rows = await this.db.whatsappFlowResponse.findMany({ where: { tenantId, flowId }, orderBy: { completedAt: "desc" }, take: limit });
    return rows.map((r) => ({ id: r.id, phone: r.phone, name: r.name, answers: (r.answers ?? {}) as Record<string, string>, completedAt: r.completedAt }));
  }

  async isWithHuman(tenantId: string, phone: string) {
    const c = await this.db.whatsappConversation.findUnique({ where: { tenantId_phone: { tenantId, phone } }, select: { status: true, aiPausedUntil: true } });
    return Boolean(c && (c.status === "handoff" || (c.aiPausedUntil && c.aiPausedUntil > new Date())));
  }

  async accountActive(tenantId: string) {
    const t = await this.db.tenant.findUnique({ where: { id: tenantId }, select: { accountStatus: true, isPlatformOwner: true } });
    return Boolean(t && (t.isPlatformOwner || t.accountStatus === "ACTIVE"));
  }

  async session(tenantId: string, phone: string) {
    const s = await this.db.whatsappFlowSession.findUnique({ where: { tenantId_phone: { tenantId, phone } } });
    return s ? { flowId: s.flowId, nodeId: s.nodeId, answers: (s.answers ?? {}) as Record<string, string>, updatedAt: s.updatedAt } : null;
  }

  async saveSession(tenantId: string, phone: string, s: { flowId: string; nodeId: string; answers: Record<string, string> } | null) {
    if (!s) {
      await this.db.whatsappFlowSession.deleteMany({ where: { tenantId, phone } });
      return;
    }
    const data = { flowId: s.flowId, nodeId: s.nodeId, answers: s.answers as Prisma.InputJsonValue };
    await this.db.whatsappFlowSession.upsert({ where: { tenantId_phone: { tenantId, phone } }, create: { tenantId, phone, ...data }, update: data });
  }

  async countStart(flowId: string) {
    await this.db.whatsappFlow.updateMany({ where: { id: flowId }, data: { startedCount: { increment: 1 } } });
  }

  async complete(tenantId: string, r: { flowId: string; flowName: string; phone: string; name: string | null; answers: Record<string, string> }) {
    await this.db.whatsappFlow.updateMany({ where: { id: r.flowId, tenantId }, data: { completedCount: { increment: 1 } } });
    if (!Object.keys(r.answers).length) return;
    await this.db.whatsappFlowResponse.create({ data: { tenantId, flowId: r.flowId, flowName: r.flowName, phone: r.phone, name: r.name, answers: r.answers as Prisma.InputJsonValue } });
    // نفس الإجابات كملاحظة على العميل (بتظهر في Team Inbox)
    const text = Object.entries(r.answers)
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n");
    await this.db.whatsappContactNote.create({ data: { tenantId, phone: r.phone, authorName: `Flow: ${r.flowName}`, text: text.slice(0, 2000) } });
  }

  async tagContact(tenantId: string, phone: string, tags: string[], name: string | null) {
    const clean = Array.from(new Set(tags.map((t) => t.trim().toLowerCase()).filter(Boolean)));
    if (!clean.length && !name) return;
    const existing = await this.db.whatsappContact.findUnique({ where: { tenantId_phone: { tenantId, phone } }, select: { tags: true, name: true } });
    const nextTags = Array.from(new Set([...(existing?.tags ?? []), ...clean]));
    await this.db.whatsappContact.upsert({
      where: { tenantId_phone: { tenantId, phone } },
      create: { tenantId, phone, tags: nextTags, name, source: "inbound" },
      update: { tags: nextTags, ...(name ? { name } : {}) },
    });
  }

  async handoff(tenantId: string, phone: string, reason: string) {
    const data = { status: "handoff", handoffReason: reason.slice(0, 300) };
    await this.db.whatsappConversation.upsert({ where: { tenantId_phone: { tenantId, phone } }, create: { tenantId, phone, ...data }, update: data });
  }

  async vars(tenantId: string) {
    const t = await this.db.tenant.findUnique({ where: { id: tenantId }, select: { name: true, slug: true } });
    const base = publicBase();
    return {
      business: t?.name ?? "",
      booking_link: t?.slug ? `${base}/book/${t.slug}` : "",
      menu_link: t?.slug ? `${base}/menu/${t.slug}` : "",
      links_link: t?.slug ? `${base}/l/${t.slug}` : "",
    };
  }
}

// الإرسال الحقيقي (Meta) + التسجيل في Team Inbox كرسالة "flow"
export class MetaFlowMessenger implements FlowMessenger {
  constructor(private readonly db: PrismaClient) {}

  async connection(tenantId: string) {
    const s = await this.db.whatsappSettings.findUnique({ where: { tenantId }, select: { isConnected: true, metaAccessToken: true, metaPhoneNumberId: true } });
    if (!s?.isConnected || !s.metaAccessToken || !s.metaPhoneNumberId) return null;
    return { token: s.metaAccessToken, phoneNumberId: s.metaPhoneNumberId };
  }

  send(conn: { token: string; phoneNumberId: string }, to: string, m: InteractiveMessage) {
    return sendWhatsappInteractiveMessage(conn.token, conn.phoneNumberId, to, m);
  }

  async record(m: { tenantId: string; phone: string; name: string | null; body: string; waMessageId: string | null; ok: boolean; error: string | null }) {
    await recordWhatsappMessage({ tenantId: m.tenantId, direction: "OUT", contactPhone: m.phone, contactName: m.name, body: m.body, kind: "flow", waMessageId: m.waMessageId, status: m.ok ? "sent" : "failed", error: m.error });
  }
}
