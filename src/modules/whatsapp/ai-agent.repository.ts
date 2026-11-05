import { PrismaClient } from "@prisma/client";
import type { AgentBusinessContext, AgentDialect, AgentTurn } from "../ai/agent-types";
import { AGENT_LIMITS } from "../ai/agent-types";
import { formatUsdAs, getRates } from "../../utils/money";
import { recordWhatsappMessage, sendWhatsappTextMessage } from "./whatsapp.service";

// اللي موظف واتساب الذكي + حالة المحادثات محتاجينه من التخزين (Prisma أو نسخة في الذاكرة للاختبار)

export interface AgentSettings {
  enabled: boolean;
  knowledge: string;
  dialect: AgentDialect;
  maxRepliesPerHour: number;
}

export const DEFAULT_AGENT_SETTINGS: AgentSettings = { enabled: false, knowledge: "", dialect: "auto", maxRepliesPerHour: 8 };

export type ConversationStatus = "open" | "handoff" | "closed";

export interface ConversationState {
  phone: string;
  status: ConversationStatus;
  assignedToUserId: string | null;
  handoffReason: string | null;
  aiPausedUntil: Date | null;
  lastInboundAt: Date | null;
}

export interface AiAgentStore {
  settings(tenantId: string): Promise<AgentSettings>;
  saveSettings(tenantId: string, s: AgentSettings): Promise<AgentSettings>;
  // بيانات الشركة اللي الموظف بيرد منها (المنيو + الخدمات + اللينكات بعملة الشركة)
  businessContext(tenantId: string, settings: AgentSettings): Promise<AgentBusinessContext | null>;
  accountActive(tenantId: string): Promise<boolean>;
  history(tenantId: string, phone: string, limit: number): Promise<AgentTurn[]>;
  aiRepliesSince(tenantId: string, phone: string, since: Date): Promise<number>;
  // رسالة جاية: المحادثة تتسجل / تتفتح تاني لو كانت مقفولة
  touchInbound(tenantId: string, phone: string, at: Date): Promise<ConversationState>;
  conversations(tenantId: string, phones: string[]): Promise<Map<string, ConversationState>>;
  updateConversation(tenantId: string, phone: string, data: Partial<Omit<ConversationState, "phone">>): Promise<ConversationState>;
}

export interface AgentMessenger {
  connection(tenantId: string): Promise<{ token: string; phoneNumberId: string } | null>;
  sendText(conn: { token: string; phoneNumberId: string }, to: string, text: string): Promise<{ ok: boolean; messageId?: string; error?: string }>;
  record(m: { tenantId: string; phone: string; name: string | null; body: string; waMessageId: string | null; ok: boolean; error: string | null }): Promise<void>;
}

const stateSelect = { phone: true, status: true, assignedToUserId: true, handoffReason: true, aiPausedUntil: true, lastInboundAt: true } as const;
const asState = (r: { phone: string; status: string; assignedToUserId: string | null; handoffReason: string | null; aiPausedUntil: Date | null; lastInboundAt: Date | null }): ConversationState => ({
  ...r,
  status: r.status === "handoff" || r.status === "closed" ? r.status : "open",
});

function publicBase() {
  return (process.env.FRONTEND_BASE_URL || "https://digital.blue-field.co").replace(/\/+$/, "");
}

// الوصول لقاعدة البيانات بس - مفيش منطق هنا
export class PrismaAiAgentRepository implements AiAgentStore {
  constructor(private readonly db: PrismaClient) {}

  async settings(tenantId: string): Promise<AgentSettings> {
    const s = await this.db.whatsappAiAgent.findUnique({ where: { tenantId } });
    if (!s) return { ...DEFAULT_AGENT_SETTINGS };
    return { enabled: s.enabled, knowledge: s.knowledge, dialect: s.dialect as AgentDialect, maxRepliesPerHour: s.maxRepliesPerHour };
  }

  async saveSettings(tenantId: string, s: AgentSettings) {
    await this.db.whatsappAiAgent.upsert({ where: { tenantId }, create: { tenantId, ...s }, update: s });
    return s;
  }

  async businessContext(tenantId: string, settings: AgentSettings): Promise<AgentBusinessContext | null> {
    const tenant = await this.db.tenant.findUnique({ where: { id: tenantId }, select: { name: true, industry: true, slug: true, displayCurrency: true, subscribedModules: true } });
    if (!tenant) return null;
    const [items, booking, rates] = await Promise.all([
      this.db.menuItem.findMany({
        where: { tenantId, category: { isDemo: false } },
        orderBy: [{ category: { sortOrder: "asc" } }, { sortOrder: "asc" }],
        take: AGENT_LIMITS.maxMenuItems,
        select: { name: true, description: true, price: true, category: { select: { name: true } } },
      }),
      this.db.bookingSettings.findUnique({ where: { tenantId }, select: { services: true, servicePrices: true, openHour: true, closeHour: true } }),
      getRates(),
    ]);
    const currency = tenant.displayCurrency || "USD";
    const prices = (booking?.servicePrices ?? {}) as Record<string, number>;
    const base = publicBase();
    return {
      name: tenant.name,
      industry: String(tenant.industry),
      currency,
      knowledge: settings.knowledge,
      dialect: settings.dialect,
      menu: items.map((i) => ({ name: i.name, price: formatUsdAs(String(i.price), currency, rates), category: i.category.name, description: i.description })),
      services: (booking?.services ?? []).slice(0, AGENT_LIMITS.maxServices).map((name) => ({ name, price: prices[name] ? formatUsdAs(prices[name], currency, rates) : null })),
      bookingHours: booking ? `${booking.openHour}:00 – ${booking.closeHour}:00` : null,
      links: {
        booking: tenant.slug && booking ? `${base}/book/${tenant.slug}` : null,
        menu: tenant.slug && items.length ? `${base}/menu/${tenant.slug}` : null,
        links: tenant.slug ? `${base}/l/${tenant.slug}` : null,
      },
      // المواعيد الفاضية بتتحط من AgentBooker في الخدمة
      booking: null,
    };
  }

  async accountActive(tenantId: string) {
    const t = await this.db.tenant.findUnique({ where: { id: tenantId }, select: { accountStatus: true, isPlatformOwner: true } });
    return Boolean(t && (t.isPlatformOwner || t.accountStatus === "ACTIVE"));
  }

  async history(tenantId: string, phone: string, limit: number): Promise<AgentTurn[]> {
    const rows = await this.db.whatsappMessage.findMany({ where: { tenantId, contactPhone: phone }, orderBy: { createdAt: "desc" }, take: limit, select: { direction: true, body: true } });
    return rows.reverse().map((r) => ({ from: r.direction === "IN" ? "customer" : "business", text: r.body }));
  }

  aiRepliesSince(tenantId: string, phone: string, since: Date) {
    return this.db.whatsappMessage.count({ where: { tenantId, contactPhone: phone, direction: "OUT", kind: "ai", createdAt: { gte: since } } });
  }

  async touchInbound(tenantId: string, phone: string, at: Date) {
    const existing = await this.db.whatsappConversation.findUnique({ where: { tenantId_phone: { tenantId, phone } }, select: stateSelect });
    const row = existing
      ? await this.db.whatsappConversation.update({ where: { tenantId_phone: { tenantId, phone } }, data: { lastInboundAt: at, ...(existing.status === "closed" ? { status: "open" } : {}) }, select: stateSelect })
      : await this.db.whatsappConversation.upsert({ where: { tenantId_phone: { tenantId, phone } }, create: { tenantId, phone, lastInboundAt: at }, update: { lastInboundAt: at }, select: stateSelect });
    return asState(row);
  }

  async conversations(tenantId: string, phones: string[]) {
    const rows = phones.length ? await this.db.whatsappConversation.findMany({ where: { tenantId, phone: { in: phones } }, select: stateSelect }) : [];
    return new Map(rows.map((r) => [r.phone, asState(r)]));
  }

  async updateConversation(tenantId: string, phone: string, data: Partial<Omit<ConversationState, "phone">>) {
    const row = await this.db.whatsappConversation.upsert({ where: { tenantId_phone: { tenantId, phone } }, create: { tenantId, phone, ...data }, update: data, select: stateSelect });
    return asState(row);
  }
}

// الإرسال الحقيقي (Meta) + التسجيل في Team Inbox كرسالة "ai"
export class MetaAgentMessenger implements AgentMessenger {
  constructor(private readonly db: PrismaClient) {}

  async connection(tenantId: string) {
    const s = await this.db.whatsappSettings.findUnique({ where: { tenantId }, select: { isConnected: true, metaAccessToken: true, metaPhoneNumberId: true } });
    if (!s?.isConnected || !s.metaAccessToken || !s.metaPhoneNumberId) return null;
    return { token: s.metaAccessToken, phoneNumberId: s.metaPhoneNumberId };
  }

  sendText(conn: { token: string; phoneNumberId: string }, to: string, text: string) {
    return sendWhatsappTextMessage(conn.token, conn.phoneNumberId, to, text);
  }

  async record(m: { tenantId: string; phone: string; name: string | null; body: string; waMessageId: string | null; ok: boolean; error: string | null }) {
    await recordWhatsappMessage({ tenantId: m.tenantId, direction: "OUT", contactPhone: m.phone, contactName: m.name, body: m.body, kind: "ai", waMessageId: m.waMessageId, status: m.ok ? "sent" : "failed", error: m.error });
  }
}
